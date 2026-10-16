import { test, assert, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { SpatialInterest } from '../server/interest.mjs';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

// ---- the spatial hash on its own -------------------------------------------------

const fakeActor = (id, x, z) => ({ id, controller: { position: [x, 0, z] } });
const fakeInstance = (actors) => ({ actors: { actors }, tickNo: 1 });

test('the spatial hash finds exactly the actors a brute-force scan would', () => {
  const actors = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 400; i++) actors.push(fakeActor(i + 1, rnd() * 300 - 150, rnd() * 300 - 150));
  const si = new SpatialInterest({ radius: 45 });
  si.rebuild(fakeInstance(actors), 1);
  for (const [x, z, r] of [[0, 0, 45], [-120, 80, 30], [149, -149, 60], [10.5, -3.2, 5]]) {
    const want = actors.filter((a) => Math.hypot(a.controller.position[0] - x, a.controller.position[2] - z) <= r).map((a) => a.id).sort((a, b) => a - b);
    const got = si.near(x, z, r).map((a) => a.id).sort((a, b) => a - b);
    assert(JSON.stringify(want) === JSON.stringify(got), `query at ${x},${z} r${r}`);
  }
});

test('an actor on the boundary does not flicker: it enters at the radius and leaves only past the margin', () => {
  const me = fakeActor(1, 0, 0);
  const far = fakeActor(2, 46, 0);
  const player = { actor: me, view: { actors: new Map() } };
  const inst = fakeInstance([me, far]);
  const si = new SpatialInterest({ radius: 45, margin: 1.15 });
  let ids = () => si.actors(player, inst).map((a) => a.id);
  assert(!ids().includes(2), 'not yet known, outside the radius');
  far.controller.position[0] = 44;
  si.tick = -1;
  assert(ids().includes(2), 'enters at the radius');
  player.view.actors.set(2, {});
  far.controller.position[0] = 50;                   // outside the radius, inside the margin
  si.tick = -1;
  assert(ids().includes(2), 'stays through the margin');
  far.controller.position[0] = 53;
  si.tick = -1;
  assert(!ids().includes(2), 'leaves beyond the margin');
});

test('always-visible actors are sent whatever the distance', () => {
  const me = fakeActor(1, 0, 0);
  const friend = fakeActor(2, 400, 0);
  const player = { actor: me, view: { actors: new Map() }, alwaysVisible: () => [friend] };
  const si = new SpatialInterest({ radius: 45 });
  assert(si.actors(player, fakeInstance([me, friend])).some((a) => a.id === 2));
});

test('events far away are dropped unless they involve the player', () => {
  const me = fakeActor(1, 0, 0);
  const player = { actor: me };
  const si = new SpatialInterest({ radius: 45 });
  assert(si.eventVisible(player, { at: [10, 10], ev: {} }));
  assert(!si.eventVisible(player, { at: [200, 0], ev: { a: 9 } }));
  assert(si.eventVisible(player, { at: [200, 0], ev: { t: 1 } }), 'being hit from afar is still seen');
  assert(si.eventVisible(player, { at: null, ev: {} }), 'global events reach everyone');
});

// ---- on a real server ------------------------------------------------------------

const root = makeGameFolder({ config: { server: { startMap: 'game/maps/arena.json', viewRadius: 12 } } });
const server = await startServer({ root, port: 0, quiet: true, host: '127.0.0.1' });
const bots = [];
const bot = (name) => { const b = new Bot(server.port, root, { name }); bots.push(b); return b; };
const inst = (b) => server.manager.instances.get(b.welcomes[b.welcomes.length - 1].instance);
const sp = (b) => inst(b).players.find((p) => p.id === b.session.playerId);
const place = (b, x, z) => { const p = sp(b).actor.controller.position; p[0] = x; p[2] = z; };

test('a client hears only about actors within the view radius, and about them again when they return', async () => {
  const a = bot('Alice'), b = bot('Bob');
  await a.join(); await b.join();
  await waitFor(() => a.actorNamed('Bob'), 2000, 'Bob in view');
  place(b, 25, 0);
  await waitFor(() => !a.actorNamed('Bob'), 2000, 'Bob out of view');
  place(b, -8, 0);
  await waitFor(() => a.actorNamed('Bob'), 2000, 'Bob back');
  a.leave(); b.leave();
});

test('a far-away monster is not replicated until the player gets close', async () => {
  const a = bot('Cora');
  await a.join();
  await sleep(200);
  place(a, -10, -20);
  await sleep(300);
  assert(!a.actorNamed('Imp'), 'the imp, 32 m away, is not sent');
  place(a, 0, 4);
  await waitFor(() => a.actorNamed('Imp'), 2000, 'the imp comes into view');
  a.leave();
});

test('the byte budget defers distant updates, never the player\'s own, and recovers', async () => {
  const a = bot('Dana'), b = bot('Eli');
  await a.join(); await b.join();
  await waitFor(() => a.actorNamed('Eli'), 2000);
  const rep = inst(a).replicator;
  rep.bytesPerTick = 20;                              // far less than the snapshot needs
  b.walk(1, 0);
  await sleep(500);
  const view = sp(a).view;
  assert(view.deferred > 0, `updates were held back (${view.deferred})`);
  assert(a.self, 'the player still receives its own state');
  const seenAt = a.actorNamed('Eli').pos ? a.actorNamed('Eli').pos[0] : null;
  b.stand();
  rep.bytesPerTick = Infinity;
  await sleep(500);
  assert(sp(a).view.deferred === 0, 'nothing left deferred once the budget allows');
  const real = sp(b).actor.feet[0];
  const now = a.actorNamed('Eli');
  assert(now && Math.abs(now.pos[0] - real) < 0.5, `Eli's position caught up (${now && now.pos[0]} vs ${real}) from ${seenAt}`);
  a.leave(); b.leave();
});

for (const b of bots) b.stop();
await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
