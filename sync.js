const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const { retry, logger } = require('./utils');

// 定义重试配置
const retryConfig = {
  retries: 5,                // 最大重试次数
  minTimeout: 3000,          // 最小重试间隔(ms)
  maxTimeout: 15000,         // 最大重试间隔(ms)
  factor: 2,                 // 重试间隔增长因子
  onRetry: (error, attempt) => {
    logger.warn(`Retry attempt ${attempt} due to error: ${error.message}`);
  }
};

// 初始化云开发
cloud.init({
  env: process.env.WX_ENV,
  timeout: 20000
});

// 创建Notion客户端
const notion = new Client({ 
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 30000
});

// 基础延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 递归获取所有块内容
async function getAllBlocks(blockId) {
  let allBlocks = [];
  let startCursor = undefined;
  let hasMore = true;

  while (hasMore) {
    try {
      // 使用重试配置获取块内容
      const response = await retry(() => 
        notion.blocks.children.list({
          block_id: blockId,
          page_size: 100,
          start_cursor: startCursor
        }), 
        retryConfig
      );

      allBlocks = allBlocks.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;

      // 处理嵌套块
      await Promise.all(response.results.map(async (block) => {
        if (block.has_children) {
          const childBlocks = await getAllBlocks(block.id);
          block.children = childBlocks;
        }
        return block;
      }));

    } catch (err) {
      logger.error('Failed to retrieve blocks:', {
        blockId,
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
  }

  return allBlocks;
}

// 主同步函数
async function initSync() {
  let processedCount = 0;
  let startCursor = undefined;
  let hasMore = true;

  try {
    while (hasMore) {
      // 使用重试配置获取页面
      const response = await retry(() => 
        notion.databases.query({
          database_id: process.env.NOTION_DATABASE_ID,
          filter: {
            property: 'synced',
            checkbox: {
              equals: false
            }
          },
          page_size: 10,
          start_cursor: startCursor
        }),
        retryConfig
      );

      hasMore = response.has_more;
      startCursor = response.next_cursor;

      for (const page of response.results) {
        try {
          const title = page.properties.title?.title?.[0]?.plain_text;
          logger.info(`Processing article: ${title}`);

          // 获取文章内容
          const blocks = await getAllBlocks(page.id);
          const article = {
            title,
            content: blocks
          };

          // 发布文章
          await retry(() => publishArticle(article), {
            ...retryConfig,
            retries: 7  // 发布时使用更多重试次数
          });

          // 更新同步状态
          await retry(() => 
            notion.pages.update({
              page_id: page.id,
              properties: {
                synced: { checkbox: true }
              }
            }),
            retryConfig
          );

          processedCount++;
          logger.info(`Successfully processed article: ${title}`);
          await delay(3000);  // 处理间隔

        } catch (err) {
          logger.error(`Failed to process article:`, {
            pageId: page.id,
            title: page.properties.title?.title?.[0]?.plain_text,
            error: err.message,
            stack: err.stack
          });
          continue;  // 继续处理下一篇文章
        }
      }

      // 处理分页间隔
      if (hasMore) {
        logger.info('Processing next page...');
        await delay(3000);
      }
    }

    logger.info(`Sync completed. Total processed: ${processedCount}`);

  } catch (err) {
    logger.error('Sync failed:', {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

module.exports = { initSync };