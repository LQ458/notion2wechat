module.exports = {
  notion: {
    pageSize: 10,
    retryConfig: {
      retries: 8,
      minTimeout: 5000,
      maxTimeout: 30000,
      factor: 2,
      randomize: true
    }
  },
  
  wechat: {
    retryConfig: {
      retries: 7,
      minTimeout: 3000, 
      maxTimeout: 15000,
      factor: 2
    },
    imageTypes: ['image/jpeg', 'image/png', 'image/gif'],
    maxImageSize: 2 * 1024 * 1024 // 2MB
  },

  sync: {
    interval: 5 * 60 * 1000,
    delay: 5000
  }
}; 