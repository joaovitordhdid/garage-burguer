// Função serverless da Vercel: todas as rotas /api/* chegam aqui (ver vercel.json).
// O app Express é o mesmo do `npm start`; os arquivos de public/ são servidos direto pela CDN da Vercel.
module.exports = require('../server');
