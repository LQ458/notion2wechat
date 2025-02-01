const winston = require('winston');

// 初始化日志
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// 重试函数
async function retry(fn, times = 3, delay = 1000) {
  try {
    return await fn();
  } catch (err) {
    if (times === 0) throw err;
    await new Promise(r => setTimeout(r, delay));
    return retry(fn, times - 1, delay * 2);
  }
}

module.exports = {
  logger,
  retry
};