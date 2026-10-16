#!/usr/bin/env node
// A load test: many headless players against a Fount server.
//
//   node server/loadtest.mjs --bots 50 --seconds 20                  starts its own server on the game in --root
//   node server/loadtest.mjs --url ws://host:8099 --bots 200         tests a server that is already running
//
// Each bot connects with the real client netcode, walks about at random, and
// now and then swings at nothing, so the server does what it does under play:
// validate commands, step the simulation, build per-client snapshots. The
// report says whether the tick fits its budget.
//
//   --bots <n>        players to connect (default 50)
//   --seconds <n>     how long to play once connected (default 15)
//   --root <dir>      game folder (default: the one above server/)  --config <file> game config
//   --url <ws://...>  test an existing server instead of starting one (--root is then only for maps)
//   --ramp <ms>       gap between joins (default 40)
//   --ability <id>    ability the bots use now and then (default: the first on their bar)
//
// The pass line is the budget from the spec: the average tick must stay under half of the 33 ms tick.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NetSession } from '../engine/netcode.js';
import { Relations } from '../engine/combat.js';
import { buildMap } from '../engine/map.js';
import { SIM_DT, STEPS_PER_COMMAND, COMMAND_HZ } from '../engine/protocol.js';
import { startServer } from './mmo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

const bots = parseInt(opt('bots', '50'), 10);
const seconds = parseFloat(opt('seconds', '15'));
const root = path.resolve(opt('root', path.resolve(HERE, '..')));
const config = opt('config', 'game/test_game.json');
const ramp = parseInt(opt('ramp', '40'), 10);
let url = opt('url', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
if (!url) {
  server = await startServer({ root, config, port: 0, host: '127.0.0.1', quiet: true, maxPlayers: bots + 10, defaultCap: bots + 10 });
  url = `ws://127.0.0.1:${server.port}`;
}
const http = url.replace(/^ws/, 'http');
const gameName = JSON.parse(fs.readFileSync(path.join(root, config), 'utf8')).name;

const collisionCache = new Map();
function collisionFor(map) {
  if (!collisionCache.has(map)) collisionCache.set(map, buildMap(JSON.parse(fs.readFileSync(path.join(root, map), 'utf8'))).collision);
  return collisionCache.get(map);
}

const tally = { joined: 0, failed: 0, snapshots: 0, closed: 0 };
const players = [];

async function spawnBot(i) {
  const session = new NetSession({ url, hello: { game: gameName, name: `bot${i}` }, relations: new Relations(), interpDelayMs: 100 });
  const bot = { session, intent: { mv: [0, 0], f: null }, timer: null, turnAt: 0 };
  session.on('welcome', (w) => { try { session.attachWorld(collisionFor(w.map)); } catch { /* the map is not on disk here: run without prediction */ } });
  session.on('close', () => { tally.closed++; });
  const origApply = session.applySnapshot.bind(session);
  session.applySnapshot = (m) => { tally.snapshots++; return origApply(m); };
  try {
    await session.connect();
  } catch (err) { tally.failed++; return null; }
  tally.joined++;
  let n = 0;
  bot.timer = setInterval(() => {
    n++;
    if (n >= bot.turnAt) {
      const a = Math.random() * Math.PI * 2;
      bot.intent = Math.random() < 0.2 ? { mv: [0, 0], f: null } : { mv: [Math.cos(a), Math.sin(a)], f: null };
      bot.turnAt = n + 15 + Math.floor(Math.random() * 60);
    }
    try {
      for (let k = 0; k < STEPS_PER_COMMAND; k++) session.step(SIM_DT, bot.intent);
      session.updateRender(1 / COMMAND_HZ);
      if (n % 45 === 0) {
        const hb = (session.own && session.own.hotbar) || null;
        const id = opt('ability', null) || (hb && hb[0]);
        if (id) session.useAbility(id, { dir: [Math.cos(n), Math.sin(n)] });
      }
    } catch { /* a bot that errors just stands there */ }
  }, 1000 / COMMAND_HZ);
  return bot;
}

console.log(`Connecting ${bots} bots to ${url} ...`);
for (let i = 0; i < bots; i++) {
  const b = await spawnBot(i);
  if (b) players.push(b);
  if (ramp) await sleep(ramp);
}
console.log(`${tally.joined} joined, ${tally.failed} failed. Playing for ${seconds}s ...`);

const samples = [];
const t0 = performance.now();
const snap0 = tally.snapshots;
const bytes0 = server ? server.stats.bytesOut : 0;
while ((performance.now() - t0) / 1000 < seconds) {
  await sleep(1000);
  try { samples.push(await (await fetch(`${http}/api/status`)).json()); } catch { /* status is optional */ }
}
const elapsed = (performance.now() - t0) / 1000;

const tickAvg = samples.length ? samples.reduce((s, x) => s + x.tick.avgMs, 0) / samples.length : NaN;
const tickMax = samples.length ? Math.max(...samples.map((x) => x.tick.maxMs)) : NaN;
const budget = 1000 / COMMAND_HZ;
const bytes = server ? server.stats.bytesOut - bytes0 : null;
const result = {
  bots, joined: tally.joined, failed: tally.failed, droppedDuringTest: tally.closed,
  snapshotsPerSecondPerBot: Math.round(((tally.snapshots - snap0) / elapsed / Math.max(1, players.length)) * 10) / 10,
  kilobytesPerSecondPerBot: bytes === null ? null : Math.round((bytes / elapsed / 1024 / Math.max(1, players.length)) * 10) / 10,
  tickMsAverage: Math.round(tickAvg * 100) / 100, tickMsWorst: Math.round(tickMax * 100) / 100,
  tickBudgetUsed: Math.round((tickAvg / budget) * 1000) / 10 + '%',
};
console.log(JSON.stringify(result, null, 2));
const ok = tally.failed === 0 && tickAvg < budget * 0.5;
console.log(ok ? 'PASS: the tick fits comfortably in its budget.' : 'FAIL: joins failed or the average tick used more than half its budget.');

for (const b of players) { clearInterval(b.timer); try { b.session.close(); } catch { /* gone */ } }
if (server) await server.close();
process.exit(ok ? 0 : 1);
