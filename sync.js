const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const axios = require('axios');
const { retry, logger } = require('./utils');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);

// 初始化云开发
cloud.init({
  env: process.env.WX_ENV,
  timeout: 15000, // 设置更长的超时时间
});

// 创建Notion客户端
const notion = new Client({ 
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 30000
});

// 基础延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 重试配置
const retryConfig = {
  retries: 5, // 增加重试次数
  minTimeout: 3000,
  maxTimeout: 15000,
  factor: 2,
  onRetry: (error, attempt) => {
    logger.warn(`Retry attempt ${attempt} due to error: ${error.message}`);
  }
};

// 优化的媒体下载函数
async function downloadMedia(url, maxSize = 10 * 1024 * 1024) {
  logger.info(`Starting media download from: ${url}`);
  
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 15000,
      maxContentLength: maxSize,
      validateStatus: status => status === 200
    });

    const contentLength = parseInt(response.headers['content-length'], 10);
    if (contentLength > maxSize) {
      throw new Error(`File too large: ${contentLength} bytes`);
    }

    const chunks = [];
    let size = 0;

    await pipeline(
      response.data,
      new stream.Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > maxSize) {
            callback(new Error(`Stream exceeded size limit of ${maxSize} bytes`));
            return;
          }
          chunks.push(chunk);
          callback();
        }
      })
    );

    return Buffer.concat(chunks);
  } catch (err) {
    logger.error('Media download failed:', {
      url,
      error: err.message,
      code: err.code || 'UNKNOWN'
    });
    throw err;
  }
}

// 优化的文章发布函数
async function publishArticle(article) {
  logger.info(`Starting article publish: ${article.title}`);
  
  try {
    // 创建小程序码
    logger.info('Creating QR code');
    const qrResult = await retry(async () => {
      try {
        return await cloud.openapi.wxacode.createQRCode({
          path: `pages/article/detail?id=${article.id}`,
          width: 280
        });
      } catch (err) {
        logger.error('QR code creation failed:', {
          error: err.message,
          code: err.errCode
        });
        throw err;
      }
    }, {
      ...retryConfig,
      retries: 3
    });

    // 上传文章内容
    logger.info('Uploading article content');
    const result = await retry(async () => {
      try {
        const { miniprogram } = cloud.getWXContext();
        return await cloud.openapi.draft.add({
          articles: [
            {
              ...article,
              thumb_media_id: article.thumb_media_id || '',
              qrcode_url: qrResult.url || ''
            }
          ]
        });
      } catch (err) {
        logger.error('Article upload failed:', {
          error: err.message,
          code: err.errCode
        });
        throw err;
      }
    }, retryConfig);

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
    const pages = await retry(() => 
      notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
          property: 'synced',
          checkbox: {
            equals: false
          }
        }
      }),
      retryConfig
    );

    logger.info(`Found ${pages.results.length} articles to sync`);

    for (const page of pages.results) {
      try {
        const props = page.properties;
        const title = props.title?.title?.[0]?.plain_text;
        
        logger.info(`Processing article: ${title}`);

        // 获取封面图
        let thumb_media_id = null;
        if (page.cover?.external?.url) {
          try {
            const imageData = await downloadMedia(page.cover.external.url);
            const uploadResult = await retry(() => 
              cloud.uploadFile({
                cloudPath: `covers/${Date.now()}-${title}.jpg`,
                fileContent: imageData
              }),
              retryConfig
            );
            thumb_media_id = uploadResult.fileID;
          } catch (err) {
            logger.warn(`Cover image processing failed: ${err.message}`);
          }
        }

        // 获取文章内容
        const blocks = await retry(() => 
          notion.blocks.children.list({
            block_id: page.id
          }),
          retryConfig
        );

        // 构建文章内容
        const content = blocks.results
          .map(block => {
            if (block.type === 'paragraph') {
              return block.paragraph.rich_text
                .map(text => text.plain_text)
                .join('');
            }
            return '';
          })
          .filter(Boolean)
          .join('\n\n');

        const article = {
          title,
          thumb_media_id,
          author: props.author?.rich_text?.[0]?.plain_text || '默认作者',
          digest: props.summary?.rich_text?.[0]?.plain_text || content.slice(0, 100),
          content,
          content_source_url: page.url,
          show_cover_pic: thumb_media_id ? 1 : 0
        };

        logger.info(`Publishing article: ${title}`);
        await retry(() => publishArticle(article), {
          ...retryConfig,
          retries: 5 // 增加发布重试次数
        });

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
        await delay(3000); // 增加间隔时间

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