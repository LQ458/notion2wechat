const winston = require('winston');
const { createWriteStream } = require('fs');

// 创建控制台日志格式
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} ${level}: ${message}`;
  })
);

// 创建文件日志格式
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

const logger = winston.createLogger({
  level: 'info',
  format: fileFormat,
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: 'combined.log' 
    })
  ]
});

// 创建一个真正的Writable Stream
const logStream = createWriteStream('access.log', { flags: 'a' });

// 为Morgan提供stream接口
logger.stream = {
  write: (message) => {
    logStream.write(message);
    logger.info(message.trim());
  }
};

module.exports = logger; 