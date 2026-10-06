// Vercel Function: every route is rewritten here (vercel.json). The handler
// itself is bundled by `npm run build` into dist/vercel.js (src/vercel.ts).
module.exports = require('../dist/vercel.js').default;
