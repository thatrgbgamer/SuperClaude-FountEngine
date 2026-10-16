import { test, assert, near, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';
import { NetSession } from '../engine/netcode.js';
import { PROTOCOL_VERSION } from '../engine/protocol.js';

const root = makeGameFolder();
const server = await startServer({ root, port: 0, quiet: true, host: '127.0.0.1', reconnectGraceSeconds: 1 });
const bots = [];
const bot = (hello) => { const b = new Bot(server.port, root, hello); bots.push(b); return b; };
const inst = () => [...server.manager.instances.values()][0];
const serverActor = (b) => inst().players.find((p) => p.id === b.session.playerId).actor;

test('a client connects, is welcomed with its own ids and a body that matches the server\'s', async () => {
  const a = bot({ name: 'Alice' });
  const w = await a.join();
  assert(w.t === 'welcome' && w.id && w.actor && w.map === 'game/maps/arena.json' && w.tickHz === 30 && w.resume);
  assert(w.name === 'Alice' && w.body.speed === 6 && w.body.hy > 0.8);
  await waitFor(() => a.self, 2000, 'own actor in a snapshot');
  assert(a.self.isSelf && a.self.name === 'Alice' && a.self.faction === 'player');
});

test('a mismatched protocol or game is refused with a readable reason', async () => {
  const wrong = new NetSession({ url: `ws://127.0.0.1:${server.port}`, hello: { game: 'othergame' } });
  let reason = '';
  await wrong.connect().catch((e) => { reason = e.message; });
  assert(/testgame/.test(reason) && /othergame/.test(reason), reason);

  const raw = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const got = await new Promise((resolve) => {
    raw.addEventListener('open', () => raw.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 5, game: 'testgame' })));
    raw.addEventListener('message', (e) => resolve(JSON.parse(e.data)));
  });
  assert(got.t === 'reject' && /protocol/.test(got.reason), JSON.stringify(got));
});

test('walking: the predicted player and the authoritative player agree, with no correction on a clean connection', async () => {
  const a = await (async () => { const b = bot({ name: 'Walker' }); await b.join(); return b; })();
  await waitFor(() => a.self && a.session.predictor, 2000);
  const start = [...a.session.predictor.feet];
  a.walk(1, 0);
  await sleep(1200);
  a.stand();
  await sleep(500);
  const sa = serverActor(a);
  const moved = a.session.predictor.feet[0] - start[0];
  assert(moved > 4, `moved ${moved.toFixed(2)}m east in 1.2s at speed 6`);
  const gap = Math.hypot(a.session.predictor.feet[0] - sa.feet[0], a.session.predictor.feet[2] - sa.feet[2]);
  assert(gap < 0.05, `predicted ${a.session.predictor.feet.map((v) => v.toFixed(2))} vs server ${sa.feet.map((v) => v.toFixed(2))}`);
  assert(a.session.stats.maxError < 0.35, `the worst correction was ${a.session.stats.maxError.toFixed(3)}m`);
  return `moved ${moved.toFixed(1)}m, ${a.session.stats.corrections} corrections, worst ${a.session.stats.maxError.toFixed(3)}m`;
});

test('the server decides speed: a client cannot move faster by lying', async () => {
  const b = bot({ name: 'Cheater' });
  await b.join();
  await waitFor(() => b.self && b.session.predictor, 2000);
  const sa = serverActor(b);
  const before = [...sa.feet];
  // Hand-roll commands far above any legal rate, with an oversize vector.
  for (let i = 0; i < 300; i++) b.session.send({ t: 'i', q: 1000 + i, mv: [50, 0] });
  await sleep(1000);
  const run = Math.hypot(sa.feet[0] - before[0], sa.feet[2] - before[2]);
  assert(run < 7.5, `server-side distance in ~1s: ${run.toFixed(2)}m (speed 6)`);
});

test('another player is visible, at the right place, and updates as they move', async () => {
  const c = bot({ name: 'Watcher' });
  const d = bot({ name: 'Mover' });
  await c.join(); await d.join();
  await waitFor(() => c.actorNamed('Mover') && d.self, 2000, 'Watcher to see Mover');
  d.walk(0, 1);
  await sleep(1000);
  d.stand();
  await sleep(500);
  const seen = c.actorNamed('Mover');
  const truth = serverActor(d);
  const gap = Math.hypot(seen.pos[0] - truth.feet[0], seen.pos[2] - truth.feet[2]);
  assert(gap < 0.3, `seen at ${seen.pos.map((v) => v.toFixed(2))}, truth ${truth.feet.map((v) => v.toFixed(2))}`);
  assert(seen.kind === 'player' && seen.faction === 'player');
});

test('a monster notices a player, chases and hurts them; everyone sees the damage and health bars', async () => {
  const e = bot({ name: 'Bait' });
  const f = bot({ name: 'Onlooker' });
  await e.join(); await f.join();
  const imp = [...inst().actors.actors].find((a) => a.name === 'Imp');
  const bait = serverActor(e);
  bait.teleport([imp.feet[0] + 3, 0, imp.feet[2]]);
  const mine = () => e.eventsOf('dmg').filter((x) => x.a === bait.id);
  await waitFor(() => mine().length > 0, 6000, 'the imp to land a hit on Bait');
  const hit = mine()[0];
  assert(hit.v === 7 && hit.k === 'physical' && hit.s === imp.id, JSON.stringify(hit));
  await waitFor(() => e.self.health < 100, 1000);
  await waitFor(() => f.actorNamed('Bait') && f.actorNamed('Bait').health < 100, 1000, 'the onlooker to see the health drop');
  assert(f.eventsOf('dmg').some((x) => x.a === bait.id), 'the onlooker heard the damage event');
  assert(e.eventsOf('aggro').length >= 1, 'and the aggro');
});

test('using an ability: validated, cast, and its effects decided by the server', async () => {
  const g = bot({ name: 'Fighter' });
  await g.join();
  await waitFor(() => g.self, 2000);
  const imp = [...inst().actors.actors].find((a) => a.name === 'Imp' && !a.dead);
  const me = serverActor(g);
  imp.health = imp.maxHealth;
  me.teleport([imp.feet[0] - 1.2, 0, imp.feet[2]]);
  imp.teleport([imp.feet[0], 0, imp.feet[2]]);
  imp.ai.enabled = false;
  const hp0 = imp.health;
  g.session.useAbility('strike', { dir: [1, 0] });
  await waitFor(() => imp.health < hp0, 2000, 'the strike to land');
  assert(imp.health === hp0 - 20, `a strike does exactly 20, imp ${imp.health}`);
  await waitFor(() => g.eventsOf('ab').length > 0 && g.eventsOf('dmg').length > 0, 1000);
  assert(g.eventsOf('cs')[0].ab === 'strike', 'the cast start was broadcast');
});

test('abilities are refused for the right reasons, and never executed', async () => {
  const h = bot({ name: 'Tester' });
  await h.join();
  await waitFor(() => h.self, 2000);
  h.session.useAbility('secret');                 // exists in the game, not on this player's bar
  h.session.useAbility('does_not_exist');
  await waitFor(() => h.denied.length >= 2, 1500, 'two denials');
  assert(h.denied.every((d) => d.reason === 'not-allowed'), JSON.stringify(h.denied));
  h.session.useAbility('bolt', { dir: [1, 0] });
  h.session.useAbility('bolt', { dir: [1, 0] });
  await waitFor(() => h.denied.length >= 3, 1500, 'a cooldown/busy denial');
  assert(['cooldown', 'busy'].includes(h.denied[2].reason), h.denied[2].reason);
});

test('a projectile is visible to clients and kills what it hits', async () => {
  const i = bot({ name: 'Archer' });
  const j = bot({ name: 'Spectator' });
  await i.join(); await j.join();
  await waitFor(() => i.self && j.self, 2000);
  const me = serverActor(i);
  const imp = [...inst().actors.actors].find((a) => a.name === 'Imp' && !a.dead);
  imp.ai.enabled = false;
  imp.health = 25;
  me.teleport([imp.feet[0] - 6, 0, imp.feet[2]]);
  me.resources.mana.value = 50;
  i.session.useAbility('bolt', { dir: [1, 0] });
  await waitFor(() => j.session.projectiles.length > 0, 1500, 'the spectator to see the bolt in flight');
  await waitFor(() => imp.dead, 3000, 'the imp to die');
  await waitFor(() => i.eventsOf('death').some((x) => x.a === imp.id), 1000, 'the death event');
  assert(j.actorNamed('Imp').dead, 'and the spectator sees the corpse');
});

test('hostile input is survived: junk, floods and oversize messages never crash or move the server', async () => {
  const k = bot({ name: 'Hostile' });
  await k.join();
  await waitFor(() => k.self, 2000);
  const s = k.session;
  for (const junk of ['not json', '{', '[]', '{"t":5}', '{"t":"i"}', '{"t":"i","q":"x","mv":[1,2]}', '{"t":"ab"}', '{"t":"ia","e":"x"}', JSON.stringify({ t: 'i', q: 1, mv: [NaN, 0] })]) s.socket.send(junk);
  for (let n = 0; n < 500; n++) s.send({ t: 'ping', c: n });          // a flood: kicked, not queued forever
  await sleep(300);
  assert(server.manager.stats.tickMsLast < 50, 'the tick loop is unaffected');
  const big = bot({ name: 'Big' });
  await big.join();
  let closed = null;
  big.session.on('close', (c) => { closed = c; });
  big.session.socket.send('x'.repeat(40 * 1024));
  await waitFor(() => closed, 1500, 'the oversize message to be refused');
  assert(closed.code === 4009 || /large/i.test(closed.reason || ''), JSON.stringify(closed));
});

test('the status endpoint reports instances, players and tick time', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/status`);
  const st = await res.json();
  assert(st.protocol === PROTOCOL_VERSION && st.instances.length >= 1 && st.players >= 1);
  assert(st.tick.hz === 30 && st.tick.avgMs < 25, JSON.stringify(st.tick));
});

for (const b of bots) b.stop();
for (const b of bots) b.session.close();
await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
