const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const axios = require('axios');
const { retry, logger } = require('./utils');

// 创建Notion客户端实例
const notion = new Client({ 
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 30000
});

// 基础延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 重试配置
const retryConfig = {
  retries: 3,
  minTimeout: 2000,
  maxTimeout: 10000,
  onRetry: (error, attempt) => {
    logger.warn(`Retry attempt ${attempt} due to error: ${error.message}`);
  }
};

// 优化的媒体下载函数
async function downloadMedia(url) {
  logger.info(`Downloading media from: ${url}`);
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024, // 10MB限制
      validateStatus: status => status === 200
    });
    return response.data;
  } catch (err) {
    logger.error('Media download failed:', {
      url,
      error: err.message,
      code: err.code
    });
    throw err;
  }
}

// 优化的媒体上传函数
async function uploadMedia(url) {
  try {
    const buffer = await retry(() => downloadMedia(url), retryConfig);
    
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty media content');
    }
    
    logger.info(`Uploading media to WeChat, size: ${buffer.length} bytes`);
    const result = await retry(() => 
      cloud.uploadFile({
        cloudPath: `covers/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`,
        fileContent: buffer
      }),
      retryConfig
    );
    
    logger.info(`Media upload completed: ${result.fileID}`);
    return result.fileID;
  } catch (err) {
    logger.error('Media upload failed:', err);
    // 返回默认图片ID而不是抛出错误
    return process.env.DEFAULT_THUMB_MEDIA_ID || '';
  }
}

// 分页获取blocks
async function getAllBlocks(blockId) {
  let blocks = [];
  let cursor;
  
  try {
    do {
      const response = await retry(() => 
        notion.blocks.children.list({
          block_id: blockId,
          page_size: 50,
          start_cursor: cursor
        }),
        retryConfig
      );
      
      blocks = blocks.concat(response.results);
      cursor = response.next_cursor;
      
      if (cursor) {
        await delay(500);
      }
    } while (cursor);
    
    return blocks;
  } catch (err) {
    logger.error(`Failed to get blocks for ${blockId}:`, err);
    throw err;
  }
}

// 转换块内容为HTML
async function blockToHtml(block) {
  try {
    let html = '';
    
    switch(block.type) {
      case 'paragraph':
        html = `<p>${await richTextToHtml(block.paragraph.rich_text)}</p>`;
        break;
      case 'heading_1':
        html = `<h1>${await richTextToHtml(block.heading_1.rich_text)}</h1>`;
        break;
      case 'heading_2':
        html = `<h2>${await richTextToHtml(block.heading_2.rich_text)}</h2>`;
        break;
      case 'heading_3':
        html = `<h3>${await richTextToHtml(block.heading_3.rich_text)}</h3>`;
        break;
      case 'bulleted_list_item':
        html = `<li>${await richTextToHtml(block.bulleted_list_item.rich_text)}</li>`;
        break;
      case 'numbered_list_item':
        html = `<li>${await richTextToHtml(block.numbered_list_item.rich_text)}</li>`;
        break;
      case 'code':
        html = `<pre><code>${await richTextToHtml(block.code.rich_text)}</code></pre>`;
        break;
      case 'image':
        try {
          const imageUrl = block.image.type === 'external' 
            ? block.image.external.url 
            : block.image.file.url;
          const wxUrl = await uploadMedia(imageUrl);
          html = `<img src="${wxUrl}" style="max-width:100%"/>`;
        } catch (err) {
          logger.error('Failed to process image:', err);
          html = ''; // 跳过失败的图片
        }
        break;
      case 'quote':
        html = `<blockquote>${await richTextToHtml(block.quote.rich_text)}</blockquote>`;
        break;
      case 'divider':
        html = '<hr/>';
        break;
      default:
        html = '';
    }
    
    return html;
  } catch (err) {
    logger.error(`Failed to convert block to HTML:`, {
      blockType: block.type,
      error: err.message
    });
    return ''; // 返回空字符串而不是抛出错误
  }
}

// 转换富文本为HTML
async function richTextToHtml(richText) {
  if (!richText || richText.length === 0) return '';
  
  try {
    return richText.map(text => {
      let content = text.plain_text;
      
      if (text.annotations.bold) content = `<strong>${content}</strong>`;
      if (text.annotations.italic) content = `<em>${content}</em>`;
      if (text.annotations.strikethrough) content = `<del>${content}</del>`;
      if (text.annotations.underline) content = `<u>${content}</u>`;
      if (text.annotations.code) content = `<code>${content}</code>`;
      
      if (text.href) {
        content = `<a href="${text.href}" target="_blank">${content}</a>`;
      }
      
      return content;
    }).join('');
  } catch (err) {
    logger.error('Failed to convert rich text:', err);
    return '';
  }
}

// 转换内容
async function convertContent(blocks) {
  let html = '';
  let inList = false;
  
  try {
    for (const block of blocks) {
      if ((block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') && !inList) {
        html += block.type === 'bulleted_list_item' ? '<ul>' : '<ol>';
        inList = true;
      } else if (inList && block.type !== 'bulleted_list_item' && block.type !== 'numbered_list_item') {
        html += inList ? (html.endsWith('</li>') ? '</ul>' : '') : '';
        inList = false;
      }
      
      html += await blockToHtml(block);
      
      if (inList && !blocks[blocks.indexOf(block) + 1]?.type?.includes('list_item')) {
        html += '</ul>';
        inList = false;
      }
      
      await delay(100); // 添加小延迟避免处理过快
    }
    
    return html;
  } catch (err) {
    logger.error('Content conversion failed:', err);
    throw err;
  }
}

// 主同步函数
async function initSync() {
  try {
    const { results } = await retry(() => 
      notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          and: [
            { property: 'type', select: { equals: 'Post' } },
            { property: 'status', select: { equals: 'Published' } },
            { property: 'synced', checkbox: { equals: false } }
          ]
        }
      }),
      retryConfig
    );

    logger.info(`Found ${results.length} articles to sync`);

    for (const page of results) {
      try {
        const props = page.properties;
        const title = props.title?.title?.[0]?.plain_text || 'Untitled';
        
        logger.info(`Processing article: ${title}`);
        
        const blocks = await getAllBlocks(page.id);
        logger.info(`Converting article: ${title}`);
        const content = await convertContent(blocks);
        
        const author = props.author?.rich_text?.[0]?.plain_text || 'Anonymous';
        const summary = props.summary?.rich_text?.[0]?.plain_text || '';
        
        let thumb_media_id = '';
        if (page.cover) {
          const coverUrl = page.cover.type === 'external' 
            ? page.cover.external.url 
            : page.cover.file.url;
          thumb_media_id = await uploadMedia(coverUrl);
        } else {
          thumb_media_id = process.env.DEFAULT_THUMB_MEDIA_ID || '';
        }
        
        const article = {
          title,
          thumb_media_id,
          author,
          digest: summary,
          content,
          content_source_url: page.url,
          show_cover_pic: thumb_media_id ? 1 : 0
        };
        
        logger.info(`Publishing article: ${title}`);
        await retry(() => publishArticle(article), retryConfig);
        
        logger.info(`Updating sync status for: ${title}`);
        await retry(() => 
          notion.pages.update({
            page_id: page.id,
            properties: {
              synced: { checkbox: true }
            }
          }),
          retryConfig
        );
        
        logger.info(`Successfully processed article: ${title}`);
        await delay(2000); // 文章处理间隔
        
      } catch (err) {
        logger.error(`Failed to process article:`, {
          pageId: page.id,
          title: page.properties.title?.title?.[0]?.plain_text,
          error: err.message,
          stack: err.stack
        });
        // 继续处理下一篇
        continue;
      }
    }
    
    logger.info('Sync completed');
    
  } catch (err) {
    logger.error('Sync failed:', {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

module.exports = { initSync };