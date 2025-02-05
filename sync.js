const { Client } = require("@notionhq/client");
const cloud = require("wx-server-sdk");
const { convert } = require("notion-to-html");
const { retry, logger } = require("./utils");
const config = require("./config");

// 初始化客户端
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 30000,
});

cloud.init({
  env: process.env.WX_ENV,
});

// 处理图片上传
async function uploadImage(url) {
  try {
    const response = await retry(async () => {
      const buffer = await cloud.downloadFile({
        fileID: url,
      });

      // 检查文件类型和大小
      if (!config.wechat.imageTypes.includes(buffer.type)) {
        throw new Error(`Unsupported image type: ${buffer.type}`);
      }
      if (buffer.length > config.wechat.maxImageSize) {
        throw new Error("Image too large");
      }

      return await cloud.uploadFile({
        cloudPath: `images/${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}.${buffer.type.split("/")[1]}`,
        fileContent: buffer,
      });
    }, config.wechat.retryConfig);

    return response.fileID;
  } catch (err) {
    logger.error("Image upload failed:", {
      url,
      error: err.message,
    });
    throw err;
  }
}

// 转换Notion内容为公众号格式
async function convertContent(blocks) {
  try {
    let html = await convert(blocks);

    // 处理图片
    const imgRegex = /<img[^>]+src="([^">]+)"/g;
    const matches = [...html.matchAll(imgRegex)];

    for (const match of matches) {
      const wxUrl = await uploadImage(match[1]);
      html = html.replace(match[1], wxUrl);
    }

    return html;
  } catch (err) {
    logger.error("Content conversion failed:", err);
    throw err;
  }
}

// 发布文章到公众号
async function publishArticle(article) {
  try {
    // 上传封面图
    const thumbMediaId = await uploadImage(article.cover);

    // 创建图文素材
    const news = {
      articles: [
        {
          title: article.title,
          thumb_media_id: thumbMediaId,
          author: article.author,
          digest: article.summary,
          content: article.content,
          content_source_url: article.sourceUrl,
          show_cover_pic: 1,
        },
      ],
    };

    const result = await retry(
      () =>
        cloud.openapi.wxacode.createWXAQRCode({
          path: "pages/index/index",
          width: 430,
        }),
      config.wechat.retryConfig
    );

    logger.info("Article published successfully:", {
      title: article.title,
      mediaId: result.mediaId,
    });

    return result;
  } catch (err) {
    logger.error("Article publish failed:", {
      title: article.title,
      error: err.message,
    });
    throw err;
  }
}

// 递归获取所有块内容
async function getAllBlocks(blockId) {
  let allBlocks = [];
  let startCursor = undefined;
  let hasMore = true;

  while (hasMore) {
    try {
      // 使用重试配置获取块内容
      const response = await retry(
        () =>
          notion.blocks.children.list({
            block_id: blockId,
            page_size: 100,
            start_cursor: startCursor,
          }),
        config.notion.retryConfig
      );

      allBlocks = allBlocks.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;

      // 处理嵌套块
      await Promise.all(
        response.results.map(async (block) => {
          if (block.has_children) {
            const childBlocks = await getAllBlocks(block.id);
            block.children = childBlocks;
          }
          return block;
        })
      );
    } catch (err) {
      logger.error("Failed to retrieve blocks:", {
        blockId,
        error: err.message,
        stack: err.stack,
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
      // 查询待发布文章
      const response = await retry(
        () =>
          notion.databases.query({
            database_id: process.env.NOTION_DATABASE_ID,
            filter: {
              and: [
                { property: "type", select: { equals: "Post" } },
                { property: "status", status: { equals: "Published" } },
                { property: "synced", checkbox: { equals: false } },
              ],
            },
            page_size: config.notion.pageSize,
            start_cursor: startCursor,
          }),
        config.notion.retryConfig
      );

      hasMore = response.has_more;
      startCursor = response.next_cursor;

      // 处理每篇文章
      for (const page of response.results) {
        try {
          const props = page.properties;
          const title = props.title?.title?.[0]?.plain_text;

          logger.info(`Processing article: ${title}`);

          // 获取文章内容
          const blocks = await getAllBlocks(page.id);
          const content = await convertContent(blocks);

          const article = {
            title,
            author: props.author?.rich_text?.[0]?.plain_text || "Anonymous",
            summary: props.summary?.rich_text?.[0]?.plain_text || "",
            content,
            cover: props.cover?.url,
            sourceUrl: page.url,
          };

          // 发布文章
          await publishArticle(article);

          // 更新同步状态
          await retry(
            () =>
              notion.pages.update({
                page_id: page.id,
                properties: {
                  synced: { checkbox: true },
                },
              }),
            config.notion.retryConfig
          );

          processedCount++;
          logger.info(`Successfully processed article: ${title}`);
          await new Promise((resolve) =>
            setTimeout(resolve, config.sync.delay)
          );
        } catch (err) {
          logger.error(`Failed to process article:`, {
            pageId: page.id,
            title: page.properties.title?.title?.[0]?.plain_text,
            error: err.message,
            stack: err.stack,
          });
          continue;
        }
      }

      if (hasMore) {
        logger.info("Processing next page...");
        await new Promise((resolve) => setTimeout(resolve, config.sync.delay));
      }
    }

    logger.info(`Sync completed. Total processed: ${processedCount}`);
  } catch (err) {
    logger.error("Sync failed:", {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

module.exports = { initSync };
