const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const { convert } = require('notion-to-html');
const { retry, logger } = require('./utils');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// 转换Notion内容
async function convertContent(blocks) {
  let html = await convert(blocks);
  
  // 处理代码块和图片
  html = html.replace(/<pre>/g, '<pre style="background:#f6f8fa;padding:10px;">');
  
  const imgRegex = /<img src="(.*?)"/g;
  const matches = [...html.matchAll(imgRegex)];
  
  for (const match of matches) {
    const wxUrl = await uploadMedia(match[1]);
    html = html.replace(match[1], wxUrl);
  }
  
  return html;
}

// 上传媒体文件
async function uploadMedia(url) {
  const { data } = await cloud.downloadFile({
    fileID: url,
  });
  
  const uploadResult = await cloud.uploadFile({
    cloudPath: `images/${Date.now()}.jpg`,
    fileContent: data,
  });
  
  return uploadResult.fileID;
}

// 发布文章
async function publishArticle(article) {
  const result = await cloud.openapi.wxacode.createNewsItem({
    articles: [article]
  });
  
  await cloud.openapi.wxacode.submitPublication({
    media_id: result.media_id
  });
  
  return result;
}

// 主同步逻辑
async function initSync() {
  try {
    // 修改过滤器,将status类型改为select
    const { results } = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
        and: [
          { property: 'type', select: { equals: 'Post' } },
          { property: 'status', select: { equals: 'Published' } }, // 修改这里
          { property: 'synced', checkbox: { equals: false } }
        ]
      }
    });

    logger.info(`Found ${results.length} articles to sync`);

    for (const page of results) {
      try {
        const props = page.properties;
        
        // 获取页面内容
        const blocks = await notion.blocks.children.list({
          block_id: page.id,
          page_size: 100
        });
        
        // 转换内容
        const content = await convertContent(blocks.results);
        
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
        // 继续处理下一篇文章
        continue;
      }
    }
  } catch (err) {
    logger.error('Sync failed:', err);
    throw err;
  }
}

module.exports = { initSync };