const express = require('express');
const morgan = require('morgan');
const cloud = require('wx-server-sdk');
const { initSync } = require('./sync');
const { logger } = require('./utils');

// 初始化云开发
cloud.init({
  env: process.env.WX_ENV
});

const app = express();

// 请求日志
app.use(morgan('combined'));
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 手动触发同步
app.post('/sync', async (req, res) => {
  try {
    await initSync();
    res.status(200).json({ message: 'Sync completed' });
  } catch (err) {
    logger.error('Sync failed:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 80;
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});