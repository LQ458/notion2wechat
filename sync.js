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
          .substring(2, 9)}.${buffer.type.split("/")[1]}`,
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
      // 使用重试配置获取页面
      const response = await retry(
        () =>
          notion.databases.query({
            database_id: process.env.NOTION_DATABASE_ID,
            filter: {
              and: [
                {
                  property: "Type",
                  select: { equals: "Post" },
                },
                {
                  property: "Status",
                  select: { equals: "Published" },
                },
                {
                  property: "Synced",
                  checkbox: { equals: false },
                },
              ],
            },
            page_size: config.notion.pageSize,
            start_cursor: startCursor,
          }),
        {
          ...config.notion.retryConfig,
          onRetry: (err) => {
            logger.warn("Retrying database query due to error:", {
              error: err.message,
              code: err.code,
            });
          },
        }
      );

      // 打印完整的响应用于调试
      logger.debug("Database query response:", {
        hasMore: response.has_more,
        resultCount: response.results.length,
      });

      hasMore = response.has_more;
      startCursor = response.next_cursor;

      for (const page of response.results) {
        try {
          const props = page.properties;

          // 打印完整的属性信息用于调试
          logger.debug("Page properties:", {
            pageId: page.id,
            propertyNames: Object.keys(props),
            propertyTypes: Object.entries(props).map(([key, value]) => ({
              name: key,
              type: value.type,
              value: value,
            })),
          });

          // 查找标题属性(不区分大小写)
          const titleProp = Object.entries(props).find(
            ([key, value]) =>
              key.toLowerCase() === "title" || key.toLowerCase() === "name"
          );

          if (!titleProp) {
            logger.warn("Skipping page due to missing title property", {
              pageId: page.id,
              availableProperties: Object.keys(props),
            });
            continue;
          }

          const [titleKey, titleValue] = titleProp;

          // 放宽标题检查条件
          const titleText =
            titleValue.title?.[0]?.plain_text ||
            titleValue.rich_text?.[0]?.plain_text;

          if (!titleText) {
            logger.warn("Skipping page due to empty title", {
              pageId: page.id,
              titleProperty: titleKey,
              titleValue: titleValue,
            });
            continue;
          }

          const article = {
            title: titleText,
            author:
              props.Author?.rich_text?.[0]?.plain_text ||
              props.author?.rich_text?.[0]?.plain_text ||
              "Anonymous",
            summary:
              props.Summary?.rich_text?.[0]?.plain_text ||
              props.summary?.rich_text?.[0]?.plain_text ||
              "",
            cover:
              props.Cover?.files?.[0]?.file?.url ||
              props.cover?.files?.[0]?.file?.url,
            sourceUrl: page.url,
            content: await getAllBlocks(page.id),
          };

          // 发布文章
          await publishArticle(article);

          // 更新同步状态(同时处理大小写)
          await retry(
            () =>
              notion.pages.update({
                page_id: page.id,
                properties: {
                  synced: { checkbox: true }, // 使用小写
                  Synced: { checkbox: true }, // 使用大写
                },
              }),
            {
              ...config.notion.retryConfig,
              onRetry: (err) => {
                logger.warn("Retrying page update due to error:", {
                  error: err.message,
                  pageId: page.id,
                });
              },
            }
          );

          processedCount++;
          logger.info(`Successfully processed article: ${article.title}`);

          // 处理间隔
          await new Promise((resolve) =>
            setTimeout(resolve, config.sync.delay)
          );
        } catch (err) {
          logger.error("Failed to process article:", {
            pageId: page.id,
            error: err.message,
            stack: err.stack,
            properties: Object.keys(props),
          });
          continue;
        }
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

module.exports = {
  initSync,
  getAllBlocks,
};
