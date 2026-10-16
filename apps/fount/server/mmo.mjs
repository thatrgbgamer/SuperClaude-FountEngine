#!/usr/bin/env node
// The online server for top-down games: one process, many instances.
//
//   node server/mmo.mjs --root . --port 8099
//
// It serves the game's files over HTTP and runs the shared world over
// WebSocket on the same port, so a player opens the address and plays. The
// server is authoritative: it simulates abilities, monsters, projectiles and
// damage itself, and clients send only intents. See
// .claude/skills/fount-gamedev/references/multiplayer.md.
//
// (The older server.mjs serves first-person games and is unchanged.)

import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { attachWebSocketServer } from './websocket.mjs';
import { GameData } from './gamedata.mjs';
import { InstanceManager } from './instances.mjs';
import { createStaticHandler } from './static.mjs';
import { createStore } from './store.mjs';
import { Auth } from './auth.mjs';
import { CharacterService, Persistence, CharacterError } from './characters.mjs';
import { createApi } from './api.mjs';
import { Economy } from '../engine/economy.js';
import { Social } from './social.mjs';
import { Admin } from './admin.mjs';
import { makeBackup, restoreBackup } from './backup.mjs';
import { LIMITS, COMMAND_HZ, PROTOCOL_VERSION, parseHello, parseCommand, parseAbility, parseInteract, parsePing, reject } from '../engine/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  root: path.resolve(HERE, '..'),
  port: 8099,
  host: '0.0.0.0',
  name: 'Fount Server',
  config: 'game/game.json',
  maxPlayers: 200,
  startMap: null,
  allowMapChoice: false,        // dev and tests only: lets a client name the map it joins
  reconnectGraceSeconds: 20,
  defaultCap: 30,
  serveFiles: true,
  quiet: false,
  // Accounts. 'none': anyone may join as a guest (nothing is saved): fine for development.
  // 'optional': guests and logged-in players. 'required': a login and a character to play.
  auth: 'none',
  store: null,                  // a Store, or { kind, path }; default is a database under <root>/data
  authOptions: {},
  trustProxy: false,            // honour X-Forwarded-For (only behind a proxy you control)
  corsOrigin: null,             // origin(s) allowed to call /api from another site
  apiRateLimit: 120,            // /api requests per address per minute
  // Operating the server.
  adminToken: null,             // at least 16 characters turns on POST /admin; also guards /metrics. Never put it in a client.
  console: false,               // read admin commands from stdin (the CLI turns this on when run from a terminal)
  backupDir: null,              // default <root>/data/backups
  backupIntervalMinutes: 60,    // 0 turns scheduled backups off
  backupKeep: 14,
  logJson: false,               // one JSON object per log line, for log shippers
};

const MAX_MESSAGES_PER_SECOND = 240;

/**
 * Start a server. Resolves to a handle: { port, manager, gameData, close() }.
 * Pass port 0 to let the OS pick one (the tests do).
 */
export async function startServer(userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const log = options.quiet ? () => {}
    : options.logJson ? (text, fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: text, ...fields }))
    : (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
  if (options.adminToken && String(options.adminToken).length < 16) throw new Error('adminToken must be at least 16 characters.');
  const stats = { bytesOut: 0, msgsIn: 0, kicks: 0, joins: 0, rejected: 0 };
  let admin = null;

  const gameData = new GameData(options.root, log);
  await gameData.loadConfig(options.config);
  const startMap = options.startMap || gameData.config.server?.startMap || gameData.config.startMap;
  if (!startMap) throw new Error('No start map. Set "server": { "startMap": "game/maps/hub.json" } in the game config, or pass --start-map.');
  if (!gameData.mapExists(startMap)) throw new Error(`The start map "${startMap}" does not exist under ${options.root}`);

  const manager = new InstanceManager({
    gameData, log,
    options: { defaultCap: options.defaultCap, reconnectGraceSeconds: options.reconnectGraceSeconds, interest: options.interest },
  });

  // ---- accounts, characters and the economy ----------------------------------------

  let store = null, auth = null, characters = null, persistence = null, api = null;
  const accountsOn = options.auth !== 'none';
  if (accountsOn || options.store) {
    store = options.store && typeof options.store.createAccount === 'function'
      ? options.store
      : await createStore({ path: path.join(options.root, 'data'), ...(options.store || {}) });
    auth = new Auth(store, options.authOptions);
    characters = new CharacterService({ store, gameData, manager, log });
    persistence = new Persistence({ store, gameData, manager, log, intervalSeconds: gameData.config.server?.autosaveSeconds ?? 45 });
    persistence.start();
    api = createApi({ auth, characters, store, trustProxy: options.trustProxy, corsOrigin: options.corsOrigin, rateLimit: options.apiRateLimit, log });
    log(`accounts: ${options.auth}, store ${store.info().kind}${store.info().path ? ` at ${store.info().path}` : ''}`);
  }
  // Every gold change is written to the ledger when there is a character to credit it to.
  manager.economy = new Economy({
    goldField: gameData.config.server?.goldField,
    sink: (tx) => {
      if (!store || !tx.character) return;
      store.addTransaction({ characterId: tx.character.id, kind: tx.kind, delta: tx.delta, balance: tx.balance, reason: tx.reason, meta: tx.meta, ts: tx.ts })
        .catch((err) => log(`could not log a transaction: ${err.message}`));
    },
  });
  const social = new Social({ manager, gameData, store, log });
  manager.social = social;
  social.start();
  const dataDir = path.join(options.root, 'data');
  const backupDir = options.backupDir ? path.resolve(options.backupDir) : path.join(dataDir, 'backups');
  admin = new Admin({
    manager, social, auth, store, persistence, gameData, log, backupDir, backupKeep: options.backupKeep,
    statusFn: () => status(),
    requestExit: () => { if (options.onExit) options.onExit(); else handle.close(); },
  });
  let backupTimer = null;
  if (store && options.backupIntervalMinutes > 0 && store.info().kind !== 'memory') {
    backupTimer = setInterval(() => {
      makeBackup(store, backupDir, options.backupKeep).then((f) => log(`backup written: ${f}`)).catch((err) => log(`backup failed: ${err.message}`));
    }, options.backupIntervalMinutes * 60000);
    backupTimer.unref?.();
  }
  const loggingIn = new Set();

  const sessions = new Set();
  let nextPlayer = 1;
  const startedAt = Date.now();
  const serveFiles = options.serveFiles ? createStaticHandler(options.root) : (req, res) => res.writeHead(404).end();

  // ---- operations: /metrics and /admin ---------------------------------------------

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const hasToken = (req) => {
    const h = String(req.headers.authorization || '');
    return !!options.adminToken && h.startsWith('Bearer ') && crypto.timingSafeEqual(sha(h.slice(7).trim()), sha(options.adminToken));
  };
  const adminHits = new Map();
  function metricsText() {
    const st = status();
    const lines = [];
    const g = (name, help, value, labels = '') => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`); };
    g('fount_players', 'Players currently in the world', st.players);
    g('fount_instances', 'Running map instances', st.instances.length);
    g('fount_uptime_seconds', 'Seconds since the server started', st.uptimeSeconds);
    g('fount_tick_ms', 'Time to run one world tick, milliseconds', st.tick.lastMs, '{stat="last"}');
    lines.push(`fount_tick_ms{stat="avg"} ${st.tick.avgMs}`, `fount_tick_ms{stat="max"} ${st.tick.maxMs}`);
    g('fount_tick_budget_used', 'Fraction of the tick budget (33 ms) used by the average tick', Math.round((st.tick.avgMs / (1000 / COMMAND_HZ)) * 1000) / 1000);
    g('fount_parties', 'Active parties', social.parties.size);
    lines.push('# TYPE fount_bytes_sent_total counter', `fount_bytes_sent_total ${stats.bytesOut}`);
    lines.push('# TYPE fount_messages_received_total counter', `fount_messages_received_total ${stats.msgsIn}`);
    lines.push('# TYPE fount_joins_total counter', `fount_joins_total ${stats.joins}`);
    lines.push('# TYPE fount_kicks_total counter', `fount_kicks_total ${stats.kicks}`);
    if (persistence) {
      lines.push('# TYPE fount_saves_total counter', `fount_saves_total ${persistence.saves}`);
      lines.push('# TYPE fount_save_failures_total counter', `fount_save_failures_total ${persistence.failures}`);
    }
    lines.push('# TYPE fount_instance_players gauge');
    for (const i of st.instances) lines.push(`fount_instance_players{instance="${i.id}",map="${i.map}"} ${i.players}`);
    lines.push('# TYPE fount_instance_tick_ms gauge');
    for (const i of st.instances) lines.push(`fount_instance_tick_ms{instance="${i.id}"} ${i.tickMs}`);
    return lines.join('\n') + '\n';
  }

  async function ops(req, res) {
    if (req.url === '/metrics') {
      if (!(isLocal(req) || hasToken(req))) { res.writeHead(403).end('metrics are for localhost or the admin token'); return true; }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metricsText());
      return true;
    }
    if (req.url === '/admin' && req.method === 'POST') {
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (!options.adminToken) return send(404, { error: 'The admin API is off.' }), true;
      const addr = req.socket.remoteAddress || '';
      const now = Date.now();
      const hit = adminHits.get(addr) || { t: now, n: 0 };
      if (now - hit.t > 60000) { hit.t = now; hit.n = 0; }
      hit.n++; adminHits.set(addr, hit);
      if (hit.n > 60) return send(429, { error: 'Slow down.' }), true;
      if (!hasToken(req)) { log(`admin: refused a request from ${addr}`); return send(401, { error: 'Bad token.' }), true; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8192) return send(413, { error: 'Too large.' }), true; }
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { return send(400, { error: 'Send JSON.' }), true; }
      const line = typeof msg.line === 'string' ? msg.line : [msg.command, ...(Array.isArray(msg.args) ? msg.args.map((a) => JSON.stringify(String(a))) : [])].join(' ');
      send(200, await admin.run(line, `http:${addr}`));
      return true;
    }
    return false;
  }

  const httpServer = http.createServer(async (req, res) => {
    if (await ops(req, res)) return;
    if (api && await api(req, res)) return;
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status()));
      return;
    }
    serveFiles(req, res);
  });

  function status() {
    return {
      name: options.name, protocol: PROTOCOL_VERSION,
      players: manager.playerCount, maxPlayers: options.maxPlayers,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      tick: { hz: COMMAND_HZ, lastMs: round(manager.stats.tickMsLast), avgMs: round(manager.stats.tickMsAvg), maxMs: round(manager.stats.tickMsMax) },
      instances: [...manager.instances.values()].map((i) => ({ id: i.id, map: i.mapPath, policy: i.policy, players: i.players.length, cap: i.cap, tickMs: round(i.lastTickMs) })),
    };
  }

  // ---- connections ------------------------------------------------------------

  const ws = attachWebSocketServer(httpServer, (connection) => {
    if (sessions.size >= options.maxPlayers) { connection.send(JSON.stringify(reject('The server is full.'))); connection.close(4000, 'server full'); return; }
    const session = {
      playerId: `p${nextPlayer++}`,
      connection, player: null, instance: null, hello: null, joining: false,
      msgWindow: 0, msgCount: 0, intentWindow: 0, intentCount: 0, violations: 0,
      send(msg) {
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
        connection.send(text);
        stats.bytesOut += text.length;
        return text.length;
      },
      kick(reason, code = 4001) { stats.kicks++; this.send({ t: 'kick', reason }); connection.close(code, reason); },
    };
    sessions.add(session);
    // A client that never says hello is not a client.
    const helloTimer = setTimeout(() => { if (!session.hello) session.kick('No hello received.', 4002); }, 8000);
    helloTimer.unref?.();

    connection.on('message', (raw) => onMessage(session, raw));
    connection.on('close', () => {
      clearTimeout(helloTimer);
      sessions.delete(session);
      manager.disconnect(session);
    });
  });

  function onMessage(session, raw) {
    if (typeof raw !== 'string') return;                                  // binary frames are not part of this protocol
    if (raw.length > LIMITS.maxMessageBytes) { session.kick('Message too large.', 4009); return; }
    stats.msgsIn++;
    const now = performance.now();
    if (now - session.msgWindow > 1000) { session.msgWindow = now; session.msgCount = 0; }
    if (++session.msgCount > MAX_MESSAGES_PER_SECOND) { session.kick('Too many messages.', 4008); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'hello') {
      if (!session.hello && !session.joining) handleHello(session, msg);
      return;
    }
    const player = session.player;
    if (!player) return;
    const inst = player.instance;

    switch (msg.t) {
      case 'i': {
        if (now - session.intentWindow > 1000) { session.intentWindow = now; session.intentCount = 0; }
        if (++session.intentCount > LIMITS.maxIntentsPerSecond) return;   // excess commands are dropped, not queued
        const cmd = parseCommand(msg);
        if (cmd) player.enqueue(cmd);
        break;
      }
      case 'ab': { const a = parseAbility(msg); if (a) inst.handleAbility(player, a); break; }
      case 'ia': { const a = parseInteract(msg); if (a) inst.handleInteract(player, a); break; }
      case 'ping': { const p = parsePing(msg); if (p) session.send({ t: 'pong', c: p.c, s: Math.round(manager.nowMs()) }); break; }
      case 'chat': case 'party': case 'social': case 'emote': case 'pvp': social.handle(player, msg); break;
      default:
        gameData.callHook('message', session, player, msg);
    }
  }

  async function handleHello(session, msg) {
    if (admin && admin.shuttingDown) { stats.rejected++; session.send(reject('The server is restarting. Please try again in a minute.')); session.connection.close(4010, 'restarting'); return; }
    const { hello, error } = parseHello(msg);
    if (error) { session.send(reject(error)); session.connection.close(4005, 'bad hello'); return; }
    session.hello = hello;
    session.joining = true;
    try {
      const expected = gameData.config.name || gameData.config.game;
      if (expected && hello.game && hello.game !== expected) {
        session.send(reject(`This server runs "${expected}", but you are playing "${hello.game}".`));
        session.connection.close(4006, 'wrong game');
        return;
      }

      // Reconnecting: a valid resume token puts the player straight back where they were.
      if (hello.resume && manager.resume(session, hello.resume)) { session.joining = false; return; }

      // Logged in: the token names the account, the hello names the character, and the character decides who they are.
      if (accountsOn && (options.auth === 'required' || hello.token)) {
        await handleAccountJoin(session, hello);
        return;
      }

      // Which map: the game's start map. A client choosing its own map is a development convenience.
      let mapPath = startMap;
      if (options.allowMapChoice && hello.map && gameData.mapExists(hello.map)) mapPath = hello.map;

      const name = uniqueName(hello.name || `Player${session.playerId.slice(1)}`);
      const config = { ...(gameData.callHook('playerConfig', { name, class: hello.class, hello }) || {}), name };
      await manager.join(session, { mapPath, config });
      stats.joins++; log(`${name} joined ${session.instance.id} (${manager.playerCount} online)`);
    } catch (err) {
      log(`join failed: ${err.stack || err.message}`);
      session.send(reject('Could not join the game: ' + err.message));
      session.connection.close(4007, 'join failed');
    } finally {
      session.joining = false;
    }
  }

  async function handleAccountJoin(session, hello) {
    const account = options.authenticator
      ? await options.authenticator(hello).then((r) => (r && r.accountName ? store.findAccount(r.accountName) : null))
      : await auth.verifyToken(hello.token);
    if (!account) { session.send(reject('Please log in.')); session.connection.close(4010, 'login required'); return; }
    const charId = /^[1-9]\d{0,12}$/.test(hello.character) ? Number(hello.character) : NaN;
    if (!Number.isInteger(charId)) { session.send(reject('Choose a character to play.')); session.connection.close(4011, 'no character'); return; }
    if (loggingIn.has(charId)) { session.send(reject('That character is already logging in.')); session.connection.close(4012, 'busy'); return; }
    loggingIn.add(charId);
    try {
      const online = manager.playerForCharacter(charId);
      if (online && online.disconnectedAt !== null) {
        // Their connection dropped and the body is still in the world: this is them coming back.
        const owner = await store.getCharacter(charId);
        if (owner && owner.accountId === account.id && manager.resumeCharacter(session, charId)) return;
      } else if (online) {
        session.send(reject('That character is already in the game.'));
        session.connection.close(4013, 'already online');
        return;
      }
      const c = await characters.forJoin(account, charId);
      const pos = c.record.position;
      const mapPath = pos && gameData.mapExists(pos.map) ? pos.map : startMap;
      const config = { ...(gameData.callHook('playerConfig', { name: c.name, class: c.class, record: c.record, character: c }) || {}), name: c.name };
      await manager.join(session, {
        mapPath, config, carry: c.record.snapshot,
        feet: pos && mapPath === pos.map ? pos.feet : undefined, yaw: pos ? pos.yaw : undefined,
        character: { id: c.id, accountId: c.accountId, name: c.name },
      });
      stats.joins++; log(`${c.name} (account ${account.name}) joined ${session.instance.id} (${manager.playerCount} online)`);
    } catch (err) {
      const known = err instanceof CharacterError;
      if (!known) log(`join failed: ${err.stack || err.message}`);
      session.send(reject(known ? err.message : 'Could not join the game: ' + err.message));
      session.connection.close(4007, 'join failed');
    } finally {
      loggingIn.delete(charId);
    }
  }

  function uniqueName(want) {
    const taken = new Set();
    for (const i of manager.instances.values()) for (const p of i.players) taken.add(p.actor.name);
    if (!taken.has(want)) return want;
    for (let n = 2; ; n++) { const alt = `${want.slice(0, 17)}#${n}`; if (!taken.has(alt)) return alt; }
  }

  // ---- the clock ----------------------------------------------------------------

  const tickMs = 1000 / COMMAND_HZ;
  let nextTick = performance.now();
  let timer = null;
  let stopped = false;
  function loop() {
    if (stopped) return;
    const now = performance.now();
    let ran = 0;
    // Catch up if a tick ran long, but never spiral: after a few, skip ahead.
    while (now >= nextTick && ran < 4) { manager.tickAll(); nextTick += tickMs; ran++; }
    if (ran === 4) nextTick = performance.now() + tickMs;
    timer = setTimeout(loop, Math.max(0, nextTick - performance.now()));
  }
  loop();

  await new Promise((resolve, reject2) => {
    httpServer.once('error', reject2);
    httpServer.listen(options.port, options.host, resolve);
  });
  const port = httpServer.address().port;
  log(`${options.name}: http://localhost:${port}/  (${startMap})`);

  const handle = {
    port, manager, gameData, options, sessions, status, store, auth, characters, persistence, admin, stats,
    economy: manager.economy, social,
    async close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(backupTimer);
      if (admin.shuttingDown) clearTimeout(admin.shuttingDown.timer);
      ws.stop();
      social.stop();
      // Everyone's character is on disk before the doors close.
      if (persistence) { await persistence.saveAll('shutdown'); persistence.stop(); }
      for (const s of sessions) { try { s.connection.close(1001, 'server shutting down'); } catch { /* gone */ } }
      await new Promise((resolve) => httpServer.close(resolve));
      if (store) await store.close();
    },
  };
  return handle;
}

const round = (n) => Math.round(n * 100) / 100;

// ---- command line -----------------------------------------------------------------

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--root') o.root = path.resolve(next());
    else if (a === '--port' || a === '-p') o.port = parseInt(next(), 10);
    else if (a === '--host') o.host = next();
    else if (a === '--name' || a === '-n') o.name = next();
    else if (a === '--config') o.config = next();
    else if (a === '--start-map') o.startMap = next();
    else if (a === '--max') o.maxPlayers = parseInt(next(), 10);
    else if (a === '--cap') o.defaultCap = parseInt(next(), 10);
    else if (a === '--allow-map-choice') o.allowMapChoice = true;
    else if (a === '--auth') o.auth = next();
    else if (a === '--store') o.store = { kind: next() };
    else if (a === '--data') o.store = { ...(o.store || {}), path: path.resolve(next()) };
    else if (a === '--trust-proxy') o.trustProxy = true;
    else if (a === '--server-config') o.serverConfig = path.resolve(next());
    else if (a === '--admin-token') o.adminToken = next();
    else if (a === '--console') o.console = true;
    else if (a === '--log-json') o.logJson = true;
    else if (a === '--backup-dir') o.backupDir = path.resolve(next());
    else if (a === '--backup-minutes') o.backupIntervalMinutes = parseFloat(next());
    else if (a === '--backup-keep') o.backupKeep = parseInt(next(), 10);
    else if (a === '--restore') o.restore = path.resolve(next());
    else if (a === '--help' || a === '-h') {
      console.log(`Fount online server

  node server/mmo.mjs [options]

  --root <dir>        The game folder to serve and simulate (default: the folder above server/)
  --config <file>     Game config, relative to the root (default game/game.json)
  --port, -p <n>      Port (default 8099)
  --host <addr>       Bind address (default 0.0.0.0)
  --name, -n <s>      Server name
  --start-map <path>  Map new players start in (default: "server.startMap" in the config)
  --max <n>           Maximum connected players (default 200)
  --cap <n>           Default players per instance, when a map does not say (default 30)
  --auth <mode>       none (guests, nothing saved) | optional | required (login + character)
  --store <kind>      auto | sqlite | file | memory (default auto)
  --data <path>       Where the store lives (default <root>/data)
  --trust-proxy       Believe X-Forwarded-For (only behind a proxy you run)
  --server-config <f> A JSON file of these options (flags and FOUNT_* variables override it)
  --admin-token <s>   16+ characters: turns on POST /admin and protects /metrics (or set FOUNT_ADMIN_TOKEN)
  --console           Read admin commands from this terminal (on by default when it is a terminal)
  --log-json          One JSON object per log line
  --backup-dir <dir>  Where backups go (default <root>/data/backups)
  --backup-minutes <n>  Backup interval; 0 turns scheduled backups off (default 60)
  --backup-keep <n>   How many backups to keep (default 14)
  --restore <backup>  Put a backup in place as the store, then exit. Stop the server first.

  Environment: FOUNT_PORT FOUNT_HOST FOUNT_ROOT FOUNT_NAME FOUNT_CONFIG FOUNT_AUTH FOUNT_STORE FOUNT_DATA
               FOUNT_MAX_PLAYERS FOUNT_ADMIN_TOKEN FOUNT_LOG_JSON FOUNT_TRUST_PROXY FOUNT_BACKUP_MINUTES FOUNT_BACKUP_KEEP
`);
      process.exit(0);
    }
  }
  return o;
}

/** Options from the environment, for containers and service managers. */
export function optionsFromEnv(env = process.env) {
  const o = {};
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const flag = (v) => v === '1' || v === 'true';
  if (env.FOUNT_ROOT) o.root = path.resolve(env.FOUNT_ROOT);
  if (env.FOUNT_PORT) o.port = num(env.FOUNT_PORT);
  if (env.FOUNT_HOST) o.host = env.FOUNT_HOST;
  if (env.FOUNT_NAME) o.name = env.FOUNT_NAME;
  if (env.FOUNT_CONFIG) o.config = env.FOUNT_CONFIG;
  if (env.FOUNT_AUTH) o.auth = env.FOUNT_AUTH;
  if (env.FOUNT_STORE) o.store = { kind: env.FOUNT_STORE };
  if (env.FOUNT_DATA) o.store = { ...(o.store || {}), path: path.resolve(env.FOUNT_DATA) };
  if (env.FOUNT_MAX_PLAYERS) o.maxPlayers = num(env.FOUNT_MAX_PLAYERS);
  if (env.FOUNT_ADMIN_TOKEN) o.adminToken = env.FOUNT_ADMIN_TOKEN;
  if (env.FOUNT_LOG_JSON) o.logJson = flag(env.FOUNT_LOG_JSON);
  if (env.FOUNT_TRUST_PROXY) o.trustProxy = flag(env.FOUNT_TRUST_PROXY);
  if (env.FOUNT_BACKUP_MINUTES) o.backupIntervalMinutes = num(env.FOUNT_BACKUP_MINUTES);
  if (env.FOUNT_BACKUP_KEEP) o.backupKeep = num(env.FOUNT_BACKUP_KEEP);
  return o;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  let fromFile = {};
  if (flags.serverConfig) fromFile = JSON.parse(fs.readFileSync(flags.serverConfig, 'utf8'));
  const options = { ...fromFile, ...optionsFromEnv(), ...flags };
  const root = options.root || DEFAULTS.root;

  if (options.restore) {
    const dataDir = (options.store && options.store.path) || path.join(root, 'data');
    const target = restoreBackup({ backup: options.restore, dataDir });
    console.log(`Restored ${options.restore} to ${target}. The previous data was kept beside it as ".before-restore-*".`);
    return;
  }

  const interactive = options.console ?? process.stdin.isTTY;
  let handle = null;
  let closing = false;
  const exit = async (why) => {
    if (closing) return;
    closing = true;
    console.log(`\n${why}: saving and shutting down...`);
    try { if (handle) await handle.close(); } catch (err) { console.error(err.message); }
    process.exit(0);
  };
  options.onExit = () => exit('Scheduled shutdown');
  handle = await startServer(options);

  // Ctrl-C and `docker stop`/systemd send these: warn, save everyone, then go. A second signal does not hurry it.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => exit(sig));

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'fount> ' });
    rl.on('line', async (line) => { const r = await handle.admin.run(line, 'console'); if (r.text) console.log(r.text); rl.prompt(); });
    rl.on('close', () => { /* stdin closed: keep serving */ });
    rl.prompt();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nCould not start the server: ${err.message}\n`);
    process.exit(1);
  });
}
