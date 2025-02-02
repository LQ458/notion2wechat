const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const { retry, logger } = require('./utils');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

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
    
    // 处理文本样式
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
    
    // 处理链接
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
    // 处理列表的开始和结束
    if ((block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') && !inList) {
      html += block.type === 'bulleted_list_item' ? '<ul>' : '<ol>';
      inList = true;
    } else if (inList && block.type !== 'bulleted_list_item' && block.type !== 'numbered_list_item') {
      html += inList ? (html.endsWith('</ul>') ? '' : '</ul>') : '';
      inList = false;
    }
    
    html += await blockToHtml(block);
    
    // 处理子块
    if (block.has_children) {
      const { results: children } = await notion.blocks.children.list({
        block_id: block.id
      });
      html += `<div style="margin-left:24px">
        ${await convertContent(children)}
      </div>`;
    }
  }
  
  // 确保列表正确闭合
  if (inList) {
    html += html.endsWith('</ul>') ? '' : '</ul>';
  }
  
  return html;
}

// 上传媒体文件
async function uploadMedia(url) {
  try {
    const response = await fetch(url);
    const buffer = await response.buffer();
    
    const uploadResult = await cloud.uploadFile({
      cloudPath: `images/${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`,
      fileContent: buffer,
    });
    
    return uploadResult.fileID;
  } catch (err) {
    logger.error('Failed to upload media:', err);
    throw err;
  }
}

// 主同步逻辑
async function initSync() {
  try {
    const { results } = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        and: [
          { property: 'type', select: { equals: 'Post' } },
          { property: 'status', select: { equals: 'Published' } },
          { property: 'synced', checkbox: { equals: false } }
        ]
      }
    });

    logger.info(`Found ${results.length} articles to sync`);

    for (const page of results) {
      try {
        const props = page.properties;
        
        // 获取页面内容
        const { results: blocks } = await notion.blocks.children.list({
          block_id: page.id,
          page_size: 100
        });
        
        // 转换内容
        const content = await convertContent(blocks);
        
        // 上传封面
        const coverUrl = await uploadMedia(props.cover.url);
        
        // 创建文章
        const article = {
          title: props.title.title[0].plain_text,
          thumb_media_id: coverUrl,
          author: props.author.rich_text[0].plain_text,
          digest: props.summary.rich_text[0].plain_text,
          content,
          content_source_url: page.url,
          show_cover_pic: 1
        };
        
        // 发布
        await retry(() => publishArticle(article));
        
        // 更新状态
        await notion.pages.update({
          page_id: page.id,
          properties: {
            synced: { checkbox: true }
          }
        });
        
        logger.info(`Published article: ${article.title}`);
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