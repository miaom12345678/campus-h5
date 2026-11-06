/**
 * 本地开发服务器（零依赖）
 * 用法：npm run dev  →  http://localhost:3000
 * 同时托管 public/ 静态资源与 /api/* 接口（api/handler.js），
 * 数据落盘到 .data/db.json，与线上 Vercel 行为一致。
 */
import http from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import handler from './api/handler.js';

const PORT = process.env.PORT || 3000;
const ROOT = join(process.cwd(), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    // 兼容 Vercel 风格的 res.status().json()
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(o));
    };
    return handler(req, res);
  }

  try {
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = join(ROOT, p);
    const s = await stat(file).catch(() => null);
    const target = s && s.isFile() ? file : join(ROOT, 'index.html'); // hash 路由兜底
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log('校园失物招领 H5 已启动 → http://localhost:' + PORT);
});
