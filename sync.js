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
  retries: 5,
  minTimeout: 2000,
  maxTimeout: 10000,
  randomize: true,
  onRetry: (error, attempt) => {
    logger.warn(`Retry attempt ${attempt} due to error: ${error.message}`);
  }
};

// 包装Notion API调用
async function notionRequest(fn) {
  try {
    return await retry(async () => {
      const result = await fn();
      await delay(500); // 添加500ms延迟
      return result;
    }, retryConfig);
  } catch (err) {
    if (err.code === 'notionhq_client_request_timeout') {
      logger.error('Notion API timeout:', err);
      throw new Error('Notion API request timed out after retries');
    }
    throw err;
  }
}

// 转换块内容为HTML
async function blockToHtml(block) {
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
      const imageUrl = block.image.type === 'external' 
        ? block.image.external.url 
        : block.image.file.url;
      const wxUrl = await uploadMedia(imageUrl);
      html = `<img src="${wxUrl}" style="max-width:100%"/>`;
      break;
      
    case 'quote':
      html = `<blockquote style="border-left:4px solid #ddd;margin:0;padding-left:16px;">
        ${await richTextToHtml(block.quote.rich_text)}
      </blockquote>`;
      break;
      
    case 'divider':
      html = '<hr/>';
      break;
  }
  
  return html;
}

// 转换富文本为HTML
async function richTextToHtml(richText) {
  if (!richText || richText.length === 0) return '';
  
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
}

// 转换Notion内容
async function convertContent(blocks) {
  let html = '';
  let inList = false;
  
  for (const block of blocks) {
    if ((block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') && !inList) {
      html += block.type === 'bulleted_list_item' ? '<ul>' : '<ol>';
      inList = true;
    } else if (inList && block.type !== 'bulleted_list_item' && block.type !== 'numbered_list_item') {
      html += inList ? (html.endsWith('</ul>') ? '' : '</ul>') : '';
      inList = false;
    }
    
    html += await blockToHtml(block);
    
    if (block.has_children) {
      const { results: children } = await notionRequest(() => 
        notion.blocks.children.list({
          block_id: block.id
        })
      );
      html += `<div style="margin-left:24px">
        ${await convertContent(children)}
      </div>`;
    }
  }
  
  if (inList) {
    html += html.endsWith('</ul>') ? '' : '</ul>';
  }
  
  return html;
}

// 上传媒体文件
async function uploadMedia(url) {
  try {
    const response = await retry(async () => {
      const result = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 10000
      });
      return result;
    }, retryConfig);

    const buffer = Buffer.from(response.data);
    const result = await retry(() => 
      cloud.uploadFile({
        cloudPath: `covers/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`,
        fileContent: buffer
      })
    , retryConfig);

    return result.fileID;
  } catch (err) {
    logger.error('Failed to upload media:', err);
    throw err;
  }
}

// 主同步函数
async function initSync() {
  try {
    const { results } = await notionRequest(() => 
      notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          and: [
            { property: 'type', select: { equals: 'Post' } },
            { property: 'status', select: { equals: 'Published' } },
            { property: 'synced', checkbox: { equals: false } }
          ]
        },
        page_size: 10
      })
    );

    logger.info(`Found ${results.length} articles to sync`);

    for (const page of results) {
      try {
        const props = page.properties;
        
        const { results: blocks } = await notionRequest(() => 
          notion.blocks.children.list({
            block_id: page.id,
            page_size: 100
          })
        );
        
        const content = await convertContent(blocks);
        
        const title = props.title?.title?.[0]?.plain_text || 'Untitled';
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
        
        await retry(() => publishArticle(article), retryConfig);
        
        await notionRequest(() => 
          notion.pages.update({
            page_id: page.id,
            properties: {
              synced: { checkbox: true }
            }
          })
        );
        
        logger.info(`Published article: ${title}`);
        
        await delay(1000); // 添加处理间隔
        
      } catch (err) {
        logger.error(`Failed to publish article ${page.id}:`, err);
        continue;
      }
    }
  } catch (err) {
    logger.error('Sync failed:', err);
    throw err;
  }
}

module.exports = { initSync };