import { test, assert, near, finish } from './harness.mjs';
import { buildMap } from '../engine/map.js';
import { ActorSystem } from '../engine/actors.js';
import { ActorPlayer } from '../engine/rpg_player.js';
import { EntityWorld } from '../engine/entity.js';
import '../engine/entities_rpg.js';
import { ParticleSystem, FloatingTexts } from '../engine/particles.js';
import { SpriteLibrary } from '../engine/sprites.js';
import { BUILTIN_SPRITES } from '../engine/builtin_sprites.js';

const DT = 1 / 120;

// A renderer stand-in that records what was asked of it.
function fakeRenderer() {
  return { frames: [], texts: [], blobs: [], boxes: [],
    drawSpriteFrame(id, pos, o) { this.frames.push({ id, pos: [...pos], ...o }); },
    drawText(text, pos, o) { this.texts.push({ text, pos: [...pos], ...o }); },
    drawBlobShadow(pos, r) { this.blobs.push({ pos, r }); },
    drawBrushBox(min, max, layer) { this.boxes.push({ min: [...min], max: [...max], layer }); },
  };
}

function library() { const l = new SpriteLibrary(); l.registerAll(BUILTIN_SPRITES); return l; }

// ---------------------------------------------------------------------------
// Particles and floating text
// ---------------------------------------------------------------------------

test('a burst spawns its count, they live their lifetime and are then recycled', () => {
  const ps = new ParticleSystem(100);
  ps.sprites = library();
  ps.burst('spark', [0, 1, 0]);
  assert(ps.count === 8, `spark preset throws 8, got ${ps.count}`);
  for (let i = 0; i < 120; i++) ps.update(DT);
  assert(ps.count === 0, 'all dead after a second');
  ps.burst('spark', [0, 1, 0]);
  assert(ps.pool.length >= 0 && ps.count === 8, 'recycled particles are reusable');
});

test('particles fall under gravity, rise when it is negative, and honour the cap', () => {
  const ps = new ParticleSystem(10);
  ps.sprites = library();
  ps.burst({ sprite: 'fx_px', count: 1, life: 2, speed: 0, up: 0, gravity: 10 }, [0, 5, 0]);
  ps.burst({ sprite: 'fx_px', count: 1, life: 2, speed: 0, up: 0, gravity: -10 }, [0, 5, 0]);
  for (let i = 0; i < 60; i++) ps.update(DT);
  const [fall, rise] = ps.live;
  assert(fall.pos[1] < 5 && rise.pos[1] > 5, `gravity ${fall.pos[1].toFixed(2)}, anti-gravity ${rise.pos[1].toFixed(2)}`);
  ps.burst({ sprite: 'fx_px', count: 50, life: 5 }, [0, 0, 0]);
  assert(ps.count <= 10, `capped at 10, got ${ps.count}`);
});

test('an emitter produces particles at its rate and stops when told', () => {
  const ps = new ParticleSystem(500);
  ps.sprites = library();
  const e = ps.emitter({ sprite: 'fx_px', count: 1, life: 10 }, [0, 0, 0], { rate: 20 });
  for (let i = 0; i < 120; i++) ps.update(DT);
  assert(ps.count >= 18 && ps.count <= 22, `about 20 in a second, got ${ps.count}`);
  e.stop();
  const n = ps.count;
  for (let i = 0; i < 120; i++) ps.update(DT);
  assert(ps.count === n, 'no more after stop');
});

test('drawing picks frames by life, fades alpha and blends tint over a particle\'s life', () => {
  const ps = new ParticleSystem(10);
  ps.sprites = library();
  const r = fakeRenderer();
  ps.burst({ sprite: 'fx_smoke', frames: 'life', count: 1, life: 1, speed: 0, up: 0, size: [1, 2], tint: [[1, 0, 0], [0, 0, 1]], alpha: [1, 0] }, [0, 0, 0]);
  ps.draw(r);
  const early = r.frames[0];
  for (let i = 0; i < 90; i++) ps.update(DT);
  r.frames.length = 0;
  ps.draw(r);
  const late = r.frames[0];
  assert(early.alpha > 0.95 && late.alpha < 0.35, `alpha ${early.alpha} -> ${late.alpha.toFixed(2)}`);
  assert(late.scale > early.scale, 'grows');
  assert(late.tint[2] > late.tint[0] && early.tint[0] > early.tint[2], 'red to blue');
  assert(late.id !== early.id, 'frame advanced with life (smoke has 3)');
});

test('an unknown preset warns once instead of failing silently or spamming', () => {
  const ps = new ParticleSystem(10);
  ps.sprites = library();
  const warnings = [];
  const orig = console.warn; console.warn = (m) => warnings.push(m);
  ps.burst('nonsense', [0, 0, 0]); ps.burst('nonsense', [0, 0, 0]);
  console.warn = orig;
  assert(warnings.length === 1 && /nonsense/.test(warnings[0]), `warned ${warnings.length} times`);
});

test('floating text rises, fades, expires, and a crit draws larger', () => {
  const ft = new FloatingTexts();
  ft.spawn('12', [0, 1, 0], { color: [1, 0, 0] });
  ft.spawn('40', [3, 1, 0], { crit: true });
  const r = fakeRenderer();
  ft.draw(r);
  assert(r.texts[1].scale > r.texts[0].scale, 'crit is bigger');
  const y0 = ft.items[0].pos[1];
  for (let i = 0; i < 40; i++) ft.update(DT);
  assert(ft.items[0].pos[1] > y0, 'rises');
  r.texts.length = 0;
  for (let i = 0; i < 60; i++) ft.update(DT);   // 0.83s in: both are in their fade-out
  ft.draw(r);
  assert(r.texts.length === 2 && r.texts.every((t) => t.alpha < 1), 'fading near the end');
  for (let i = 0; i < 200; i++) ft.update(DT);
  assert(ft.items.length === 0, 'gone after its life');
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function level(entities, extraBrushes = []) {
  const built = buildMap({
    name: 'e', materials: [{ name: 'lava', generator: 'lava' }],
    brushes: [{ type: 'box', min: [-20, -1, -20], max: [20, 0, 20] }, ...extraBrushes],
  });
  const sprites = library();
  sprites.register({ name: 'goblin', size: [4, 4], palette: { '.': null, k: '#000' },
    animations: { idle: { frames: [['kkkk', 'kkkk', 'kkkk', 'kkkk']] }, death: { loop: false, frames: [['....', '....', '....', 'kkkk']] } } });
  const sys = new ActorSystem({ collision: built.collision, sprites, nav: { top: 4 } });
  const particles = new ParticleSystem(200); particles.sprites = sprites;
  const actor = sys.spawn({ name: 'hero', kind: 'player', faction: 'player', feet: [0, 0, 0], health: 100 });
  const player = new ActorPlayer(actor);
  const travels = [];
  const game = { mode: 'topdown', transitioning: false, cameraYaw: 45 };
  const world = new EntityWorld({
    collision: built.collision, actors: sys, particles, sprites, player, players: [player], game, materialIndex: built.materialIndex,
    travel: (p, map, landmark) => travels.push([map, landmark]),
    findTriggerBrush: () => null, registerDynamicBrush: () => {}, listener: () => [0, 0, 0],
  });
  const spawned = entities.map((e) => world.spawn(e));
  const step = (secs) => { for (let i = 0; i < Math.round(secs / DT); i++) { world.update(DT); sys.update(DT); particles.update(DT); } };
  return { world, sys, actor, player, travels, spawned, step, particles, sprites };
}

test('func_hazard hurts what stands in it on its interval, and not what stands beside it', () => {
  const { actor, step, sys, world } = level([
    { classname: 'func_hazard', name: 'lava', min: [-2, -0.2, -2], max: [2, 0.3, 2], material: 'lava', damage: { type: 'fire', amount: 5 }, interval: 0.5 },
  ]);
  const outside = sys.spawn({ name: 'safe', faction: 'enemy', feet: [6, 0, 0], health: 100 });
  const touches = [];
  world.find('lava')[0].connections = [{ output: 'OnTouch', target: 'sink', input: 'Noop' }];
  step(2.2);
  assert(actor.health === 100 - 5 * 5, `five ticks of 5 in 2.2s (0, .5, 1, 1.5, 2), health ${actor.health}`);
  assert(outside.health === 100, 'unharmed outside');
  void touches;
});

test('func_hazard rises and falls on a timer, and only hurts while it covers you', () => {
  const { actor, step, world } = level([
    { classname: 'func_hazard', name: 'tide', min: [-3, -1, -3], max: [3, -0.5, 3], moveDir: [0, 1, 0], distance: 1.5, speed: 1, auto: true, wait: 0.5,
      damage: { amount: 4 }, interval: 0.25 },
  ]);
  const tide = world.find('tide')[0];
  step(0.4);
  assert(actor.health === 100, 'the low surface is below the feet');
  step(2.5);
  assert(tide.state.max[1] > 0.5, `risen over the feet (top ${tide.state.max[1].toFixed(2)})`);
  assert(actor.health < 100, 'and it hurt once it did');
});

test('trigger_changelevel travels once on entry, not every step inside, and again after leaving and re-entering', () => {
  const { player, step, travels } = level([
    { classname: 'trigger_changelevel', name: 'door', min: [5, 0, 5], max: [8, 2, 8], map: 'game/maps/other.json', landmark: 'arrival', effect: false },
  ]);
  step(0.2);
  assert(travels.length === 0, 'not inside yet');
  player.teleport([6, 0.9, 6]);
  step(0.5);
  assert(travels.length === 1 && travels[0][0] === 'game/maps/other.json' && travels[0][1] === 'arrival', `travelled: ${JSON.stringify(travels)}`);
  player.teleport([0, 0.9, 0]); step(0.1);
  player.teleport([6, 0.9, 6]); step(0.2);
  assert(travels.length === 2, 're-entering travels again');
});

test('actor_npc spawns an actor from keyvalues, wires its outputs, and respawns', () => {
  const { world, sys, actor, step } = level([
    { classname: 'actor_npc', name: 'g1', sprite: 'goblin', title: 'Goblin', origin: [10, 0, 10], health: 20, faction: 'enemy', wanderRadius: 0, aggroRadius: 3,
      corpseTime: 0.5, respawn: 1, connections: [{ output: 'OnDeath', target: 'relay', input: 'Trigger' }] },
    { classname: 'logic_relay', name: 'relay', connections: [] },
  ]);
  const ent = world.find('g1')[0];
  const mob = ent.state.actor;
  assert(mob && mob.name === 'Goblin' && mob.sprite && mob.health === 20 && mob.faction === 'enemy', 'keyvalues applied');
  assert(mob.ai && mob.ai.cfg.aggroRadius === 3, 'flat ai keys land in the ai config');
  let outputs = 0;
  world.find('relay')[0].connections = [];
  const orig = world.fireOutput.bind(world);
  world.fireOutput = (e, name, ...rest) => { if (e === ent && name === 'OnDeath') outputs++; return orig(e, name, ...rest); };
  sys.combat.dealDamage(actor, mob, { amount: 99 });
  assert(outputs === 1, 'OnDeath fired once');
  step(1.2);
  assert(!sys.actors.includes(mob), 'corpse cleared');
  step(1.2);
  assert(ent.state.actor !== mob && ent.state.actor.health === 20 && sys.actors.includes(ent.state.actor), 'respawned at full health');
});

test('actor_npc without a sprite warns, and prop_sprite draws its sprite and shadow', () => {
  const warnings = [];
  const orig = console.warn; console.warn = (m) => warnings.push(m);
  const { world } = level([{ classname: 'actor_npc', origin: [3, 0, 3] }]);
  console.warn = orig;
  assert(warnings.some((w) => /no "sprite"/.test(w)), 'warned about the invisible monster');

  const { world: w2 } = level([{ classname: 'prop_sprite', name: 'torch', sprite: 'fx_fire', origin: [2, 0, 2], scale: 2 }]);
  const r = fakeRenderer();
  w2.draw(r, false);
  assert(r.frames.length === 1 && r.frames[0].scale === 2 && r.blobs.length === 1, 'a sprite and its blob shadow');
  r.frames.length = 0;
  w2.draw(r, true);
  assert(r.frames.length === 0, 'nothing is queued into the shadow pass');
  void world;
});

test('func_hazard draws a tiled box, and not into the shadow pass', () => {
  const { world } = level([{ classname: 'func_hazard', min: [0, 0, 0], max: [2, 0.5, 2], material: 'lava' }]);
  const r = fakeRenderer();
  world.draw(r, false);
  world.draw(r, true);
  assert(r.boxes.length === 1 && r.boxes[0].layer === 0, 'one box, from the lava material');
});

finish();
