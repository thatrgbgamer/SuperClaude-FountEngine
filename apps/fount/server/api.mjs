// The HTTP API a game's login and character-select screens talk to. Account
// and character management is ordinary request/response, so it is plain JSON
// over HTTP on the same port as the game; the WebSocket is only for playing.
//
//   POST   /api/register          { name, password }            -> { token, account }
//   POST   /api/login             { name, password } | { magic } -> { token, account }
//   POST   /api/logout                                           -> { ok }
//   GET    /api/me                                               -> { account, characters }
//   POST   /api/password          { old, new }                  -> { token }
//   GET    /api/characters                                       -> { characters }
//   POST   /api/characters        { name, class }               -> { character }
//   DELETE /api/characters/:id    { confirm: "<name>" }         -> { ok }
//
// Everything after login carries the token as `Authorization: Bearer <token>`.
// Bodies are small JSON; the answer to anything wrong is a JSON { error, code }
// with a status a client can act on.

import { AuthError } from './auth.mjs';
import { CharacterError } from './characters.mjs';

const MAX_BODY = 8 * 1024;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too-large', 'That request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch { throw new HttpError(400, 'bad-json', 'The request body must be a JSON object.'); }
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

const publicAccount = (a) => ({ id: a.id, name: a.name, created: a.created });

/**
 * Returns handle(req, res) -> boolean: true if the request was an API request it answered.
 * deps: { auth, characters, store, trustProxy, corsOrigin }
 */
export function createApi({ auth, characters, store, trustProxy = false, corsOrigin = null, rateLimit = 120, log = () => {} }) {
  // A little throttle on the API as a whole, apart from the login limits: a request flood costs nothing to the store.
  const buckets = new Map();
  const allowed = (key) => {
    const now = Date.now();
    const b = buckets.get(key) || { t: now, n: 0 };
    if (now - b.t > 60000) { b.t = now; b.n = 0; }
    b.n++;
    buckets.set(key, b);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.t > 60000) buckets.delete(k);
    return b.n <= rateLimit;     // requests per address per minute
  };

  const addressOf = (req) => {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  };

  function send(req, res, status, body, extra = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra };
    if (corsOrigin) {
      const origin = req.headers.origin;
      const list = [].concat(corsOrigin);
      if (list.includes('*')) headers['Access-Control-Allow-Origin'] = '*';
      else if (origin && list.includes(origin)) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    }
    res.writeHead(status, headers);
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  async function route(req, res, url) {
    const address = addressOf(req);
    const method = req.method;
    const p = url.pathname;

    if (p === '/api/register' && method === 'POST') {
      const b = await readJson(req);
      const { account, token } = await auth.register(b.name, b.password, address);
      return send(req, res, 201, { token, account: publicAccount(account) });
    }
    if (p === '/api/login' && method === 'POST') {
      const b = await readJson(req);
      const { account, token } = b.magic ? await auth.loginWithMagic(b.magic, address) : await auth.login(b.name, b.password, address);
      return send(req, res, 200, { token, account: publicAccount(account) });
    }

    // Everything below needs a session.
    const token = bearer(req);
    const account = await auth.verifyToken(token);
    if (!account) throw new HttpError(401, 'login-required', 'Please log in.');

    if (p === '/api/logout' && method === 'POST') { await auth.logout(token); return send(req, res, 200, { ok: true }); }
    if (p === '/api/me' && method === 'GET') return send(req, res, 200, { account: publicAccount(account), characters: await characters.list(account) });
    if (p === '/api/password' && method === 'POST') {
      const b = await readJson(req);
      return send(req, res, 200, { token: await auth.changePassword(account, b.old, b.new) });
    }
    if (p === '/api/characters' && method === 'GET') return send(req, res, 200, { characters: await characters.list(account) });
    if (p === '/api/characters' && method === 'POST') {
      const b = await readJson(req);
      return send(req, res, 201, { character: await characters.create(account, { name: b.name, class: b.class }) });
    }
    const m = /^\/api\/characters\/(\d+)$/.exec(p);
    if (m && method === 'DELETE') {
      const b = await readJson(req);
      await characters.remove(account, Number(m[1]), b.confirm);
      return send(req, res, 200, { ok: true });
    }
    throw new HttpError(404, 'not-found', 'No such endpoint.');
  }

  return async function handle(req, res) {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/status')) return false;
    if (req.method === 'OPTIONS' && corsOrigin) { send(req, res, 204); return true; }
    const url = new URL(req.url, 'http://localhost');
    if (!allowed(addressOf(req))) { send(req, res, 429, { error: 'Slow down.', code: 'rate-limited' }); return true; }
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof AuthError) {
        const status = { throttled: 429, 'bad-login': 401, banned: 403, closed: 403, 'name-taken': 409 }[err.code] || 400;
        send(req, res, status, { error: err.message, code: err.code, retryAfter: err.retryAfter }, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
      } else if (err instanceof CharacterError) {
        const status = { 'name-taken': 409, 'not-yours': 404, online: 409, 'too-many': 409 }[err.code] || 400;
        send(req, res, status, { error: err.message, code: err.code });
      } else if (err instanceof HttpError) {
        send(req, res, err.status, { error: err.message, code: err.code });
      } else {
        log(`api error: ${err.stack || err.message}`);
        send(req, res, 500, { error: 'Something went wrong on the server.', code: 'server-error' });
      }
    }
    return true;
  };
}
