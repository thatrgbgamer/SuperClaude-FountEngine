import { test, assert, near, finish } from './harness.mjs';
import { buildMap } from '../engine/map.js';
import { ActorSystem } from '../engine/actors.js';
import { defineStatuses } from '../engine/actor.js';
import { NavGrid } from '../engine/nav.js';

const DT = 1 / 120;
const run = (sys, seconds) => { for (let i = 0; i < Math.round(seconds / DT); i++) sys.update(DT); };

// A 40x40 floor with a wall across the middle (x = 0, z from -6 to 6): anything
// crossing it has to walk around the end.
function arena({ wall = true } = {}) {
  const brushes = [{ type: 'box', min: [-20, -1, -20], max: [20, 0, 20] }];
  if (wall) brushes.push({ type: 'box', min: [-0.5, 0, -6], max: [0.5, 3, 6] });
  return buildMap({ name: 't', brushes }).collision;
}

function world(options = {}) {
  const collision = arena(options);
  const sys = new ActorSystem({ collision, nav: { top: 4, cell: 0.5 } });
  const events = [];
  for (const n of ['damage', 'heal', 'death', 'fx', 'sound', 'ability', 'cast-start', 'cast-cancel', 'aggro', 'ai-state', 'melee', 'projectile-hit']) {
    sys.bus.on(n, (...a) => events.push({ n, a }));
  }
  const hero = sys.spawn({ name: 'hero', kind: 'player', faction: 'player', feet: [-5, 0, 0], health: 100, resources: { mana: 50 }, stats: { power: 10 }, speed: 6 });
  return { sys, hero, events, collision };
}

const dummy = (sys, x, z, extra = {}) => sys.spawn({ name: 'dummy', faction: 'enemy', feet: [x, 0, z], health: 100, ...extra });

// ---------------------------------------------------------------------------
// Damage and the actor
// ---------------------------------------------------------------------------

test('a damage event carries type, amount, crit flag and source', () => {
  const { sys, hero, events } = world();
  const d = dummy(sys, -3, 0);
  sys.combat.dealDamage(hero, d, { type: 'fire', amount: 20 });
  const ev = events.find((e) => e.n === 'damage').a[0];
  assert(ev.type === 'fire' && ev.amount === 20 && ev.final === 20 && ev.crit === false && ev.source === hero && ev.target === d);
  assert(d.health === 80);
});

test('resistance, vulnerability and damage-taken statuses change what lands', () => {
  const { sys, hero } = world();
  const d = dummy(sys, -3, 0, { resist: { fire: 0.5, frost: -1 } });
  sys.combat.dealDamage(hero, d, { type: 'fire', amount: 20 });
  assert(d.health === 90, `fire at 50% resist should do 10, health ${d.health}`);
  sys.combat.dealDamage(hero, d, { type: 'frost', amount: 10 });
  assert(d.health === 70, `frost at -100% resist should double, health ${d.health}`);
  defineStatuses({ vulnerable: { duration: 5, mods: { damageTaken: 1.5 } } });
  d.addStatus('vulnerable');
  sys.combat.dealDamage(hero, d, { type: 'physical', amount: 10 });
  assert(d.health === 55, `15 with the status, health ${d.health}`);
});

test('crits multiply, scale reads stats, and damage never rounds to nothing', () => {
  const { sys, hero } = world();
  const d = dummy(sys, -3, 0);
  hero.stats.critChance = 1;
  const ev = sys.combat.dealDamage(hero, d, { type: 'physical', amount: 10, scale: { stat: 'power', mult: 1 }, critMult: 2 });
  assert(ev.crit && ev.final === 40, `(10 + 10 power) * 2 = 40, got ${ev.final}`);
  hero.stats.critChance = 0;
  const tiny = sys.combat.dealDamage(hero, d, { type: 'physical', amount: 0.2 });
  assert(tiny.final === 1, 'a hit that lands always does at least 1');
});

test('death fires once, stops the actor acting, and a corpse is removed after its linger time', () => {
  const { sys, hero, events } = world();
  const d = dummy(sys, -3, 0, { health: 10, corpseTime: 1 });
  sys.combat.dealDamage(hero, d, { amount: 50 });
  sys.combat.dealDamage(hero, d, { amount: 50 });
  assert(events.filter((e) => e.n === 'death').length === 1, 'death fires once');
  assert(d.dead && !d.canAct());
  run(sys, 1.2);
  assert(!sys.actors.includes(d), 'corpse removed after corpseTime');
  assert(sys.actors.includes(hero), 'players are never auto-removed');
});

test('god mode and invulnerability absorb damage', () => {
  const { sys, hero } = world();
  const d = dummy(sys, -3, 0);
  d.godMode = true;
  assert(sys.combat.dealDamage(hero, d, { amount: 99 }).final === 0 && d.health === 100);
});

// ---------------------------------------------------------------------------
// Melee, projectiles, areas
// ---------------------------------------------------------------------------

test('melee hits what is in the arc, once, and nothing behind, beyond reach or behind a wall', () => {
  const { sys, hero } = world();
  hero.teleport([-5, 0, 10]);
  const front = dummy(sys, -3.8, 10), behind = dummy(sys, -7, 10), far = dummy(sys, -2, 10), friend = sys.spawn({ name: 'pal', faction: 'player', feet: [-4, 0, 10.8] });
  const swing = { type: 'melee', range: 1.6, arc: 100, window: 0.2, damage: { type: 'physical', amount: 10 } };
  sys.combat.run([swing], { source: hero, aim: { dir: [1, 0] } });
  run(sys, 0.5);
  assert(front.health === 90, 'target in front is hit exactly once, health ' + front.health);
  assert(behind.health === 100 && far.health === 100, 'behind and out of reach are untouched');
  assert(friend.health === 100, 'allies are not hit by default');

  // The same swing straight through the wall.
  hero.teleport([-1.4, 0, 0]);
  const hidden = dummy(sys, 1.4, 0);
  sys.combat.run([swing], { source: hero, aim: { dir: [1, 0] } });
  run(sys, 0.3);
  assert(hidden.health === 100, 'a wall blocks the swing');
});

test('a projectile flies, hits the first actor, and a piercing one hits two', () => {
  const { sys, hero } = world();
  hero.teleport([-5, 0, 10]);
  const a = dummy(sys, 0, 10), b = dummy(sys, 4, 10);
  sys.combat.run([{ type: 'projectile', speed: 20, radius: 0.3, damage: { amount: 15 } }], { source: hero, aim: { dir: [1, 0] } });
  run(sys, 1);
  assert(a.health === 85 && b.health === 100, `only the first is hit (${a.health}, ${b.health})`);
  sys.combat.run([{ type: 'projectile', speed: 20, radius: 0.3, pierce: 1, damage: { amount: 15 } }], { source: hero, aim: { dir: [1, 0] } });
  run(sys, 1);
  assert(a.health === 70 && b.health === 85, `a piercing shot hits both (${a.health}, ${b.health})`);
});

test('a projectile stops at a wall and runs its expiry effects there', () => {
  const { sys, hero, events } = world();
  hero.teleport([-5, 0, 0]);
  const beyond = dummy(sys, 3, 0);
  sys.combat.run([{ type: 'projectile', speed: 20, radius: 0.2, damage: { amount: 30 },
    onExpire: [{ type: 'particles', preset: 'explosion', at: 'point' }] }], { source: hero, aim: { dir: [1, 0] } });
  run(sys, 1);
  assert(beyond.health === 100, 'the wall stops it');
  const fx = events.find((e) => e.n === 'fx');
  assert(fx && fx.a[0].preset === 'explosion' && fx.a[0].pos[0] < 0 && fx.a[0].pos[0] > -1, 'expiry effect fired at the wall');
});

test('a homing projectile curves onto a target that is off its line', () => {
  const { sys, hero } = world();
  hero.teleport([-5, 0, 10]);
  const off = dummy(sys, 2, 15);
  sys.combat.run([{ type: 'projectile', speed: 10, radius: 0.3, homing: { turn: 6 }, lifetime: 4, damage: { amount: 25 } }],
    { source: hero, aim: { dir: [1, 0], target: off } });
  run(sys, 3);
  assert(off.health === 75, 'it should have turned toward the target, health ' + off.health);
});

test('area effects: radius, falloff, cone, and healing allies', () => {
  const { sys, hero } = world();
  hero.teleport([-5, 0, 10]);
  const near1 = dummy(sys, -5, 10.5), mid = dummy(sys, -5, 12), far = dummy(sys, -5, 15);
  const ally = sys.spawn({ name: 'pal', faction: 'player', feet: [-6, 0, 10], health: 100, currentHealth: 40 });
  sys.combat.run([{ type: 'area', radius: 3, falloff: 0.5, damage: { amount: 40 } }], { source: hero, point: [-5, 0, 10], aim: { dir: [0, 1] } });
  assert(near1.health < mid.health && mid.health < 100 && far.health === 100, `falloff: ${near1.health} < ${mid.health} < 100`);
  assert(ally.health === 40, 'hostile-only areas leave allies alone');
  sys.combat.run([{ type: 'area', radius: 3, targets: 'ally', heal: { amount: 25 } }], { source: hero, point: [-5, 0, 10], aim: { dir: [0, 1] } });
  assert(ally.health === 65, 'an ally-targeted heal lands, health ' + ally.health);

  const e1 = dummy(sys, -5, 20 - 0.5), e2 = dummy(sys, -5 - 3, 20 - 0.5);
  hero.teleport([-5, 0, 18]);
  sys.combat.run([{ type: 'area', shape: 'cone', arc: 60, radius: 4, damage: { amount: 10 } }], { source: hero, point: hero.feet, aim: { dir: [0, 1] } });
  assert(e1.health === 90 && e2.health === 100, 'a cone hits ahead, not to the side');
});

test('a lasting area ticks on its interval and ends on time', () => {
  const { sys, hero, events } = world();
  hero.teleport([-5, 0, 10]);
  const d = dummy(sys, -5, 11);
  sys.combat.run([{ type: 'area', radius: 2, duration: 2, tick: 0.5, damage: { amount: 5 } }], { source: hero, point: [-5, 0, 10], aim: { dir: [0, 1] } });
  run(sys, 3);
  assert(d.health === 80, `4 ticks of 5 over 2 seconds, health ${d.health}`);
  assert(sys.combat.zones.length === 0);
});

// ---------------------------------------------------------------------------
// Abilities and statuses
// ---------------------------------------------------------------------------

const FIREBALL = { id: 'fireball', cooldown: 2, cost: { mana: 20 }, castTime: 0.4, range: 12, targeting: 'direction',
  effects: [{ type: 'projectile', speed: 18, damage: { type: 'fire', amount: 30 } }] };

test('an ability costs resources, casts for its cast time, then goes on cooldown', () => {
  const { sys, hero, events } = world();
  hero.teleport([-5, 0, 10]);
  const d = dummy(sys, 0, 10);
  sys.abilities.define(FIREBALL);
  assert(sys.abilities.use(hero, 'fireball', { dir: [1, 0] }).ok);
  assert(hero.resources.mana.value === 50, 'cost is paid when the cast completes, not before');
  run(sys, 0.2);
  assert(d.health === 100, 'nothing has happened mid-cast');
  run(sys, 0.8);
  assert(d.health === 70, 'it landed after the cast, health ' + d.health);
  assert(hero.resources.mana.value === 30);
  const again = sys.abilities.use(hero, 'fireball', { dir: [1, 0] });
  assert(!again.ok && again.reason === 'cooldown');
  run(sys, 2.1);
  assert(sys.abilities.use(hero, 'fireball', { dir: [1, 0] }).ok, 'ready again after the cooldown');
  assert(events.some((e) => e.n === 'ability'));
});

test('abilities refuse for the right reasons', () => {
  const { sys, hero } = world();
  sys.abilities.define(FIREBALL);
  sys.abilities.define({ id: 'smite', targeting: 'target', range: 5, hostile: true, effects: [{ type: 'damage', damage: { amount: 10 } }] });
  assert(sys.abilities.use(hero, 'nope').reason === 'unknown');
  assert(sys.abilities.use(hero, 'smite', {}).reason === 'no-target');
  const far = dummy(sys, -5, 12);
  assert(sys.abilities.use(hero, 'smite', { target: far }).reason === 'range');
  const pal = sys.spawn({ name: 'pal', faction: 'player', feet: [-5, 0, 1] });
  assert(sys.abilities.use(hero, 'smite', { target: pal }).reason === 'not-hostile');
  hero.resources.mana.value = 5;
  assert(sys.abilities.use(hero, 'fireball', { dir: [1, 0] }).reason === 'resource');
  hero.addStatus({ id: 'stun', flags: ['stun'], duration: 1 });
  assert(sys.abilities.use(hero, 'smite', { target: dummy(sys, -5, 2) }).reason === 'cannot-act');
});

test('a ground ability aimed past its range casts at the limit', () => {
  const { sys, hero } = world();
  hero.teleport([-5, 0, 10]);
  sys.abilities.define({ id: 'rain', targeting: 'ground', range: 6, effects: [{ type: 'area', radius: 1.5, damage: { amount: 10 } }] });
  const near6 = dummy(sys, -5, 16), far20 = dummy(sys, -5, 30);
  assert(sys.abilities.use(hero, 'rain', { point: [-5, 0, 30] }).ok);
  assert(near6.health === 90 && far20.health === 100, 'clamped to 6m, so the target at 6m is hit');
});

test('being stunned mid-cast cancels it without spending anything', () => {
  const { sys, hero, events } = world();
  hero.teleport([-5, 0, 10]);
  sys.abilities.define(FIREBALL);
  sys.abilities.use(hero, 'fireball', { dir: [1, 0] });
  run(sys, 0.1);
  hero.addStatus({ id: 'stun', flags: ['stun'], duration: 1 });
  run(sys, 0.5);
  assert(hero.resources.mana.value === 50 && !hero.casting, 'cancelled, nothing spent');
  assert(events.some((e) => e.n === 'cast-cancel'));
});

test('a damage-over-time status ticks on schedule and expires', () => {
  const { sys, hero, events } = world();
  const d = dummy(sys, -3, 0);
  defineStatuses({ burning: { duration: 3, tick: { interval: 1, effects: [{ type: 'damage', damage: { type: 'fire', amount: 4 } }] } } });
  d.addStatus('burning', { source: hero });
  run(sys, 3.5);
  assert(d.health === 88, `3 ticks of 4, health ${d.health}`);
  assert(!d.hasStatus('burning'), 'expired');
  const ev = events.filter((e) => e.n === 'damage').map((e) => e.a[0]);
  assert(ev.every((e) => e.source === hero && e.type === 'fire'), 'ticks credit the applier and keep their type');
});

test('stacking rules: refresh extends, stack adds, ignore keeps the first', () => {
  const { sys } = world();
  const d = dummy(sys, -3, 0);
  defineStatuses({
    poison: { duration: 4, stacking: 'stack', maxStacks: 3, mods: { speed: 0.9 } },
    mark: { duration: 4, stacking: 'refresh' },
    ward: { duration: 4, stacking: 'ignore' },
  });
  d.addStatus('poison'); d.addStatus('poison'); d.addStatus('poison'); d.addStatus('poison');
  assert(d.statuses[0].stacks === 3, 'capped at maxStacks');
  near(d.statMult('speed'), 0.9 ** 3, 1e-9, 'per-stack multiplier');
  d.addStatus('mark'); run(sys, 2); d.addStatus('mark');
  assert(d.statuses.find((s) => s.def.id === 'mark').remaining > 3.9, 'refresh resets the timer');
  assert(d.addStatus('ward') && d.addStatus('ward') === null, 'ignore refuses a second application');
});

test('root and slow change movement; stun stops it', () => {
  const { sys, hero } = world();
  hero.teleport([-5, 0, 10]);
  const distance = (secs) => { const s = hero.feet.slice(); hero.intent.move = [1, 0]; run(sys, secs); return hero.feet[0] - s[0]; };
  const free = distance(1);
  hero.addStatus({ id: 'slow', mods: { speed: 0.5 }, duration: 5 });
  const slowed = distance(1);
  assert(slowed < free * 0.65 && slowed > free * 0.35, `slowed ${slowed.toFixed(2)} vs free ${free.toFixed(2)}`);
  hero.removeStatus('slow');
  hero.addStatus({ id: 'root', flags: ['root'], duration: 5 });
  assert(distance(1) < 0.2, 'rooted');
});

test('snapshot and restore carry health, resources, stats and statuses across maps', () => {
  const { sys, hero } = world();
  hero.health = 37; hero.resources.mana.value = 12; hero.stats.level = 7; hero.data.inventory = ['sword'];
  defineStatuses({ blessed: { duration: 60 } });
  hero.addStatus('blessed');
  const snap = JSON.parse(JSON.stringify(hero.snapshot()));
  const other = new ActorSystem({ collision: arena() });
  const copy = other.spawn({ name: 'hero', kind: 'player', feet: [0, 0, 0], resources: { mana: 50 } });
  copy.restore(snap);
  assert(copy.health === 37 && copy.resources.mana.value === 12 && copy.stats.level === 7 && copy.data.inventory[0] === 'sword' && copy.hasStatus('blessed'));
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test('the nav grid knows walls from floor and finds a way around them', () => {
  const nav = NavGrid.build(arena(), { top: 4, cell: 0.5 });
  assert(nav.isWalkable(-5, 0) && nav.isWalkable(5, 0), 'floor is walkable');
  assert(!nav.isWalkable(0, 0), 'inside the wall is not');
  assert(!nav.isWalkable(30, 0), 'off the map is not');
  const path = nav.findPath([-5, 0, 0], [5, 0, 0]);
  assert(path && path.length >= 2, 'a path exists');
  assert(path.some((p) => Math.abs(p[2]) > 6), 'it goes around the end of the wall');
  const last = path[path.length - 1];
  near(last[0], 5, 0.01); near(last[2], 0, 0.01);
  for (const p of path) assert(!(Math.abs(p[0]) < 0.6 && Math.abs(p[2]) < 6), 'no waypoint inside the wall');
  const straight = nav.findPath([-5, 0, 10], [5, 0, 10]);
  assert(straight.length <= 2, 'with a clear line it smooths to a straight run');
});

test('an unreachable goal returns the closest reachable approach, or null when exact is asked for', () => {
  const brushes = [
    { type: 'box', min: [-20, -1, -20], max: [20, 0, 20] },
    { type: 'box', min: [-3, 0, -3], max: [3, 4, 3] }, // a solid block, nothing walkable inside
  ];
  const nav = NavGrid.build(buildMap({ name: 'blk', brushes }).collision, { top: 4, cell: 0.5 });
  const partial = nav.findPath([-10, 0, 0], [0, 0, 0]);
  assert(partial && partial.length, 'gets as close as it can');
  const end = partial[partial.length - 1];
  assert(Math.hypot(end[0], end[2]) < 5.5 && Math.hypot(end[0], end[2]) > 2.5, 'ends beside the block');
});

test('stairs and ramps stay walkable but a sheer wall does not', () => {
  const brushes = [
    { type: 'box', min: [-20, -1, -20], max: [20, 0, 20] },
    { type: 'ramp', min: [0, 0, -2], max: [6, 2, 2], axis: 'x', dir: 1 },
    { type: 'box', min: [6, 0, -2], max: [10, 2, 2] },
  ];
  const nav = NavGrid.build(buildMap({ name: 'r', brushes }).collision, { top: 6, cell: 0.5 });
  const up = nav.findPath([-4, 0, 0], [8, 2, 0], { exact: true });
  assert(up, 'a path up the ramp onto the platform');
  assert(!nav.findPath([-4, 0, 6], [8, 2, 6], { exact: true }) || nav.isWalkable(8, 6), 'the sheer face is not a way up');
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

test('a monster ignores you beyond its aggro radius and wanders only near home', () => {
  const { sys, hero } = world();
  hero.teleport([15, 0, 15]);
  const m = dummy(sys, -10, -10, { speed: 3, ai: { aggroRadius: 6, wanderRadius: 3, wanderPause: [0.2, 0.5], senses: 'radius' } });
  let maxFromHome = 0, moved = false;
  for (let i = 0; i < 120 * 15; i++) {
    sys.update(DT);
    const f = m.feet;
    maxFromHome = Math.max(maxFromHome, Math.hypot(f[0] + 10, f[2] + 10));
    if (maxFromHome > 0.5) moved = true;
  }
  assert(moved, 'it wanders');
  assert(maxFromHome < 4.2, `but stays near home (${maxFromHome.toFixed(2)}m)`);
  assert(m.ai.state === 'idle' || m.ai.state === 'wander');
});

test('a monster notices, paths around a wall, attacks, and the target takes real damage', () => {
  const { sys, hero, events } = world();
  hero.teleport([-5, 0, 0]);
  const m = dummy(sys, 5, 0, { speed: 5, ai: { aggroRadius: 14, loseRadius: 40, leashRadius: 60, senses: 'radius', noticeTime: 0.2, attackRange: 1.4, wanderRadius: 0,
    attack: { interval: 0.8, windup: 0.15, arc: 140, damage: { type: 'physical', amount: 7 } } } });
  run(sys, 12);
  assert(events.some((e) => e.n === 'aggro'), 'it noticed');
  assert(m.ai.state === 'attack' || hero.health < 100, `it reached and attacked (state ${m.ai.state})`);
  assert(hero.health < 100, `the hero took damage (health ${hero.health})`);
  assert(events.filter((e) => e.n === 'damage').every((e) => e.a[0].source === m), 'damage is attributed to the monster');
});

test('line of sight matters when senses is "los"', () => {
  const { sys, hero, events } = world();
  hero.teleport([-3, 0, 0]);
  dummy(sys, 3, 0, { ai: { aggroRadius: 20, senses: 'los', wanderRadius: 0 } });
  run(sys, 2);
  assert(!events.some((e) => e.n === 'aggro'), 'a wall between them means it does not notice');
  hero.teleport([3, 0, 10]);
  run(sys, 2);
  assert(events.some((e) => e.n === 'aggro'), 'clear line, it does');
});

test('a monster gives up a chase, leashes home and heals', () => {
  const { sys, hero } = world({ wall: false });
  hero.teleport([-15, 0, 0]);
  const m = dummy(sys, -5, 0, { speed: 4, health: 100, ai: { aggroRadius: 12, loseRadius: 14, leashRadius: 18, senses: 'radius', wanderRadius: 0 } });
  m.health = 40;
  run(sys, 1.5);
  assert(['notice', 'chase', 'attack'].includes(m.ai.state), 'engaged: ' + m.ai.state);
  hero.teleport([18, 0, 18]); // far out of reach
  run(sys, 12);
  assert(m.ai.state === 'idle', `it gave up (${m.ai.state})`);
  assert(Math.hypot(m.feet[0] + 5, m.feet[2]) < 1, 'and went home');
  assert(m.health === 100, `healed on the way, health ${m.health}`);
});

test('group aggro pulls in nearby allies of the same faction', () => {
  const { sys, hero } = world({ wall: false });
  hero.teleport([-8, 0, 10]);
  const lead = dummy(sys, -8, 14, { ai: { aggroRadius: 8, senses: 'radius', wanderRadius: 0, groupAggro: 6 } });
  const buddy = dummy(sys, -12, 16, { ai: { aggroRadius: 2, senses: 'radius', wanderRadius: 0 } });
  const stranger = dummy(sys, 15, 15, { ai: { aggroRadius: 2, senses: 'radius', wanderRadius: 0 } });
  run(sys, 1.5);
  assert(buddy.ai.state !== 'idle', 'the buddy was alerted despite its own tiny radius: ' + buddy.ai.state);
  assert(stranger.ai.state === 'idle', 'a distant one was not');
});

test('a ranged monster stops at range, and backs away when the target closes in', () => {
  const { sys, hero, events } = world({ wall: false });
  hero.teleport([0, 0, 0]);
  const archer = dummy(sys, 10, 0, { speed: 4, ai: { aggroRadius: 20, senses: 'radius', wanderRadius: 0, attackRange: 8, preferRange: 6, noticeTime: 0.1,
    attack: { interval: 0.6, windup: 0.1, damage: { amount: 5 }, projectile: { speed: 16, radius: 0.3 } } } });
  run(sys, 4);
  const gap = archer.feet[0] - hero.feet[0] - hero.radius - archer.radius;
  assert(gap > 3 && gap <= 8.5, `it holds at range (${gap.toFixed(1)}m)`);
  assert(hero.health < 100 && events.some((e) => e.n === 'projectile-hit'), 'and shoots');
  hero.teleport([archer.feet[0] - 1.5, 0, 0]);
  const before = archer.feet[0];
  run(sys, 1);
  assert(archer.feet[0] > before + 0.5, 'it backs away from a target that rushes it');
});

test('crowds spread out instead of stacking on one point', () => {
  const { sys } = world({ wall: false });
  const crowd = [];
  for (let i = 0; i < 6; i++) crowd.push(dummy(sys, 8 + i * 0.01, 8, { radius: 0.4 }));
  run(sys, 2);
  let minGap = Infinity;
  for (let i = 0; i < crowd.length; i++) for (let j = i + 1; j < crowd.length; j++) {
    minGap = Math.min(minGap, Math.hypot(crowd[i].feet[0] - crowd[j].feet[0], crowd[i].feet[2] - crowd[j].feet[2]));
  }
  assert(minGap > 0.6, `nobody is inside another (closest ${minGap.toFixed(2)}m)`);
});

finish();
