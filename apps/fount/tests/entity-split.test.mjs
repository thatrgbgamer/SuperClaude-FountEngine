import { test, assert, finish } from './harness.mjs';
import { defineEntity, EntityWorld, plainState } from '../engine/entity.js';

const calls = [];
const log = (s) => calls.push(s);

defineEntity('t_flat', {
  spawn(e) { log('flat.spawn'); e.state.hits = 1; e.state.sprite = { notPlain() {} }; },
  think(e, w, dt) { log('flat.think'); e.state.hits++; },
  draw(e, r, shadow) { log('flat.draw'); },
  inputs: { Ping(e) { log('flat.Ping'); } },
  interact(e, w, p) { log('flat.interact:' + p.id); },
});

defineEntity('t_split', {
  server: {
    spawn(e) { log('server.spawn'); e.state.count = 0; },
    think(e) { log('server.think'); e.state.count++; },
    inputs: { Ping(e) { log('server.Ping'); } },
    interact(e, w, p) { log('server.interact:' + p.id); },
    replicate(e) { return { count: e.state.count }; },
  },
  client: {
    spawn(e) { log('client.spawn'); e.state.shown = true; },
    think() { log('client.think'); },
    draw() { log('client.draw'); },
    apply(e, data) { log('client.apply'); e.state.count = data.count * 10; },
  },
});

const player = (id, x, z, dead = false) => ({ id, actor: { feet: [x, 0, z], dead, entity: null }, position: [x, 0.9, z], dead });
const world = (side, players = []) => new EntityWorld({ players }, { side });
const run = (fn) => { calls.length = 0; fn(); return calls.join(','); };

test('single player runs both halves of a split class, and a flat class once', () => {
  const w = world('both');
  const split = w.spawn({ classname: 't_split' }, { id: 1 });
  w.spawn({ classname: 't_flat' }, { id: 2 });
  assert(split.state.count === 0 && split.state.shown === true, 'both spawns share one state');
  const out = run(() => { w.update(0.01); w.draw({}, false); });
  assert(out === 'server.think,client.think,flat.think,client.draw,flat.draw', out);
});

test('an online server runs the server half only, and never draws', () => {
  const w = world('server');
  run(() => { w.spawn({ classname: 't_split' }, { id: 1 }); w.spawn({ classname: 't_flat' }, { id: 2 }); });
  assert(calls.join(',') === 'server.spawn,flat.spawn', calls.join(','));
  const out = run(() => { w.update(0.01); w.draw({}, false); });
  assert(out === 'server.think,flat.think', out);
});

test('an online client runs the client half, ignores logic, and a flat class only draws', () => {
  const w = world('client');
  const split = w.spawn({ classname: 't_split' }, { id: 1 });
  const flat = w.spawn({ classname: 't_flat' }, { id: 2 });
  assert(split.state.shown === true && split.state.count === undefined, 'client spawn only');
  assert(flat.state.hits === undefined, 'a flat class never spawns on a client');
  const out = run(() => { w.update(0.01); w.draw({}, false); w.fireOutput(split, 'X'); w.sendInput('nobody', 'Ping'); });
  assert(out === 'client.think,client.draw,flat.draw', out);
  assert(w.pendingEvents.length === 0, 'a client fires no outputs');
});

test('a flat class that cannot draw from replicated state warns once instead of crashing the frame', () => {
  defineEntity('t_fragile', { draw(e) { e.state.sprite.draw(); } });
  const w = world('client');
  w.spawn({ classname: 't_fragile' }, { id: 1 });
  const warnings = [];
  const orig = console.warn; console.warn = (m) => warnings.push(m);
  w.draw({}, false); w.draw({}, false); w.draw({}, false);
  console.warn = orig;
  assert(warnings.length === 1 && /split it into/.test(warnings[0]), `warned ${warnings.length} times`);
});

test('interact and inputs reach the server half, with the player passed in', () => {
  const w = world('both');
  const split = w.spawn({ classname: 't_split', name: 's' }, { id: 1 });
  const flat = w.spawn({ classname: 't_flat', name: 'f' }, { id: 2 });
  assert(w.isInteractive(split) && w.isInteractive(flat));
  const out = run(() => { w.interactWith(split, { id: 'p1' }); w.interactWith(flat, { id: 'p2' }); w.sendInput('s', 'Ping'); w.sendInput('f', 'Ping'); });
  assert(out === 'server.interact:p1,flat.interact:p2,server.Ping,flat.Ping', out);
  split.enabled = false;
  assert(w.interactWith(split, { id: 'p1' }) === false, 'a disabled entity cannot be used');
});

test('replication: custom replicate, plain-state default, and apply on the other side', () => {
  const server = world('server');
  const e = server.spawn({ classname: 't_split' }, { id: 1 });
  e.state.count = 7;
  assert(JSON.stringify(server.replicate(e)) === '{"count":7}');
  const f = server.spawn({ classname: 't_flat' }, { id: 2 });
  const rep = server.replicate(f);
  assert(rep.hits === 1 && !('sprite' in rep), 'the default sends plain values and leaves objects with methods behind');
  const client = world('client');
  const ce = client.spawn({ classname: 't_split' }, { id: 1 });
  client.applyReplicated(ce, { count: 7 });
  assert(ce.state.count === 70, 'class-defined apply ran');
  const cf = client.spawn({ classname: 't_flat' }, { id: 2 });
  client.applyReplicated(cf, { hits: 5 });
  assert(cf.state.hits === 5, 'the default apply copies values across');
});

test('plainState keeps data, drops class instances, Maps, private keys and oversized arrays', () => {
  const p = plainState({ a: 1, b: 'x', c: [1, 2, [3]], d: { e: true }, f: new Map(), g: new Set(), h: () => 1, _private: 5, big: new Array(100).fill(0), n: null, deep: { a: { b: { c: { d: { e: 1 } } } } } });
  assert(JSON.stringify(Object.keys(p)) === '["a","b","c","d","n"]', JSON.stringify(Object.keys(p)));
});

test('map entities get fixed ids; runtime spawns get dynamic ones and are announced', () => {
  const w = world('server');
  const announced = [];
  w.onSpawn = (e) => announced.push(e.id);
  const a = w.spawn({ classname: 't_split' }, { id: 1 });
  const b = w.spawn({ classname: 't_split' }, { id: 2 });
  w.finishMapSpawn();
  const c = w.spawn({ classname: 't_split' });
  const d = w.spawn({ classname: 't_split' });
  assert(a.id === 1 && b.id === 2 && !a.dynamic, 'map ids are positional');
  assert(c.dynamic && d.dynamic && c.id >= 1_000_000 && d.id === c.id + 1, 'dynamic ids are separate and sequential');
  assert(JSON.stringify(announced) === JSON.stringify([c.id, d.id]), 'only runtime spawns are announced');
  assert(w.findById(2) === b && w.findById(c.id) === c);
  w.remove(c);
  w.update(0.01);
  assert(!w.findById(c.id), 'removed entities leave the id index');
});

test('per-player state is separate per player, and forgotten when they leave', () => {
  const w = world('server');
  const herb = w.spawn({ classname: 't_split' }, { id: 1 });
  herb.stateFor('a').picked = true;
  assert(herb.stateFor('b').picked === undefined && herb.stateFor('a').picked === true);
  w.forgetPlayer('a');
  assert(herb.stateFor('a').picked === undefined);
});

test('an entity can be shown to only some players', () => {
  const w = world('server');
  const loot = w.spawn({ classname: 't_split' }, { id: 1 });
  assert(loot.visibleTo === null, 'visible to all by default');
  loot.showOnlyTo(['a']);
  assert(loot.visibleTo({ id: 'a' }) === true && loot.visibleTo({ id: 'b' }) === false);
  loot.showOnlyTo(null);
  assert(loot.visibleTo === null);
});

test('player helpers: playerOf, playersInRadius and playersInBox skip the dead unless asked', () => {
  const a = player('a', 0, 0), b = player('b', 5, 0), c = player('c', 1, 1, true);
  const w = world('server', [a, b, c]);
  const ctx = w.context;
  assert(ctx.playerOf(b.actor) === b && ctx.playerOf({}) === null);
  assert(ctx.playersInRadius([0, 0, 0], 2).map((p) => p.id).join() === 'a', 'the dead are skipped');
  assert(ctx.playersInRadius([0, 0, 0], 2, { includeDead: true }).map((p) => p.id).join() === 'a,c');
  assert(ctx.playersInBox([4, -1, -1], [6, 3, 1]).map((p) => p.id).join() === 'b');
});

finish();
