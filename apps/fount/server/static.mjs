// Serving a game's files over HTTP: the page, the engine, the maps. A player
// opens the server's address and gets the game; the same port carries the
// WebSocket.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Files that must never be served even though they live under the game folder:
// the account and character store, saves, and anything that looks like a secret.
const PRIVATE = [/(^|\/)\.[^/]+/, /(^|\/)data\//, /(^|\/)node_modules\//, /\.(db|sqlite|sqlite3|log|key|pem)$/i, /(^|\/)server\//];

export function createStaticHandler(root) {
  const base = path.resolve(root);
  return function serveStatic(req, res) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end('Bad request'); return; }
    if (pathname === '/') pathname = '/index.html';

    // Resolve inside the root and verify: without this, ../../etc/passwd is servable.
    const filePath = path.resolve(base, '.' + pathname);
    if (filePath !== base && !filePath.startsWith(base + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
    const rel = path.relative(base, filePath).split(path.sep).join('/');
    if (PRIVATE.some((re) => re.test(rel))) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  };
}
