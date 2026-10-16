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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { attachWebSocketServer } from './websocket.mjs';
import { GameData } from './gamedata.mjs';
import { InstanceManager } from './instances.mjs';
import { createStaticHandler } from './static.mjs';
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
};

const MAX_MESSAGES_PER_SECOND = 240;

/**
 * Start a server. Resolves to a handle: { port, manager, gameData, close() }.
 * Pass port 0 to let the OS pick one (the tests do).
 */
export async function startServer(userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const log = options.quiet ? () => {} : (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

  const gameData = new GameData(options.root, log);
  await gameData.loadConfig(options.config);
  const startMap = options.startMap || gameData.config.server?.startMap || gameData.config.startMap;
  if (!startMap) throw new Error('No start map. Set "server": { "startMap": "game/maps/hub.json" } in the game config, or pass --start-map.');
  if (!gameData.mapExists(startMap)) throw new Error(`The start map "${startMap}" does not exist under ${options.root}`);

  const manager = new InstanceManager({
    gameData, log,
    options: { defaultCap: options.defaultCap, reconnectGraceSeconds: options.reconnectGraceSeconds, interest: options.interest },
  });

  const sessions = new Set();
  let nextPlayer = 1;
  const startedAt = Date.now();
  const serveFiles = options.serveFiles ? createStaticHandler(options.root) : (req, res) => res.writeHead(404).end();

  const httpServer = http.createServer((req, res) => {
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
      send(msg) { connection.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
      kick(reason, code = 4001) { this.send({ t: 'kick', reason }); connection.close(code, reason); },
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
      default:
        gameData.callHook('message', session, player, msg);
    }
  }

  async function handleHello(session, msg) {
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

      // Which map: the game's start map. A client choosing its own map is a development convenience.
      let mapPath = startMap;
      if (options.allowMapChoice && hello.map && gameData.mapExists(hello.map)) mapPath = hello.map;

      const name = uniqueName(hello.name || `Player${session.playerId.slice(1)}`);
      const config = { ...(gameData.callHook('playerConfig', { name, class: hello.class, hello }) || {}), name };
      await manager.join(session, { mapPath, config });
      log(`${name} joined ${session.instance.id} (${manager.playerCount} online)`);
    } catch (err) {
      log(`join failed: ${err.stack || err.message}`);
      session.send(reject('Could not join the game: ' + err.message));
      session.connection.close(4007, 'join failed');
    } finally {
      session.joining = false;
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

  return {
    port, manager, gameData, options, sessions, status,
    async close() {
      stopped = true;
      clearTimeout(timer);
      ws.stop();
      for (const s of sessions) { try { s.connection.close(1001, 'server shutting down'); } catch { /* gone */ } }
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
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
`);
      process.exit(0);
    }
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(`\nCould not start the server: ${err.message}\n`);
    process.exit(1);
  });
}
