// Minimal static server for web/. No dependencies, no build step.
//   npm run serve   →  http://localhost:5173

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('../web/', import.meta.url);
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // Resolve inside web/ and refuse anything that escapes it.
  const name = path.posix.normalize(rel === '/' ? '/index.html' : rel).replace(/^\/+/, '');
  const target = new URL(name, ROOT);
  if (!target.href.startsWith(ROOT.href)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => console.log(`j-livelist → http://localhost:${PORT}`));
