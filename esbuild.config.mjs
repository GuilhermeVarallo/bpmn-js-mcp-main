import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build, context } from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir: 'dist',
  entryNames: '[name]',
  external: [
    'bpmn-js',
    'bpmn-auto-layout',
    'bpmn-to-image',
    'bpmnlint',
    'bpmnlint-plugin-camunda-compat',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
};

/**
 * Vercel Function bundle (api/mcp.js → dist/vercel/vercel.js), see ADR-034.
 *
 * Self-contained, unlike the CLI bundle: Vercel's Node loader does not support
 * require() of ES modules, which jsdom 30 (via bpmn-to-image) relies on —
 * Node 22 does, so the CLI bundle keeps its dependencies external.  esbuild
 * turns them into CommonJS here.  Left out: the resvg native addon, bpmnlint
 * (it loads plugins by name at runtime) and jsdom's optional `canvas`.
 *
 * Libraries also read their own files at runtime, relative to their install
 * directory (jsdom's default stylesheet and XHR worker, bpmn-to-image's fonts
 * and bpmn-js's modeler script).  Inside the bundle `__dirname` would be
 * dist/vercel/, so originalDirname rewrites each library's `__dirname`,
 * `__filename` and relative `require.resolve('./…')` to its original
 * node_modules location; vercel.json `includeFiles` ships those directories.
 */
const VERCEL_OUTDIR = path.resolve('dist/vercel');
const NODE_MODULES_JS = /[\\/]node_modules[\\/].*\.c?js$/;
const NEEDS_REWRITE = /__dirname|__filename|require\.resolve\(\s*["']\.{1,2}\//;
const RELATIVE_RESOLVE = /require\.resolve\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g;

const originalDirname = {
  name: 'original-dirname',
  setup(build) {
    build.onLoad({ filter: NODE_MODULES_JS }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (!NEEDS_REWRITE.test(source)) return undefined;
      const rel = path.relative(VERCEL_OUTDIR, path.dirname(args.path)).split(path.sep).join('/');
      const dir = `require("node:path").join(__dirname, ${JSON.stringify(rel)})`;
      const file = (name) => `require("node:path").join(${dir}, ${JSON.stringify(name)})`;
      const contents = source
        .replace(/\b__dirname\b/g, `(${dir})`)
        .replace(/\b__filename\b/g, file(path.basename(args.path)))
        .replace(RELATIVE_RESOLVE, (_match, _quote, name) => file(name));
      return { contents, loader: 'js' };
    });
  },
};

const vercelConfig = {
  entryPoints: ['src/vercel.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/vercel/vercel.js',
  external: ['@resvg/resvg-js', 'bpmnlint', 'bpmnlint-plugin-camunda-compat', 'canvas'],
  plugins: [originalDirname],
  logOverride: { 'require-resolve-not-external': 'silent' },
};

/**
 * Browser bundle for the MCP Apps diagram viewer (issue #11 / ADR-025):
 * `@modelcontextprotocol/ext-apps`'s View-side `App`/`PostMessageTransport`,
 * self-contained (no `external`), inlined as a <script> into the
 * `ui://bpmn-diagram-viewer` resource by `src/mcp-apps/resource.ts`.
 */
const mcpAppsViewerConfig = {
  entryPoints: ['src/mcp-apps/viewer-entry.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outdir: 'dist',
  entryNames: 'mcp-apps-viewer-bundle',
};

const isWatch = process.argv.includes('--watch');

if (isWatch) {
  const ctx = await context(config);
  const mcpAppsCtx = await context(mcpAppsViewerConfig);
  await Promise.all([ctx.watch(), mcpAppsCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await build(config);
  await build(mcpAppsViewerConfig);
  await build(vercelConfig);
}
