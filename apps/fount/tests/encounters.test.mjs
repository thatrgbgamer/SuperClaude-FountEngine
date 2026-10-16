import { test, assert, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { defineEntity } from '../engine/entity.js';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

defineEntity('test_pickup', { server: { spawn(e) { e.state.n = 1; }, replicate(e) { return { n: e.state.n }; } }, client: {} });

const ABILITIES = {
  strike: { name: 'Strike', cooldown: 0.2, castTime: 0, targeting: 'direction', range: 3, anim: 'attack',
    effects: [{ type: 'melee', range: 3, arc: 360, damage: { type: 'physical', amount: [10, 10] } }] },
  mend: { name: 'Mend', cooldown: 0.5, castTime: 0, targeting: 'target', friendly: true, range: 14,
    effects: [{ type: 'heal', heal: { amount: 25 } }] },
  ward: { name: 'Ward', cooldown: 0.5, castTime: 0, targeting: 'self', range: 6,
    effects: [{ type: 'area', radius: 6, targets: 'ally', includeSource: true, heal: { amount: 10 } }] },
};
const BOSS = { classname: 'actor_npc', name: 'boss', title: 'Boss', sprite: 'dummy', origin: [0, 0, -14], health: 200, speed: 3, aggroRadius: 0.1,
  scales: true, resetOnWipe: true, attackRange: 1.2, attack: { interval: 1, windup: 0.2, damage: { type: 'physical', amount: 5 } } };

const root = makeGameFolder({
  config: {
    server: { startMap: 'game/maps/arena.json', scaling: { hp: [1, 1.5, 2], damage: [1, 1.2, 1.4] }, viewRadius: 60 },
    abilities: ABILITIES,
    player: { health: 100, speed: 6, hotbar: ['strike', 'mend', 'ward'], respawnDelay: 30 },
  },
  arenaInstance: { policy: 'shared', cap: 10, pvp: 'flagged' },
  arenaEntities: [BOSS],
});
const server = await startServer({ root, port: 0, quiet: true, host: '127.0.0.1' });
const social = server.social;
const hooks = [];
const orig = server.gameData.callHook.bind(server.gameData);
server.gameData.callHook = (name, ...args) => {
  if (['actorDied', 'encounterReset', 'duelEnded', 'pvpKill'].includes(name)) { hooks.push([name, args]); return undefined; }
  if (name === 'scalePlayer') return server.sidekick || undefined;
  return orig(name, ...args);
};
const bots = [];
const bot = (name) => { const b = new Bot(server.port, root, { name }); bots.push(b); return b; };
const pl = (b) => social.byName(b.session.self.name);
const place = (b, x, z) => { const p = pl(b).actor.controller.position; p[0] = x; p[2] = z; };

const a = bot('Alice');
await a.join();
const inst = pl(a).instance;
const boss = inst.actors.actors.find((x) => x.name === 'Boss');
const imp = inst.actors.actors.find((x) => x.name === 'Imp');
const baseHp = boss.maxHealth;
let b = bot('Bob');
await b.join();
place(a, -10, 0); place(b, -9, 0);

test('monsters marked as scaling follow the size of the group, and unmarked ones do not', async () => {
  await sleep(700);
  assert(baseHp === 200, `unscaled with one player (${baseHp})`);
  assert(boss.maxHealth === 300, `x1.5 with two (${boss.maxHealth})`);
  assert(imp.maxHealth === 60, 'the imp does not scale');
  b.leave();
  await waitFor(() => boss.maxHealth === 200, 3000, 'back to base when Bob leaves');
  b = bot('Bob');
  await b.join();
  await waitFor(() => boss.maxHealth === 300, 3000);
  place(b, -9, 0);
});

test('damage earns threat and the monster fights whoever has most, with hysteresis', () => {
  const A = pl(a).actor, B = pl(b).actor;
  place(a, 0, 6); place(b, 1, 6);
  imp.ai.threat.clear();
  imp.ai.setState('chase');
  imp.ai.target = A;
  const hit = (src, n) => inst.actors.combat.dealDamage(src, imp, { type: 'physical', amount: n });
  hit(A, 10); hit(B, 11);
  imp.ai.chooseTarget();
  assert(imp.ai.target === A, 'not worth switching for 10% more');
  hit(B, 30);
  imp.ai.chooseTarget();
  assert(imp.ai.target === B, `switches to Bob (${[...imp.ai.threat.values()]})`);
  inst.actors.combat.run([{ type: 'threat', taunt: true }], { source: A, target: imp });
  imp.ai.chooseTarget();
  assert(imp.ai.target === A, 'a taunt takes the top');
  const before = imp.ai.threat.get(B);
  B.heal(0.0001);                                       // healing nobody earns nothing
  A.health = 40; B.heal(20, B);
  inst.actors.combat.system.bus.emit('heal', { source: B, target: A, amount: 20 });
  assert(imp.ai.threat.get(B) > before, 'healing the tank draws threat');
  imp.ai.setState('idle');
  assert(imp.ai.threat.size === 0, 'threat resets when the monster gives up');
  imp.ai.threat.clear();
});

test('friendly-target and ally-area abilities work on other players', async () => {
  const A = pl(a).actor;
  A.health = 30;
  b.session.useAbility('mend', { target: A.id });
  await waitFor(() => A.health >= 55, 2000, 'Bob healed Alice');
  A.health = 30;
  pl(b).actor.health = 30;
  b.session.useAbility('ward');
  await waitFor(() => A.health >= 40 && pl(b).actor.health >= 40, 2000, 'ward healed both');
  imp.health = imp.maxHealth - 10;
  b.session.useAbility('ward');
  await sleep(400);
  assert(imp.health === imp.maxHealth - 10, 'allies only');
});

test('players cannot hurt each other unless both are flagged, and party members are never fair game', async () => {
  const A = pl(a).actor, B = pl(b).actor;
  B.health = B.maxHealth;
  a.session.useAbility('strike', { dir: [1, 0] });
  await sleep(300);
  assert(B.health === B.maxHealth, 'no flags, no damage');
  a.session.send({ t: 'pvp', op: 'flag' }); b.session.send({ t: 'pvp', op: 'flag' });
  await waitFor(() => inst.encounters.pvp.flagged(A) && inst.encounters.pvp.flagged(B), 2000);
  await sleep(300);
  a.session.useAbility('strike', { dir: [1, 0] });
  await waitFor(() => B.health < B.maxHealth, 2000, 'flagged players can fight');
  assert(!imp.isHostile(imp), 'sanity');
  const P = inst.encounters.pvp;
  P.sameParty = () => true;
  assert(!P.hostile(A, B), 'party members are protected');
  P.sameParty = (x, y) => !!(x.player.partyId && x.player.partyId === y.player.partyId);
  A.publicData.pvp = undefined;
  for (const x of [A, B]) P.setFlag(x, false);
});

test('a duel is consensual, hostile only between its two players, and stops short of death', async () => {
  const A = pl(a).actor, B = pl(b).actor;
  A.health = A.maxHealth; B.health = B.maxHealth;
  b.session.send({ t: 'pvp', op: 'duel-accept' });          // nothing to accept
  a.session.send({ t: 'pvp', op: 'duel', name: b.session.self.name });
  await sleep(150);
  b.session.send({ t: 'pvp', op: 'duel-accept' });
  await waitFor(() => inst.encounters.pvp.opponentOf(A) === B, 2000, `duel on (${a.chats.map((c) => c.text)} / ${b.chats.map((c) => c.text)})`);
  B.health = 5;
  inst.actors.combat.dealDamage(A, B, { type: 'physical', amount: 500 });
  assert(B.health === 1 && !B.dead, `loser left on one health (${B.health})`);
  assert(!inst.encounters.pvp.opponentOf(A), 'the duel ended');
  assert(hooks.some(([n]) => n === 'duelEnded'));
});

test('a wipe resets the monsters that asked to be reset, and fires the hook', async () => {
  boss.health = 80;
  boss.ai.threat.set(pl(a).actor, 50);
  boss.ai.target = pl(a).actor;
  for (const x of [a, b]) inst.actors.combat.dealDamage(boss, pl(x).actor, { type: 'physical', amount: 9999, ignoreResist: true });
  await waitFor(() => boss.health === boss.maxHealth, 3000, 'boss healed');
  assert(boss.ai.threat.size === 0 && boss.ai.target === null);
  assert(hooks.some(([n]) => n === 'encounterReset'));
  assert(hooks.some(([n, args]) => n === 'actorDied' && args[1] === pl(a).actor));
});

test('loot can be personal (one copy per recipient, seen only by them) or shared', async () => {
  for (const x of [a, b]) { pl(x).actor.revive(); }
  await sleep(200);
  const A = pl(a), B = pl(b);
  const before = (x) => x.entitySpawns.length;
  const [na, nb] = [before(a), before(b)];
  const drops = inst.encounters.dropLoot({ classname: 'test_pickup', origin: [-5, 0, 0] }, { mode: 'personal', recipients: [A] });
  assert(drops.length === 1);
  await waitFor(() => before(a) === na + 1, 2000, 'Alice sees hers');
  await sleep(250);
  assert(before(b) === nb, 'Bob does not see it');
  inst.encounters.dropLoot({ classname: 'test_pickup', origin: [-4, 0, 0] }, { mode: 'shared' });
  await waitFor(() => before(a) === na + 2 && before(b) === nb + 1, 2000, 'shared loot is seen by both');
  void B;
});

test('a hook can sidekick a player: scaled while in the instance, saved unscaled', async () => {
  const c = bot('Cora');
  server.sidekick = { hp: 0.5, damageDealt: 0.5 };
  await c.join();
  const C = pl(c).actor;
  assert(C.maxHealth === 50, `half health (${C.maxHealth})`);
  assert(C.snapshot().maxHealth === 100, 'the saved character keeps its real health');
  server.sidekick = null;
  c.leave();
});

for (const x of bots) x.stop();
await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
