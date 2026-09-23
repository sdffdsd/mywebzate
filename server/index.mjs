#!/usr/bin/env node
/**
 * 备用出口：把 dist/ 用 Node 原生 http 直接托管，并挂上同一个 /api/visit。
 *
 * 用途（不备案方案的国内直连线路）：
 *   香港 / 日本 / 新加坡的小机器上跑 `npm run serve:node`，
 *   DNS 把国内线路解析到这台机器，海外线路继续走 Cloudflare Pages。
 *
 * 特性：
 *   - 支持 Range 206（音频拖动进度条、边下边播）
 *   - 与 Cloudflare _headers 一致的缓存策略
 *   - 目录穿越防护、ETag、404 回落到 404.html
 *   - 零第三方依赖
 *
 * 用法：
 *   npm run build && node server/index.mjs [--port 8080] [--root dist]
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleVisit } from '../src/lib/visit-core.ts';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(process.env.PORT ?? argValue('port', '8080'));
const HOST = process.env.HOST ?? argValue('host', '0.0.0.0');
const DIST = resolve(ROOT_DIR, argValue('root', 'dist'));
const DATA_FILE = resolve(ROOT_DIR, process.env.VISIT_DATA_FILE ?? '.data/visits.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/* ------------------------- 访客计数：文件存储 ------------------------- */

function fileStore(file) {
  return {
    async get() {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const value = Number(parsed?.count);
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    async set(value) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ count: value, updatedAt: new Date().toISOString() }));
    },
  };
}

/* ----------------------------- 静态文件 ----------------------------- */

function cacheControl(pathname) {
  if (pathname.startsWith('/_assets/')) return 'public, max-age=31536000, immutable';
  if (pathname.startsWith('/audio/')) return 'public, max-age=604800';
  if (pathname.endsWith('.html') || pathname === '/') return 'public, max-age=0, must-revalidate';
  return 'public, max-age=3600';
}

function contentType(pathname) {
  return MIME[extname(pathname).toLowerCase()] ?? 'application/octet-stream';
}

function etagFor(stats) {
  return `"${createHash('sha1').update(`${stats.size}-${stats.mtimeMs}`).digest('hex').slice(0, 20)}"`;
}

/** 把 /a/b/ 解析成 dist/a/b/index.html，并确保没跑出 dist 之外。 */
function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let target = join(DIST, safe);

  if (!target.startsWith(DIST)) return null;

  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, 'index.html');
  }

  if (!existsSync(target) && existsSync(`${target}.html`)) {
    target = `${target}.html`;
  }

  if (!existsSync(target) || !statSync(target).isFile()) return null;

  return target;
}

function sendRange(req, res, file, stats) {
  const type = contentType(file);
  const etag = etagFor(stats);
  const headers = {
    'content-type': type,
    'cache-control': cacheControl(new URL(req.url ?? '/', 'http://x').pathname),
    etag,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = req.headers.range;
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;

    if (Number.isNaN(start) || start > end || start >= stats.size) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stats.size}`,
      'content-length': String(end - start + 1),
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': String(stats.size) });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  createReadStream(file).pipe(res);
}

/* ------------------------------- 服务器 ------------------------------- */

const store = fileStore(DATA_FILE);

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  // --- API ---
  if (pathname === '/api/visit') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const response = await handleVisit(new Request(url, { method: req.method, headers: req.headers }), store);

    for (const [k, v] of response.headers) res.setHeader(k, v);
    res.writeHead(response.status);
    res.end(await response.text());
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('ok\n');
    return;
  }

  // --- 静态文件 ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const file = resolveFile(pathname);

  if (!file) {
    const notFound = join(DIST, '404.html');
    if (existsSync(notFound)) {
      const stats = statSync(notFound);
      res.writeHead(404, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(stats.size),
        'cache-control': 'no-store',
      });
      createReadStream(notFound).pipe(res);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404\n');
    }
    return;
  }

  sendRange(req, res, file, statSync(file));
});

server.listen(PORT, HOST, () => {
  console.log(`▲ 备用出口已启动  http://${HOST}:${PORT}`);
  console.log(`  静态目录: ${DIST}`);
  console.log(`  计数落盘: ${DATA_FILE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
