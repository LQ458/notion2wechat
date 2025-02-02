const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const axios = require('axios');
const { retry, logger } = require('./utils');

// 创建Notion客户端实例
const notion = new Client({ 
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 60000,
  notionVersion: '2022-06-28'
});

// 添加请求延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 优化的重试配置
const retryConfig = {
  retries: 3,
  minTimeout: 2000,
  maxTimeout: 10000,
  randomize: true,
  onRetry: (error, attempt) => {
    logger.warn(`Retry attempt ${attempt} due to error: ${error.message}`);
  }
};

// 下载媒体文件
async function downloadMedia(url) {
  logger.info(`Downloading media from: ${url}`);
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout: 30000, // 30秒超时
      maxContentLength: 10 * 1024 * 1024, // 10MB限制
      validateStatus: status => status === 200
    });
    return response.data;
  } catch (err) {
    logger.error(`Failed to download media: ${url}`, {
      error: err.message,
      code: err.code
    });
    throw err;
  }
}

// 上传媒体文件到云存储
async function uploadMedia(url) {
  try {
    const buffer = await retry(
      () => downloadMedia(url),
      {
        ...retryConfig,
        retries: 2 // 减少重试次数
      }
    );

    if (!buffer || buffer.length === 0) {
      throw new Error('Empty media file');
    }

    logger.info(`Uploading media file to cloud storage, size: ${buffer.length}`);
    const result = await retry(() =>
      cloud.uploadFile({
        cloudPath: `covers/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`,
        fileContent: buffer
      })
    );

    logger.info(`Successfully uploaded media file: ${result.fileID}`);
    return result.fileID;
  } catch (err) {
    logger.error('Failed to upload media:', {
      error: err.message,
      url
    });
    // 返回默认图片
    return process.env.DEFAULT_THUMB_MEDIA_ID || '';
  }
}

// 获取所有blocks
async function getAllBlocks(blockId) {
  let blocks = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    try {
      const response = await notionRequest(
        () => notion.blocks.children.list({
          block_id: blockId,
          start_cursor: startCursor,
          page_size: 50
        }),
        `Get blocks for ${blockId}`
      );

      blocks = blocks.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;

      if (hasMore) {
        await delay(500);
      }
    } catch (err) {
      logger.error(`Failed to get blocks for ${blockId}:`, {
        error: err.message,
        cursor: startCursor
      });
      throw err;
    }
  }

  return blocks;
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
        html = `<pre style="background:#f6f8fa;padding:10px;border-radius:5px;"><code>${
          await richTextToHtml(block.code.rich_text)
        }</code></pre>`;
        break;
        
      case 'image':
        try {
          const imageUrl = block.image.type === 'external' 
            ? block.image.external.url 
            : block.image.file.url;
          const wxUrl = await uploadMedia(imageUrl);
          html = `<img src="${wxUrl}" style="max-width:100%"/>`;
        } catch (err) {
          logger.error('Failed to process image block:', {
            error: err.message,
            blockId: block.id
          });
          html = ''; // Skip failed images
        }
        break;
        
      case 'quote':
        html = `<blockquote style="border-left:4px solid #ddd;margin:0;padding-left:16px;">
          ${await richTextToHtml(block.quote.rich_text)}
        </blockquote>`;
        break;
        
      case 'divider':
        html = '<hr/>';
        break;
        
      default:
        logger.warn(`Unsupported block type: ${block.type}`);
        html = '';
    }
    
    return html;
  } catch (err) {
    logger.error(`Failed to convert block to HTML:`, {
      error: err.message,
      blockId: block.id,
      type: block.type
    });
    return '';
  }
}

// 转换富文本为HTML
async function richTextToHtml(richText) {
  if (!richText || richText.length === 0) return '';
  
  try {
    return richText.map(text => {
      let content = text.plain_text;
      
      if (text.annotations.bold) {
        content = `<strong>${content}</strong>`;
      }
      if (text.annotations.italic) {
        content = `<em>${content}</em>`;
      }
      if (text.annotations.strikethrough) {
        content = `<del>${content}</del>`;
      }
      if (text.annotations.underline) {
        content = `<u>${content}</u>`;
      }
      if (text.annotations.code) {
        content = `<code>${content}</code>`;
      }
      
      if (text.href) {
        content = `<a href="${text.href}" target="_blank">${content}</a>`;
      }
      
      return content;
    }).join('');
  } catch (err) {
    logger.error('Failed to convert rich text to HTML:', err);
    return '';
  }
}

// 转换Notion内容
async function convertContent(blocks) {
  let html = '';
  let inList = false;
  
  try {
    for (const block of blocks) {
      const blockHtml = await blockToHtml(block);
      
      if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') {
        if (!inList) {
          html += block.type === 'bulleted_list_item' ? '<ul>' : '<ol>';
          inList = true;
        }
      } else if (inList) {
        html += block.type === 'bulleted_list_item' ? '</ul>' : '</ol>';
        inList = false;
      }
      
      html += blockHtml;
      
      if (block.has_children) {
        const children = await getAllBlocks(block.id);
        html += await convertContent(children);
      }
    }
    
    if (inList) {
      html += blocks[blocks.length - 1].type === 'bulleted_list_item' ? '</ul>' : '</ol>';
    }
    
    return html;
  } catch (err) {
    logger.error('Failed to convert content:', err);
    throw err;
  }
}

// 发布文章
async function publishArticle(article) {
  // 实现发布逻辑
  return true;
}

async function initSync() {
  try {
    const { results } = await notionRequest(
      () => notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          and: [
            { property: 'type', select: { equals: 'Post' } },
            { property: 'status', select: { equals: 'Published' } },
            { property: 'synced', checkbox: { equals: false } }
          ]
        }
      }),
      'Query database for articles'
    );

    logger.info(`Found ${results.length} articles to sync`);

    for (const page of results) {
      try {
        const props = page.properties;
        const title = props.title?.title?.[0]?.plain_text || 'Untitled';
        
        logger.info(`Converting article: ${title}`);
        
        const blocks = await getAllBlocks(page.id);
        const content = await convertContent(blocks);
        
        const author = props.author?.rich_text?.[0]?.plain_text || 'Anonymous';
        const summary = props.summary?.rich_text?.[0]?.plain_text || '';
        
        let thumb_media_id = '';
        if (page.cover?.type === 'external') {
          thumb_media_id = await uploadMedia(page.cover.external.url);
        } else if (page.cover?.type === 'file') {
          thumb_media_id = await uploadMedia(page.cover.file.url);
        } else {
          logger.warn(`No cover image found for article: ${title}`);
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
        
        logger.info(`Updating sync status for article: ${title}`);
        await notionRequest(
          () => notion.pages.update({
            page_id: page.id,
            properties: {
              synced: { checkbox: true }
            }
          }),
          `Update sync status for ${title}`
        );
        
        logger.info(`Successfully published article: ${title}`);
        await delay(2000);
        
      } catch (err) {
        logger.error(`Failed to process article:`, {
          pageId: page.id,
          title: page.properties?.title?.title?.[0]?.plain_text,
          error: err.message,
          stack: err.stack
        });
        continue;
      }
    }
  } catch (err) {
    logger.error('Sync failed:', {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

module.exports = { initSync };