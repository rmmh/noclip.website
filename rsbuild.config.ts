import { defineConfig, type RequestHandler } from '@rsbuild/core';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';
import { execSync } from 'node:child_process';
import { readdir } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import parseUrl from 'parseurl';
import send from 'send';

let gitCommit = '(unknown)';
try {
  gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
  console.warn('Failed to fetch Git commit hash', e);
}

const projectRoot = dirname(fileURLToPath(import.meta.url));

// The URL path the site is served from. It only needs to be set for the dev
// server; production builds emit document-relative URLs and can be dropped into
// any directory. Set e.g. `BASE_PATH=/noclip` to serve from a subdirectory.
const basePath = normalizeBasePath(process.env.BASE_PATH ?? '/');

// Normalizes to a leading slash and no trailing slash, e.g. `noclip/` -> `/noclip`.
// The server root normalizes to `/`.
function normalizeBasePath(base: string): string {
  const trimmed = base.replace(/^\/*/, '').replace(/\/*$/, '');
  return trimmed === '' ? '/' : `/${trimmed}`;
}

export default defineConfig({
  source: {
    entry: {
      index: './src/main.ts',
      embed: './src/main.ts',
    },
    // Legacy decorators are used with `reflect-metadata`.
    // TODO: Migrate to TypeScript 5.0 / TC39 decorators.
    decorators: {
      version: 'legacy',
    },
    define: {
      __COMMIT_HASH: JSON.stringify(gitCommit),
    },
  },
  html: {
    template: './src/index.html',
  },
  output: {
    target: 'web',
    // Emit document-relative asset URLs, so that a build can be served from any
    // directory without being rebuilt. Set `ASSET_PREFIX` to serve assets from a
    // fixed location, such as a CDN.
    assetPrefix: process.env.ASSET_PREFIX ?? 'auto',
    // Mark Node.js built-in modules as external.
    externals: ['fs', 'path', 'url'],
    // TODO: These should be converted to use `new URL('./file.wasm', import.meta.url)`
    // so that the bundler can resolve them. In the meantime, the Emscripten modules
    // look for them either next to the loading script or next to the document, so
    // they're copied to both places. Both are relative to the deploy directory.
    copy: [
      { from: 'src/**/*.wasm', to: '[name][ext]' },
      { from: 'node_modules/librw/lib/librw.wasm', to: 'static/js/[name][ext]' },
      { from: 'src/vendor/basis_universal/basis_transcoder.wasm', to: 'static/js/[name][ext]' },
    ],
  },
  // Enable async TypeScript type checking.
  plugins: [pluginTypeCheck()],
  tools: {
    rspack(config) {
      config.node = { ...config.node, __dirname: false };
    },
    // Disable standards-compliant class field transforms.
    swc: {
      jsc: {
        transform: {
          useDefineForClassFields: false,
        },
      },
    },
  },
  // Disable fallback to index for 404 responses.
  server: {
    base: basePath,
    htmlFallback: false,
  },
  // Setup middleware to serve the `data` directory.
  dev: {
    setupMiddlewares: [
      (middlewares, _server) => {
        middlewares.unshift(serveData);
        return middlewares;
      },
    ],
  },
});

// Matches `/data/...`, optionally prefixed by the base path. This middleware runs
// ahead of the one that strips the base path, so it has to accept both forms.
const dataPathRE = new RegExp(
  `^(?:${escapeRegExp(basePath === '/' ? '' : basePath)})?/data(/.*)?$`,
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Serve files from the `data` directory.
const serveData: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const matches = parseUrl(req)?.pathname?.match(dataPathRE);
  if (!matches) {
    next();
    return;
  }
  // The `send` package handles Range requests, conditional GET,
  // ETag generation, Cache-Control, Last-Modified, and more.
  const stream = send(req, matches[1] || '', {
    index: false,
    root: join(projectRoot, 'data'),
  });
  stream.on(
    'directory',
    function handleDirectory(
      this: send.SendStream,
      res: ServerResponse,
      path: string,
    ) {
      // Print directory listing
      readdir(path, (err, list) => {
        if (err) return this.error(500, err);
        const filtered = list.filter((file) => !file.startsWith('.'));
        if (filtered.length === 0) return this.error(404);
        res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        res.end(`${filtered.join('\n')}\n`);
      });
    },
  );
  stream.pipe(res);
};
