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

    // 检查Content-Length
    const contentLength = parseInt(response.headers['content-length'], 10);
    if (contentLength > maxSize) {
      throw new Error(`File too large: ${contentLength} bytes`);
    }

    // 创建写入流
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

    logger.info(`Successfully downloaded media: ${url}, size: ${size} bytes`);
    return Buffer.concat(chunks);

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
    const buffer = await retry(() => downloadMedia(url), retryConfig);
    
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty media buffer');
    }

    logger.info(`Uploading media to WeChat, size: ${buffer.length} bytes`);
    const result = await cloud.uploadFile({
      fileContent: buffer,
      cloudPath: `images/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
    });

    if (!result.fileID) {
      throw new Error('Upload failed: No fileID returned');
    }

    logger.info(`Successfully uploaded media to: ${result.fileID}`);
    return result.fileID;

  } catch (err) {
    logger.error('Media upload failed:', {
      url,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

// 优化的文章发布函数
async function publishArticle(article) {
  try {
    logger.info(`Publishing article: ${article.title}`);
    const result = await cloud.openapi.wxacode.createQRCode({
      path: `pages/article/detail?id=${article.id}`,
      width: 430
    });

    if (!result || !result.buffer) {
      throw new Error('Failed to generate QR code');
    }

    logger.info('Article published successfully');
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

async function initSync() {
  try {
    logger.info('Starting sync process');
    
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

        // 获取文章内容
        const blocks = await retry(() => 
          notion.blocks.children.list({ block_id: page.id }),
          retryConfig
        );

        // 处理封面图
        let thumb_media_id = null;
        if (props.cover?.url) {
          try {
            thumb_media_id = await uploadMedia(props.cover.url);
          } catch (err) {
            logger.error('Cover image processing failed:', {
              url: props.cover.url,
              error: err.message
            });
            // 继续处理文章，使用默认封面
          }
        }

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