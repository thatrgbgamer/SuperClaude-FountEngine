#!/usr/bin/env node
// Fount multiplayer server: serves the game over HTTP and runs the session
// over WebSocket. Node stdlib only — no npm install, no dependencies.
//
//   node server/server.mjs
//   node server/server.mjs --port 8080 --name "My Server" --map game/maps/dm_crucible.json
//
// Trust model, stated plainly because it governs what this is safe for. The
// server loads the map and shares the engine's own collision code, so it checks
// what it can actually check: it owns health, damage, death and scoring, it
// validates every shot and every hit against real geometry with lag
// compensation, and it rejects movement that runs through walls. What it does
// NOT do is simulate movement from inputs — it validates the positions clients
// report and corrects them when they are impossible. See anticheat.mjs and the
// README's trust model section for where that line sits.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './websocket.mjs';
import { buildMap } from '../engine/map.js';
import { AntiCheat, PRESETS, newPlayerState } from './anticheat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  // map stays null until resolveStartMap picks one, so we can tell "the user
  // asked for this map" (a typo should be fatal) from "nobody said" (find one).
  const args = {
    port: 8099, name: 'Fount Server', map: null, maxPlayers: 16, host: '0.0.0.0',
    anticheat: 'normal', cheats: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') args.port = parseInt(next(), 10);
    else if (a === '--name' || a === '-n') args.name = next();
    else if (a === '--map' || a === '-m') args.map = next();
    else if (a === '--max' ) args.maxPlayers = parseInt(next(), 10);
    else if (a === '--host') args.host = next();
    else if (a === '--anticheat') args.anticheat = String(next() || '').toLowerCase();
    else if (a === '--cheats') args.cheats = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`
Fount multiplayer server

  node server/server.mjs [options]

  --port, -p <n>     Port to listen on (default 8099)
  --name, -n <s>     Server name shown to players
  --map,  -m <path>  Starting map (default: the first one in game/maps/)
  --max <n>          Maximum players (default 16)
  --host <addr>      Bind address (default 0.0.0.0, all interfaces)
  --anticheat <lvl>  off | lenient | normal | strict (default normal)
  --cheats           Allow clients to use noclip/god/give (off by default)
  --verbose, -v      Log every anticheat flag, not just warnings

Once running, type admin commands directly into this terminal.
Type "help" there for the list.
`);
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Resolve inside ROOT and verify: without this, ../../etc/passwd is servable.
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const TICK_MS = 50;                 // 20Hz snapshots
const INPUT_RATE_LIMIT = 40;        // client position updates per second
const CHAT_RATE_LIMIT = 4;          // messages per 5 seconds
const SHOT_RATE_LIMIT = 15;         // hard ceiling; the weapon cooldown is finer
const INTERP_DELAY_MS = 100;        // must match engine/net.js, for lag compensation
const RESPAWN_DELAY_MS = 2400;      // the client waits 2.5s; allow a little early
const MAX_HEALTH = 100;

function mapExists(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const full = path.resolve(ROOT, rel);
  // Same containment rule the static server uses: a map path is a client-
  // supplied path too once an admin can set it.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return false;
  return fs.existsSync(full) && fs.statSync(full).isFile();
}

// Pick the map to start on. A scaffolded game has its own levels and no
// dm_crucible, so defaulting to a hard-coded name would hand every client a
// 404 on join; look at what is actually there instead.
function resolveStartMap(requested) {
  if (requested) {
    if (mapExists(requested)) return requested;
    console.error(`No such map: ${requested}`);
    console.error(`Looked in ${path.resolve(ROOT, requested)}`);
    process.exit(1);
  }
  const preferred = 'game/maps/dm_crucible.json';
  if (mapExists(preferred)) return preferred;
  const dir = path.join(ROOT, 'game', 'maps');
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    : [];
  if (!found.length) {
    console.error(`No maps found in ${dir}.`);
    console.error('Add a level there, or pass --map <path>.');
    process.exit(1);
  }
  return `game/maps/${found[0]}`;
}

let nextId = 1;
const players = new Map();          // id -> player
const bans = new Set();             // remote addresses
let currentMap = resolveStartMap(args.map);
const startedAt = Date.now();

// Allowing client cheats and validating movement are contradictory: noclip is
// movement through geometry by definition. So --cheats turns the movement half
// off and leaves the combat half on, which is what still protects other players.
const anticheat = new AntiCheat(args.anticheat, args.cheats ? { validateMovement: false } : {});
// Every individual flag, for tuning a server or investigating a report. Off by
// default because a busy server would drown in it.
if (args.verbose) {
  anticheat.onFlag = (player, kind, detail) => {
    log(`  flag ${kind} ${player.name}#${player.id}${detail ? ` (${detail})` : ''} score=${player.ac.score.toFixed(0)}`);
  };
}
if (!PRESETS[args.anticheat]) {
  console.error(`Unknown anticheat level "${args.anticheat}"; using normal.`);
  console.error(`Choose one of: ${Object.keys(PRESETS).join(', ')}`);
}

// The server loads the map for the same reason the client does: to collide
// against it. Sharing engine/map.js means there is one implementation of what
// is solid, so the server and an honest client never disagree.
let world = null;
let spawnPoints = [];

function loadWorld(rel) {
  const full = path.resolve(ROOT, rel);
  const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  const built = buildMap(doc);
  world = built;
  anticheat.setWorld(built);
  // info_player_start sits at foot level; a player's position is the centre
  // of a 1.8m box. Lift by the same amount the client does in loadMapDocument,
  // or a spawn puts the player half-buried in the floor and the anticheat's
  // own inside-geometry check is the first thing they hit.
  spawnPoints = (built.entities || [])
    .filter((e) => e.classname === 'info_player_start' && Array.isArray(e.origin))
    .map((e) => [e.origin[0], e.origin[1] + 1.0, e.origin[2]]);
  if (!spawnPoints.length) spawnPoints = [[0, 2, 0]];
  return built;
}

try {
  loadWorld(currentMap);
} catch (err) {
  console.error(`Could not load ${currentMap}: ${err.message}`);
  console.error('The server needs to read the map to validate movement and shots.');
  process.exit(1);
}

/** Spawn players apart from each other when the map offers the choice. */
function pickSpawn() {
  if (spawnPoints.length === 1) return [...spawnPoints[0]];
  let best = spawnPoints[0];
  let bestDist = -1;
  for (const sp of spawnPoints) {
    let nearest = Infinity;
    for (const p of players.values()) {
      if (p.dead) continue;
      nearest = Math.min(nearest, Math.hypot(sp[0] - p.pos[0], sp[1] - p.pos[1], sp[2] - p.pos[2]));
    }
    if (nearest > bestDist) { bestDist = nearest; best = sp; }
  }
  return [...best];
}

const COLORS = [
  [1.0, 0.45, 0.4], [0.45, 0.75, 1.0], [0.55, 1.0, 0.6], [1.0, 0.85, 0.4],
  [0.85, 0.55, 1.0], [1.0, 0.65, 0.85], [0.5, 0.95, 0.95], [1.0, 0.72, 0.45],
];

function sanitizeName(raw, fallback) {
  const cleaned = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 20);
  return cleaned || fallback;
}

function finiteVec(v, fallback = [0, 0, 0]) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? v.map((n) => Math.max(-10000, Math.min(10000, n)))
    : fallback;
}

function broadcast(message, exceptId = null) {
  const text = JSON.stringify(message);
  for (const p of players.values()) {
    if (p.id !== exceptId) p.connection.send(text);
  }
}

function systemNotice(text) {
  broadcast({ t: 'chat', from: null, text });
  log(text);
}

function log(text) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${text}`);
}

function playerSummary(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    pos: p.pos,
    angles: p.angles,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    dead: p.dead,
    moving: p.moving,
  };
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: args.name,
      map: currentMap,
      players: [...players.values()].map((p) => ({ name: p.name, kills: p.kills, deaths: p.deaths })),
      maxPlayers: args.maxPlayers,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }));
    return;
  }
  serveStatic(req, res);
});

attachWebSocketServer(httpServer, (connection) => {
  if (bans.has(connection.remoteAddress)) {
    connection.close(4003, 'banned');
    return;
  }
  if (players.size >= args.maxPlayers) {
    connection.close(4000, 'server full');
    return;
  }

  const id = nextId++;
  const player = {
    id,
    connection,
    name: `Player${id}`,
    color: COLORS[(id - 1) % COLORS.length],
    pos: [0, 1, 0],
    angles: [0, 0, 0],
    health: MAX_HEALTH,
    kills: 0,
    deaths: 0,
    dead: false,
    moving: false,
    admin: false,
    joinedAt: Date.now(),
    inputTimes: [],
    chatTimes: [],
    shotTimes: [],
    selfDamageTimes: [],
    diedAt: 0,
    ac: newPlayerState(),
  };
  player.pos = pickSpawn();
  anticheat.grantGrace(player, player.pos, 3000);
  players.set(id, player);

  connection.on('message', (raw) => handleMessage(player, raw));
  connection.on('close', () => {
    players.delete(id);
    broadcast({ t: 'leave', id });
    systemNotice(`${player.name} left (${players.size} online)`);
  });

  connection.send(JSON.stringify({
    t: 'welcome',
    id,
    name: player.name,
    color: player.color,
    map: currentMap,
    serverName: args.name,
    tickMs: TICK_MS,
    spawn: player.pos,
    // The client disables its own cheat commands unless the server allows them.
    // Without this, an honest player using their own console would be kicked
    // for noclipping — the anticheat cannot tell that apart from a cheat.
    cheatsAllowed: !!args.cheats,
    anticheat: anticheat.presetName,
    players: [...players.values()].filter((p) => p.id !== id).map(playerSummary),
  }));

  broadcast({ t: 'join', player: playerSummary(player) }, id);
  systemNotice(`${player.name} joined (${players.size} online)`);
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function rateLimited(times, limit, windowMs) {
  const now = Date.now();
  while (times.length && now - times[0] > windowMs) times.shift();
  if (times.length >= limit) return true;
  times.push(now);
  return false;
}

/**
 * Apply a validated hit. Health, death, scoring and the ragdoll everyone sees
 * all follow from here, so there is exactly one path by which a player can be
 * hurt and it is on the server.
 */
function applyDamage(target, attacker, resolved) {
  target.health = Math.max(0, target.health - resolved.damage);
  broadcast({
    t: 'hit',
    target: target.id,
    by: attacker ? attacker.id : null,
    damage: resolved.damage,
    health: target.health,
    point: resolved.point,
    impulse: resolved.impulse,
    headshot: !!resolved.headshot,
  });

  if (target.health > 0 || target.dead) return;

  target.dead = true;
  target.diedAt = Date.now();
  target.deaths++;
  if (attacker && attacker.id !== target.id) attacker.kills++;
  broadcast({
    t: 'kill',
    victim: target.id,
    killer: attacker ? attacker.id : null,
    point: resolved.point,
    impulse: resolved.impulse,
  });
  systemNotice(attacker && attacker.id !== target.id
    ? `${attacker.name} killed ${target.name}`
    : `${target.name} died`);
}

/**
 * Put everyone back to a clean state for a new or restarted map. Every player
 * is teleported, so each needs a grace window or the anticheat sees a server
 * full of impossible moves at once.
 */
function resetForNewMap() {
  for (const p of players.values()) {
    p.dead = false;
    p.health = MAX_HEALTH;
    p.pos = pickSpawn();
    anticheat.setAmmo(p, 30);
    anticheat.grantGrace(p, p.pos, 4000);
  }
}

// Each player gets their own spawn from resetForNewMap(), so this can't be a
// single broadcast: without the spawn every client would stand on the map's
// info_player_start, on top of each other, somewhere the server didn't pick.
function announceMap() {
  for (const p of players.values()) {
    p.connection.send(JSON.stringify({ t: 'map', map: currentMap, spawn: p.pos }));
  }
}

function respawn(player) {
  player.dead = false;
  player.health = MAX_HEALTH;
  player.pos = pickSpawn();
  anticheat.setAmmo(player, 30);
  // Without the grace window this teleport reads as a ~66m impossible move —
  // measured on the demo map, and the commonest false positive there is.
  anticheat.grantGrace(player, player.pos, 1500);
  broadcast({ t: 'respawn', id: player.id, pos: player.pos, health: player.health });
}

/**
 * Act on a player's accumulated violation score. Graduated on purpose: a single
 * anomaly is far more often a lag spike than a cheat, so one bad tick warns
 * nobody and a sustained pattern is what gets someone removed.
 */
function enforce(player, verdictBefore) {
  const verdict = anticheat.verdict(player);
  if (verdict === verdictBefore) return;

  const r = anticheat.report(player);
  if (verdict === 'warn') {
    log(`anticheat: ${player.name} (#${player.id}) score ${r.score.toFixed(0)} — ${r.kinds}`);
    for (const p of players.values()) {
      if (p.admin) p.connection.send(JSON.stringify({ t: 'cmdresult', text: `anticheat: ${player.name} score ${r.score.toFixed(0)} — ${r.kinds}` }));
    }
  } else if (verdict === 'kick') {
    log(`anticheat: kicking ${player.name} (#${player.id}) — score ${r.score.toFixed(0)}, ${r.kinds}`);
    systemNotice(`${player.name} was removed by the anticheat (${r.kinds})`);
    player.connection.close(4008, 'anticheat');
  }
}

function handleMessage(player, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // malformed input is ignored rather than crashing the server
  }
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'input': {
      if (rateLimited(player.inputTimes, INPUT_RATE_LIMIT, 1000)) return;
      const now = Date.now();

      // Latency comes from the transport's own ping/pong, never from the
      // client: a self-reported round trip is just another number a cheat
      // would inflate to widen its rewind window.
      player.ac.rtt = Math.max(0, Math.min(400, (player.connection.latencyMs || 0) * 0.5));

      player.angles = finiteVec(msg.angles, player.angles);

      const verdictBefore = anticheat.verdict(player);
      const result = anticheat.checkMove(player, finiteVec(msg.pos, player.pos), player.angles, now);
      player.pos = result.pos;
      player.moving = !!msg.moving;

      // Health, death and scoring are the server's. A client that reports its
      // own health is reporting a number nobody reads — which is the point:
      // godmode and self-resurrection are not expressible in this protocol.
      if (result.corrected) {
        player.connection.send(JSON.stringify({ t: 'correct', pos: player.pos, reason: result.reason }));
      }
      enforce(player, verdictBefore);
      return;
    }

    case 'name': {
      const next = sanitizeName(msg.name, player.name);
      if (next === player.name) return;
      const old = player.name;
      player.name = next;
      broadcast({ t: 'rename', id: player.id, name: next });
      systemNotice(`${old} is now ${next}`);
      return;
    }

    case 'shoot': {
      if (rateLimited(player.shotTimes, SHOT_RATE_LIMIT, 1000)) return;
      const origin = finiteVec(msg.origin, player.pos);
      const dir = finiteVec(msg.dir, [0, 0, 1]);
      // A shot the server rejects is not relayed at all, so a client that
      // ignores the fire rate or shoots while dead makes no noise and, because
      // hits must match an accepted shot, lands no damage either.
      const shot = anticheat.noteShot(player, origin, dir, Date.now());
      if (!shot.ok) {
        enforce(player, 'ok');
        return;
      }
      broadcast({ t: 'shoot', id: player.id, origin, dir }, player.id);
      return;
    }

    case 'hit': {
      const target = players.get(msg.target);
      if (!target || target.dead) return;

      // The client says who it hit. The server decides whether that was
      // possible — the shot must exist, the ray must reach the target where
      // the shooter could see them, and nothing solid may be in the way — and
      // then decides the damage itself. msg.damage is deliberately not read.
      const resolved = anticheat.resolveHit(player, target, msg, Date.now(), INTERP_DELAY_MS);
      if (!resolved.ok) {
        enforce(player, 'ok');
        return;
      }

      applyDamage(target, player, resolved);
      return;
    }

    case 'selfdamage': {
      // NPCs, explosions and falls are simulated on each client, so the server
      // cannot observe them. Accepting a client's word here is safe in a way
      // accepting its word about hitting someone else is not: the only thing
      // this can do is kill the sender. Capped and rate-limited anyway, so it
      // cannot be used to spam the damage broadcast.
      if (player.dead) return;
      if (rateLimited(player.selfDamageTimes, 20, 1000)) return;
      const amount = Math.max(0, Math.min(MAX_HEALTH, Number(msg.amount) || 0));
      if (!amount) return;
      applyDamage(player, null, { damage: amount, point: [...player.pos], impulse: [0, 0, 0] });
      return;
    }

    case 'respawn': {
      // The client asks; the server decides when and where. A client that
      // simply declares itself alive again is ignored, and the spawn point is
      // the server's choice so nobody respawns inside someone else.
      if (!player.dead) return;
      if (Date.now() - player.diedAt < RESPAWN_DELAY_MS) return;
      respawn(player);
      return;
    }

    case 'chat': {
      if (rateLimited(player.chatTimes, CHAT_RATE_LIMIT, 5000)) return;
      const text = String(msg.text ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
      if (!text) return;
      broadcast({ t: 'chat', from: player.name, id: player.id, text });
      log(`${player.name}: ${text}`);
      return;
    }

    case 'cmd': {
      const text = String(msg.text ?? '').trim();
      if (!text) return;
      if (!player.admin) {
        player.connection.send(JSON.stringify({ t: 'cmdresult', text: 'Not authorised. Ask the server operator to /admin you.' }));
        return;
      }
      const result = runAdminCommand(text, player.name);
      player.connection.send(JSON.stringify({ t: 'cmdresult', text: result }));
      return;
    }

    default:
  }
}

// ---------------------------------------------------------------------------
// Admin commands, shared by the server terminal and in-game admins
// ---------------------------------------------------------------------------

function findPlayer(needle) {
  const lower = String(needle).toLowerCase();
  for (const p of players.values()) {
    if (String(p.id) === needle || p.name.toLowerCase() === lower) return p;
  }
  for (const p of players.values()) {
    if (p.name.toLowerCase().includes(lower)) return p;
  }
  return null;
}

function runAdminCommand(line, issuedBy = 'console') {
  const parts = line.match(/"([^"]*)"|(\S+)/g)?.map((s) => s.replace(/^"|"$/g, '')) || [];
  const cmd = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1);

  switch (cmd) {
    case 'help':
      return [
        'status            List connected players',
        'say <text>        Broadcast a server message',
        'kick <who> [why]  Disconnect a player',
        'ban <who>         Kick and block their address',
        'unban <addr>      Remove a ban',
        'bans              List bans',
        'admin <who>       Grant in-game admin rights',
        'unadmin <who>     Revoke admin rights',
        'map <path>        Change the map for everyone',
        'anticheat [level] Show flagged players, or set off|lenient|normal|strict',
        'restart           Restart the current map for everyone',
        'quit              Shut the server down',
      ].join('\n');

    case 'status': {
      if (!players.size) return 'No players connected.';
      const rows = [...players.values()].map((p) => {
        const mins = Math.floor((Date.now() - p.joinedAt) / 60000);
        const ping = p.connection.latencyMs ? `${Math.round(p.connection.latencyMs)}ms` : '-';
        const score = anticheat.report(p).score;
        const flag = score >= anticheat.config.warnScore ? ` !${score.toFixed(0)}` : '';
        return `  #${p.id} ${p.name.padEnd(20)} ${String(p.kills).padStart(3)}k/${String(p.deaths).padStart(3)}d  ${p.admin ? 'admin ' : '      '}${mins}m  ${ping.padStart(6)}  ${p.connection.remoteAddress}${flag}`;
      });
      return `${players.size}/${args.maxPlayers} players on ${currentMap}\n${rows.join('\n')}`;
    }

    case 'say': {
      const text = rest.join(' ');
      if (!text) return 'usage: say <text>';
      broadcast({ t: 'chat', from: null, text: `[server] ${text}` });
      log(`[server say] ${text}`);
      return 'sent';
    }

    case 'kick': {
      const target = findPlayer(rest[0]);
      if (!target) return `No such player: ${rest[0] ?? ''}`;
      const reason = rest.slice(1).join(' ') || 'kicked';
      target.connection.send(JSON.stringify({ t: 'kicked', reason }));
      target.connection.close(4001, reason);
      systemNotice(`${target.name} was kicked by ${issuedBy} (${reason})`);
      return `kicked ${target.name}`;
    }

    case 'ban': {
      const target = findPlayer(rest[0]);
      if (!target) return `No such player: ${rest[0] ?? ''}`;
      bans.add(target.connection.remoteAddress);
      target.connection.send(JSON.stringify({ t: 'kicked', reason: 'banned' }));
      target.connection.close(4003, 'banned');
      systemNotice(`${target.name} was banned by ${issuedBy}`);
      return `banned ${target.name} (${target.connection.remoteAddress})`;
    }

    case 'unban': {
      if (!rest[0]) return 'usage: unban <address>';
      return bans.delete(rest[0]) ? `unbanned ${rest[0]}` : `not banned: ${rest[0]}`;
    }

    case 'bans':
      return bans.size ? [...bans].map((b) => '  ' + b).join('\n') : 'No bans.';

    case 'admin': {
      const target = findPlayer(rest[0]);
      if (!target) return `No such player: ${rest[0] ?? ''}`;
      target.admin = true;
      target.connection.send(JSON.stringify({ t: 'cmdresult', text: 'You now have admin rights. Use /help in chat.' }));
      return `${target.name} is now an admin`;
    }

    case 'unadmin': {
      const target = findPlayer(rest[0]);
      if (!target) return `No such player: ${rest[0] ?? ''}`;
      target.admin = false;
      return `${target.name} is no longer an admin`;
    }

    case 'map': {
      if (!rest[0]) return `current map: ${currentMap}`;
      // Changing to a map that isn't there would 404 every client at once, so
      // refuse the typo rather than emptying the server.
      if (!mapExists(rest[0])) return `No such map: ${rest[0]} (server still on ${currentMap})`;
      try {
        loadWorld(rest[0]);
      } catch (err) {
        return `Could not load ${rest[0]}: ${err.message} (server still on ${currentMap})`;
      }
      currentMap = rest[0];
      resetForNewMap();
      announceMap();
      systemNotice(`Map changed to ${currentMap} by ${issuedBy}`);
      return `map set to ${currentMap}`;
    }

    case 'anticheat': {
      if (!rest[0]) {
        const rows = [...players.values()]
          .map((p) => ({ p, r: anticheat.report(p) }))
          .filter((x) => x.r.score > 0 || x.r.corrections > 0)
          .sort((a, b) => b.r.score - a.r.score)
          .map((x) => `  #${x.p.id} ${x.p.name.padEnd(20)} score ${x.r.score.toFixed(0).padStart(4)}  corrections ${String(x.r.corrections).padStart(4)}  ${x.r.kinds}`);
        return [
          `anticheat: ${anticheat.enabled ? anticheat.presetName : 'off'}`
            + `  (warn ${anticheat.config.warnScore}, kick ${anticheat.config.kickScore === Infinity ? 'never' : anticheat.config.kickScore})`
            + `  client cheats ${args.cheats ? 'allowed (movement checks off)' : 'blocked'}`,
          rows.length ? rows.join('\n') : '  nothing flagged',
        ].join('\n');
      }
      const level = String(rest[0]).toLowerCase();
      if (!PRESETS[level]) return `Unknown level "${level}". Choose: ${Object.keys(PRESETS).join(', ')}`;
      anticheat.setPreset(level, args.cheats ? { validateMovement: false } : {});
      anticheat.setWorld(world);
      systemNotice(`Anticheat set to ${level} by ${issuedBy}`);
      return `anticheat = ${level}`;
    }

    case 'restart':
      resetForNewMap();
      announceMap();
      systemNotice(`Map restarted by ${issuedBy}`);
      return 'restarted';

    case 'quit':
      systemNotice('Server shutting down.');
      setTimeout(() => process.exit(0), 200);
      return 'shutting down';

    default:
      return `Unknown command "${cmd}". Type help.`;
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

setInterval(() => {
  if (!players.size) return;
  const now = Date.now();

  for (const p of players.values()) {
    // Falling out of the world kills you. The client does this locally too,
    // but health is the server's now, so the server has to be the one that
    // decides — otherwise a fall would desync everyone's idea of who is alive.
    if (!p.dead && world && p.pos[1] < (world.bounds.min[1] - 60)) {
      applyDamage(p, null, { damage: MAX_HEALTH, point: [...p.pos], impulse: [0, 0, 0] });
    }
  }

  broadcast({
    t: 'state',
    time: now,
    players: [...players.values()].map(playerSummary),
  });
}, TICK_MS);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

httpServer.listen(args.port, args.host, () => {
  const lines = [
    '',
    `  ${args.name}`,
    '',
    `    Play      http://localhost:${args.port}/`,
    `    Editor    http://localhost:${args.port}/editor/index.html`,
    `    Status    http://localhost:${args.port}/api/status`,
    '',
    `    Map       ${currentMap}`,
    `    Slots     ${args.maxPlayers}`,
    '',
    '  Type admin commands here (help for the list). Ctrl-C to stop.',
    '',
  ];
  console.log(lines.join('\n'));
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${args.port} is already in use. Try --port ${args.port + 1}.\n`);
    process.exit(1);
  }
  console.error('Server error:', err.message);
  process.exit(1);
});

// Admin console on stdin, so operating the server needs no second tool.
// Deliberately not gated on isTTY: stdin is a pipe under Docker, systemd and
// most process managers, and gating on a terminal would silently disable
// admin control in exactly the deployments that need it most.
if (process.stdin.readable) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text) console.log(runAdminCommand(text));
  });
  // A closed pipe just means no admin input; it must not kill the server.
  rl.on('close', () => log('stdin closed; terminal admin console disabled'));
  process.stdin.on('error', () => {});
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nShutting down.');
    broadcast({ t: 'chat', from: null, text: 'Server shutting down.' });
    setTimeout(() => process.exit(0), 100);
  });
}

export { runAdminCommand };
