const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// 修复morgan stream实现
logger.stream = {
  write: function(message) {
    if(typeof message === 'string') {
      logger.info(message.trim());
    }
  }
};

module.exports = logger; 