const express = require('express');
const morgan = require('morgan');
const { initSync } = require('./sync');
const { logger } = require('./utils');
const config = require('./config');

const app = express();

// 日志中间件
app.use(morgan('combined', { stream: logger.stream }));
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 手动触发同步
app.post('/sync', async (req, res) => {
  try {
    await initSync();
    res.status(200).send('Sync triggered');
  } catch (err) {
    logger.error('Manual sync failed:', err);
    res.status(500).send(err.message);
  }
});

// 启动定时同步
function startSyncSchedule() {
  initSync().catch(err => {
    logger.error('Scheduled sync failed:', err);
  });
  
  setTimeout(startSyncSchedule, config.sync.interval);
}

// 启动服务
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  startSyncSchedule();
});