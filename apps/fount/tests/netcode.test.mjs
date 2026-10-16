import { test, assert, near, finish } from './harness.mjs';
import { buildMap } from '../engine/map.js';
import { ActorSystem } from '../engine/actors.js';
import { Predictor, Track, ClockSync } from '../engine/netcode.js';
import { STEPS_PER_COMMAND, SIM_DT, parseCommand, parseAbility, parseHello, makeHello, PROTOCOL_VERSION, facingToDegrees, degreesToFacing } from '../engine/protocol.js';

// An arena with a wall and a step, so prediction is tested against real collision.
const collision = buildMap({
  name: 't',
  brushes: [
    { type: 'box', min: [-20, -1, -20], max: [20, 0, 20] },
    { type: 'box', min: [3, 0, -4], max: [4, 3, 4] },
    { type: 'box', min: [-6, 0, 2], max: [-4, 0.4, 4] },
  ],
}).collision;

const body = (a) => ({ hx: a.controller.halfExtents[0], hy: a.controller.halfExtents[1], hz: a.controller.halfExtents[2], acc: a.controller.acceleration, fr: a.controller.friction, g: a.controller.gravity, step: a.controller.stepHeight, speed: a.speed });

// The server's side of one command: apply it for four steps, as Instance does.
function serverApply(system, actor, cmd) {
  actor.intent.move = cmd.mv;
  for (let i = 0; i < STEPS_PER_COMMAND; i++) system.update(SIM_DT);
}
function ownOf(actor) {
  const p = actor.controller;
  return { p: [...p.position], v: [...p.velocity], og: p.onGround ? 1 : 0, sp: actor.speed, cm: actor.canMove() ? 1 : 0 };
}
function setup() {
  const system = new ActorSystem({ collision });
  const actor = system.spawn({ name: 'p', kind: 'player', faction: 'player', feet: [-8, 0, 0], speed: 6 });
  const predictor = new Predictor(collision, body(actor), actor.feet);
  return { system, actor, predictor };
}

// A scripted walk: east, then a diagonal into the wall, then back.
const script = [];
for (let i = 0; i < 30; i++) script.push([1, 0]);
for (let i = 0; i < 25; i++) script.push([0.7, 0.7]);
for (let i = 0; i < 20; i++) script.push([-1, 0.3]);
for (let i = 0; i < 10; i++) script.push([0, 0]);

function playScript(predictor, onDone) {
  for (const mv of script) {
    predictor.begin(mv, null);
    let done = null;
    for (let i = 0; i < STEPS_PER_COMMAND; i++) done = predictor.step();
    onDone(done);
  }
}

test('prediction and the real actor agree to the last bit, through walls and steps', () => {
  const { system, actor, predictor } = setup();
  playScript(predictor, (cmd) => serverApply(system, actor, cmd));
  const a = actor.controller.position, b = predictor.controller.position;
  assert(a[0] === b[0] && a[1] === b[1] && a[2] === b[2], `server ${a.map((v) => v.toFixed(6))} vs client ${b.map((v) => v.toFixed(6))}`);
  assert(Math.abs(a[0] - -8) > 1, 'it actually moved');
});

test('reconciling with the server\'s state while commands are still in flight changes nothing', () => {
  const { system, actor, predictor } = setup();
  const sent = [];
  playScript(predictor, (cmd) => sent.push(cmd));
  // The server has applied only the first 40 commands; the client is 40 ahead.
  for (const cmd of sent.slice(0, 40)) serverApply(system, actor, cmd);
  const before = [...predictor.controller.position];
  const err = predictor.reconcile(sent[39].q, ownOf(actor));
  assert(Math.hypot(...err) < 1e-9, `no correction expected, got ${err.map((v) => v.toExponential(2))}`);
  const after = predictor.controller.position;
  assert(before.every((v, i) => v === after[i]), 'and the predicted position is untouched');
  assert(predictor.pending.length === sent.length - 40, 'acknowledged commands are dropped, the rest kept');
});

test('a mid-command reconcile replays the part of the command already played', () => {
  const { system, actor, predictor } = setup();
  const sent = [];
  for (let i = 0; i < 10; i++) { predictor.begin([1, 0], null); let d = null; for (let k = 0; k < 4; k++) d = predictor.step(); sent.push(d); }
  predictor.begin([0, 1], null);
  predictor.step(); predictor.step();               // two of four steps of the next command
  for (const cmd of sent.slice(0, 6)) serverApply(system, actor, cmd);
  const before = [...predictor.controller.position];
  const err = predictor.reconcile(sent[5].q, ownOf(actor));
  assert(Math.hypot(...err) < 1e-9, 'replay includes the two steps already taken');
  assert(before.every((v, i) => v === predictor.controller.position[i]));
});

test('a disturbance the client could not predict (a knockback) is corrected, and reported as an error to ease out', () => {
  const { system, actor, predictor } = setup();
  const sent = [];
  for (let i = 0; i < 20; i++) { predictor.begin([1, 0], null); let d = null; for (let k = 0; k < 4; k++) d = predictor.step(); sent.push(d); }
  for (const cmd of sent.slice(0, 10)) serverApply(system, actor, cmd);
  actor.controller.velocity = [-12, 0, 0];           // shoved back on the server only
  serverApply(system, actor, sent[10]);
  const err = predictor.reconcile(sent[10].q, ownOf(actor));
  assert(Math.hypot(...err) > 0.2, `the client was wrong by ${Math.hypot(...err).toFixed(2)}m`);
});

test('a stunned player stops in the prediction too, from the server\'s own canMove flag', () => {
  const { actor, predictor } = setup();
  predictor.begin([1, 0], null);
  for (let k = 0; k < 4; k++) predictor.step();
  const moved = predictor.controller.position[0];
  const own = ownOf(actor);
  own.cm = 0;
  predictor.reconcile(0, own);
  predictor.begin([1, 0], null);
  for (let k = 0; k < 4; k++) predictor.step();
  assert(Math.abs(predictor.controller.position[0] - actor.controller.position[0]) < 1e-9, `${predictor.controller.position[0]} vs ${moved}`);
});

test('commands are rounded before they are predicted, so client and server use identical numbers', () => {
  const { predictor } = setup();
  const c = predictor.begin([0.123456, 0.987654], null);
  assert(c.mv[0] === 0.12 && Math.abs(Math.hypot(...c.mv) - 1) < 0.01, JSON.stringify(c.mv));
  const over = predictor.begin([1, 1], null);
  assert(Math.hypot(...over.mv) <= 1.0000001, 'a diagonal is normalised');
});

test('an optimistic cast lock holds the predicted player still until it expires', () => {
  const { predictor } = setup();
  predictor.now = 1000; predictor.lockedUntil = 1500;
  predictor.begin([1, 0], null);
  for (let k = 0; k < 4; k++) predictor.step();
  assert(Math.abs(predictor.controller.velocity[0]) < 1e-9, 'no movement while locked');
  predictor.now = 1600;
  predictor.begin([1, 0], null);
  for (let k = 0; k < 4; k++) predictor.step();
  assert(predictor.controller.velocity[0] > 0.1, 'and moving again after');
});

// ---------------------------------------------------------------------------

test('interpolation: between samples, held still at the ends, brief extrapolation, no sprint across a teleport', () => {
  const t = new Track();
  t.push(1000, 0, 0, 0, 0); t.push(1100, 1, 0, 0, 90); t.push(1200, 2, 0, 0, 180);
  near(t.sample(1050).x, 0.5, 1e-9); near(t.sample(1150).x, 1.5, 1e-9);
  near(t.sample(500).x, 0, 1e-9, 'before the first sample');
  near(t.sample(1250).x, 2.5, 1e-9, 'extrapolates up to 150ms');
  near(t.sample(1500).x, 2, 1e-9, 'then holds');
  near(t.sample(1050).fa, 45, 1e-9, 'angles interpolate');
  t.push(1300, 200, 0, 0, 0);                         // far further than anyone can run in 100ms
  near(t.sample(1300).x, 200, 1e-9, 'a teleport clears the history');
  near(t.sample(1250).x, 200, 1e-9, 'rather than blending toward it');
});

test('interpolation takes the short way round the compass', () => {
  const t = new Track();
  t.push(0, 0, 0, 0, 350); t.push(100, 1, 0, 0, 10);
  near(t.sample(50).fa, 360, 1e-9, '350 to 10 passes through 0, not 180');
});

test('the clock offset follows the fastest packets and ignores delayed ones', () => {
  const c = new ClockSync(10);
  for (let i = 0; i < 10; i++) c.observe(1000 + i * 33, 5000 + i * 33 + (i % 3 === 0 ? 80 : 20));
  near(c.offset, 4000 + 20, 0.01);
  near(c.serverNow(5100), 1080, 0.01);
});

// ---------------------------------------------------------------------------

test('every incoming message is validated: junk is refused, numbers are clamped, nothing passes through raw', () => {
  assert(parseCommand({ q: 1, mv: [0, 'x'] }) === null && parseCommand({ q: -1, mv: [0, 0] }) === null && parseCommand({ q: 1.5, mv: [0, 0] }) === null);
  assert(parseCommand({ q: 1, mv: [NaN, 0] }) === null && parseCommand({ q: 1, mv: [Infinity, 0] }) === null);
  const big = parseCommand({ q: 1, mv: [50, 50] });
  assert(Math.hypot(...big.mv) <= 1.0001, 'an oversize vector is brought back to unit length, not trusted');
  const ab = parseAbility({ id: 'fireball\u0000\n', aim: { d: [0, 0], p: [1, 2, 'x'], tg: 'hax' } });
  assert(ab.id === 'fireball' && !ab.aim.dir && !ab.aim.point && ab.aim.targetId === undefined, JSON.stringify(ab));
  assert(parseAbility({ id: '' }) === null);
  assert(parseAbility({ id: 'a', aim: { d: [3, 4] } }).aim.dir.join() === '0.6,0.8');
});

test('the handshake rejects a mismatched protocol with a readable message', () => {
  assert(parseHello(makeHello({ name: 'x' })).hello.name === 'x');
  const bad = parseHello({ t: 'hello', v: PROTOCOL_VERSION + 1 });
  assert(/protocol/.test(bad.error) && /Update/.test(bad.error));
  assert(parseHello({ t: 'move' }).error && parseHello(null).error);
  assert(parseHello(makeHello({ name: 'a'.repeat(100) })).hello.name.length === 20, 'names are capped');
});

test('facing round-trips through whole degrees', () => {
  for (const f of [[1, 0], [0, -1], [-1, 0], [0, 1], [0.6, -0.8]]) {
    const back = degreesToFacing(facingToDegrees(f));
    assert(Math.hypot(back[0] - f[0], back[1] - f[1]) < 0.02, `${f} -> ${back}`);
  }
});

finish();
