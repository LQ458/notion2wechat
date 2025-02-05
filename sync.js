const { Client } = require('@notionhq/client');
const cloud = require('wx-server-sdk');
const { retry, logger } = require('./utils');

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

// 递归获取所有块内容
async function getAllBlocks(blockId) {
  let allBlocks = [];
  let startCursor = undefined;
  let hasMore = true;

  while (hasMore) {
    try {
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
          logger.debug(`Processing nested blocks in ${block.id}`);
          const childBlocks = await getAllBlocks(block.id);
          block.children = childBlocks;
        }
        return block;
      }));

    } catch (err) {
      logger.error('Failed to retrieve blocks:', {
        blockId,
        error: err.message
      });
      throw err;
    }
  }

  return allBlocks;
}

// 处理单个文章
async function processArticle(page) {
  try {
    logger.info(`Processing article: ${page.id}`);
    
    // 获取所有块内容（含分页和嵌套）
    const blocks = await getAllBlocks(page.id);
    
    // 构建文章内容
    const content = blocks
      .flatMap(block => extractBlockContent(block)) // 递归提取内容
      .filter(Boolean)
      .join('\n\n');

    // 发布逻辑
    // ... (保持原有发布逻辑)

    logger.info(`Successfully processed article: ${page.id}`);
    return true;

  } catch (err) {
    logger.error(`Failed to process article ${page.id}:`, {
      error: err.message,
      stack: err.stack
    });
    return false;
  }
}

// 主同步逻辑
async function initSync() {
  try {
    logger.info('Starting sync process');
    
    // 分页获取所有待同步文章
    let hasMore = true;
    let startCursor = undefined;
    let processedCount = 0;

    while (hasMore) {
      const response = await retry(() => 
        notion.databases.query({
          database_id: process.env.NOTION_DATABASE_ID,
          filter: {
            property: 'synced',
            checkbox: { equals: false }
          },
          page_size: 100,
          start_cursor: startCursor
        }),
        retryConfig
      );

      const pages = response.results;
      hasMore = response.has_more;
      startCursor = response.next_cursor;

      logger.info(`Found ${pages.length} articles to process`);

      // 分批处理避免内存溢出
      for (const page of pages) {
        const success = await processArticle(page);
        if (!success) {
          logger.warn(`Skipping article ${page.id} due to errors`);
          continue;
        }
        processedCount++;
        
        // 每处理10篇文章清理内存
        if (processedCount % 10 === 0) {
          logger.info(`Processed ${processedCount} articles, clearing memory`);
          if (global.gc) global.gc(); // 显式调用GC（如果启用）
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

// 辅助函数：提取块内容
function extractBlockContent(block) {
  try {
    let contents = [];
    
    // 处理当前块内容
    switch (block.type) {
      case 'paragraph':
        contents.push(block.paragraph.text.map(t => t.plain_text).join(''));
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        contents.push(block[block.type].text.map(t => t.plain_text).join(''));
        break;
      // 其他块类型处理...
    }

    // 递归处理子块
    if (block.children) {
      block.children.forEach(child => {
        contents = contents.concat(extractBlockContent(child));
      });
    }

    return contents;
  } catch (err) {
    logger.error('Failed to extract block content:', {
      blockId: block.id,
      error: err.message
    });
    return [];
  }
}

module.exports = { initSync };