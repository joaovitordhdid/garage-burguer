module.exports = { join: (...a) => a.join('/').replace(/\/+/g, '/'), resolve: (...a) => a.join('/'), dirname: p => p };
