const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const axios = require('axios');
const { retry, logger } = require('./utils');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);

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
  logger.info(`Starting media download from: ${url}`);
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024, // 10MB限制
      validateStatus: status => status === 200
    });

    // 创建一个内存buffer来存储数据
    const chunks = [];
    let totalLength = 0;

    // 使用stream处理下载
    await new Promise((resolve, reject) => {
      response.data.on('data', chunk => {
        chunks.push(chunk);
        totalLength += chunk.length;
        logger.debug(`Downloaded ${totalLength} bytes`);
        
        // 检查大小限制
        if (totalLength > 10 * 1024 * 1024) {
          reject(new Error('File too large'));
        }
      });

      response.data.on('end', () => {
        logger.info(`Download completed, total size: ${totalLength} bytes`);
        resolve();
      });

      response.data.on('error', err => {
        logger.error('Download stream error:', err);
        reject(err);
      });
    });

    const buffer = Buffer.concat(chunks);
    logger.info(`Media download completed, size: ${buffer.length} bytes`);
    return buffer;

  } catch (err) {
    logger.error('Media download failed:', {
      url,
      error: err.message,
      code: err.code,
      stack: err.stack
    });
    throw err;
  }
}

// 优化的媒体上传函数
async function uploadMedia(url) {
  try {
    logger.info(`Starting media upload process for: ${url}`);
    const buffer = await retry(() => downloadMedia(url), {
      ...retryConfig,
      onRetry: (err) => {
        logger.warn(`Media download retry due to: ${err.message}`);
      }
    });
    
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty media content');
    }
    
    logger.info(`Uploading media to WeChat, size: ${buffer.length} bytes`);
    const result = await retry(
      async () => {
        try {
          const uploadResult = await cloud.uploadFile({
            cloudPath: `covers/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`,
            fileContent: buffer
          });
          logger.info(`Upload successful, fileID: ${uploadResult.fileID}`);
          return uploadResult;
        } catch (err) {
          logger.error('WeChat upload error:', {
            error: err.message,
            stack: err.stack
          });
          throw err;
        }
      },
      {
        ...retryConfig,
        onRetry: (err) => {
          logger.warn(`WeChat upload retry due to: ${err.message}`);
        }
      }
    );
    
    logger.info(`Media upload completed: ${result.fileID}`);
    return result.fileID;
  } catch (err) {
    logger.error('Media upload process failed:', {
      url,
      error: err.message,
      stack: err.stack
    });
    logger.info('Using default thumb media id');
    return process.env.DEFAULT_THUMB_MEDIA_ID || '';
  }
}

// 获取所有blocks
async function getAllBlocks(blockId) {
  logger.info(`Getting blocks for: ${blockId}`);
  const blocks = [];
  let cursor;
  
  try {
    do {
      const response = await retry(
        () => notion.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100
        }),
        retryConfig
      );
      
      blocks.push(...response.results);
      cursor = response.next_cursor;
      
      logger.info(`Retrieved ${blocks.length} blocks so far`);
      
      if (cursor) {
        await delay(1000);
      }
    } while (cursor);
    
    logger.info(`Total blocks retrieved: ${blocks.length}`);
    return blocks;
  } catch (err) {
    logger.error(`Failed to get blocks for ${blockId}:`, {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

// 发布文章到微信
async function publishArticle(article) {
  logger.info(`Publishing article: ${article.title}`);
  try {
    const result = await cloud.openapi.wxacode.submitPages({
      articles: [article]
    });
    
    if (!result.errCode === 0) {
      throw new Error(`WeChat API error: ${result.errMsg}`);
    }
    
    logger.info(`Article published successfully: ${article.title}`);
    return result;
  } catch (err) {
    logger.error('Article publish failed:', {
      title: article.title,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

// 主同步函数
async function initSync() {
  logger.info('Starting sync process');
  try {
    const response = await retry(
      () => notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          and: [
            {
              property: 'status',
              select: {
                equals: 'Ready'
              }
            },
            {
              property: 'synced',
              checkbox: {
                equals: false
              }
            }
          ]
        }
      }),
      retryConfig
    );
    
    const articles = response.results;
    logger.info(`Found ${articles.length} articles to sync`);
    
    for (const page of articles) {
      try {
        const props = page.properties;
        const title = props.title?.title?.[0]?.plain_text;
        
        if (!title) {
          logger.warn(`Skipping article with no title: ${page.id}`);
          continue;
        }
        
        logger.info(`Processing article: ${title}`);
        
        const blocks = await getAllBlocks(page.id);
        logger.info(`Converting content for: ${title}`);
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
          logger.info(`No cover image, using default for: ${title}`);
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
        await delay(2000);
        
      } catch (err) {
        logger.error(`Failed to process article:`, {
          pageId: page.id,
          title: page.properties.title?.title?.[0]?.plain_text,
          error: err.message,
          stack: err.stack
        });
        continue;
      }
    }
    
    logger.info('Sync completed successfully');
    
  } catch (err) {
    logger.error('Sync failed:', {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

module.exports = { initSync };