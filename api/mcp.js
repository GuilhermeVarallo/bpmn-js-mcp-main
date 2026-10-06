// Vercel Function: every route is rewritten here (vercel.json). The handler
// itself is bundled by `npm run build` into dist/vercel/vercel.js
// (src/vercel.ts; see vercelConfig in esbuild.config.mjs).
module.exports = require('../dist/vercel/vercel.js').default;
