// helmet, cookie-parser, express-rate-limit: sem efeito na demonstração.
module.exports = () => (req, res, next) => next();
module.exports.default = module.exports;
module.exports.rateLimit = module.exports;
