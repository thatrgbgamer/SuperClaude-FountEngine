import { test, assert, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { defineEntity } from '../engine/entity.js';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';
import { NetSession } from '../engine/netcode.js';

// A test class: visible to one named player only, with a replicated counter.
defineEntity('test_private', {
  server: {
    spawn(e) { e.state.n = 0; e.visibleTo = (p) => p.actor.name === e.get('only'); },
    think(e) { e.state.n++; },
    replicate(e) { return { n: e.state.n > 0 ? 1 : 0 }; },
  },
  client: {},
});

const root = makeGameFolder({
  arenaInstance: { policy: 'shared', cap: 2, idleTimeout: 1 },
  roomInstance: { policy: 'party', cap: 5, idleTimeout: 1 },
  arenaEntities: [{ classname: 'test_private', name: 'secret', only: 'Alice', origin: [-9, 0, 1] }],
});
const server = await startServer({ root, port: 0, quiet: true, host: '127.0.0.1', reconnectGraceSeconds: 1.2 });
const mgr = server.manager;
const bots = [];
const bot = (name) => { const b = new Bot(server.port, root, { name }); bots.push(b); return b; };
const instOf = (b) => mgr.instances.get(b.welcomes[b.welcomes.length - 1].instance);
const serverPlayer = (b) => instOf(b).players.find((p) => p.id === b.session.playerId);
const leave = (b) => { b.leave(); };

test('shared instances fill to their cap, then overflow into a new copy', async () => {
  const a = bot('Alice'), b = bot('Bob'), c = bot('Cora');
  await a.join(); await b.join(); await c.join();
  const [ia, ib, ic] = [a, b, c].map((x) => x.welcomes[0].instance);
  assert(ia === ib && ic !== ia, `Alice ${ia}, Bob ${ib}, Cora ${ic}`);
  const insts = [...mgr.instances.values()].filter((i) => i.mapPath.endsWith('arena.json'));
  assert(insts.length === 2 && insts.every((i) => i.players.length <= 2));
  await waitFor(() => a.actorNamed('Bob'), 2000);
  await sleep(300);
  assert(!a.actorNamed('Cora') && !c.actorNamed('Alice'), 'players in different copies never see each other');
});

test('a later player is packed into the fullest copy that still has room', async () => {
  const d = bot('Dan');
  await d.join();
  const ic = [...mgr.instances.values()].find((i) => i.players.some((p) => p.actor.name === 'Cora'));
  assert(d.welcomes[0].instance === ic.id, `Dan went to ${d.welcomes[0].instance}, Cora is in ${ic.id}`);
});

test('what happens in one instance cannot be seen from another', async () => {
  const a = bots[0], c = bots[2];
  const impA = [...instOf(a).actors.actors].find((x) => x.name === 'Imp');
  const hp = [...instOf(c).actors.actors].find((x) => x.name === 'Imp').health;
  impA.takeDamage({ amount: 30, type: 'physical', source: null });
  await sleep(300);
  const impC = [...instOf(c).actors.actors].find((x) => x.name === 'Imp');
  assert(impC.health === hp, 'the other copy\'s imp is untouched');
  assert(a.actorNamed('Imp').health < impA.maxHealth && c.actorNamed('Imp').health === impC.maxHealth, 'and each client sees only its own');
});

test('per-player visibility and notifications reach only the right players', async () => {
  const [alice, bob] = [bots[0], bots[1]];
  const secret = instOf(alice).world.find('secret')[0];
  await waitFor(() => alice.entityStates.has(secret.id) && bob.entityStates.has(secret.id), 2000, 'both to be told about the entity');
  assert(alice.entityStates.get(secret.id).h === undefined || alice.entityStates.get(secret.id).h === 0, 'Alice may see it');
  assert(bob.entityStates.get(secret.id).h === 1, 'Bob is told to hide it');
  serverPlayer(alice).notify('toast', { text: 'JUST FOR ALICE' });
  await waitFor(() => alice.events.some((e) => e.ty === 'note' && e.d.text === 'JUST FOR ALICE'), 1000);
  await sleep(150);
  assert(!bob.events.some((e) => e.ty === 'note'), 'Bob heard nothing');
});

test('entities created at runtime are announced to clients, and their removal too', async () => {
  const [alice, bob] = [bots[0], bots[1]];
  const world = instOf(alice).world;
  const e = world.spawn({ classname: 'light', origin: [1, 1, 1], name: 'dyn' });
  await waitFor(() => alice.entitySpawns.length && bob.entitySpawns.length, 1500, 'the spawn to arrive');
  const s = alice.entitySpawns.find((x) => x.i === e.id);
  assert(s && s.c === 'light' && s.o.join() === '1,1,1' && s.kv.name === 'dyn' && e.id >= 1_000_000, JSON.stringify(s));
  world.remove(e);
  await waitFor(() => alice.entityRemoves.includes(e.id) && bob.entityRemoves.includes(e.id), 1500, 'the removal to arrive');
});

test('a portal moves a player to another map, carrying their character, while others stay', async () => {
  const [alice, bob] = [bots[0], bots[1]];
  const sp = serverPlayer(alice);
  sp.actor.data.gold = 42;
  sp.actor.health = 55;
  sp.actor.teleport([11, 0, 10]);       // just outside the door at x 12..15, z 8..12
  alice.walk(1, 0);
  await waitFor(() => alice.travels.length > 0 && alice.welcomes.length >= 2, 3000, 'the travel and the new welcome');
  alice.stand();
  const w = alice.welcomes[1];
  assert(w.map === 'game/maps/room.json' && w.instance !== alice.welcomes[0].instance, JSON.stringify([w.map, w.instance]));
  assert(alice.travels[0].landmark === 'from_arena' && alice.travels[0].map === 'game/maps/room.json');
  const now = serverPlayer(alice);
  assert(now.instance.mapPath.endsWith('room.json') && now.actor.data.gold === 42 && now.actor.health === 55, 'character carried');
  const f = now.actor.feet;
  assert(Math.hypot(f[0] - -6, f[2] - 6) < 1.5, `arrived at the landmark, at ${f.map((v) => v.toFixed(1))}`);
  await waitFor(() => !bob.actorNamed('Alice'), 2000, 'Bob to see Alice leave');
  assert(bob.session.actors.size >= 2);
});

test('a player in a party map lands in a private copy, and a second party member joins the same one', async () => {
  const [alice, bob] = [bots[0], bots[1]];
  const roomsBefore = [...mgr.instances.values()].filter((i) => i.mapPath.endsWith('room.json')).length;
  const sa = serverPlayer(alice);
  sa.partyId = 'party-1';
  const bp = serverPlayer(bob);
  bp.partyId = 'party-1';
  bp.actor.teleport([11, 0, 10]);
  bob.walk(1, 0);
  await waitFor(() => bob.welcomes.length >= 2, 3000, 'Bob to arrive');
  bob.stand();
  assert(bob.welcomes[1].map.endsWith('room.json'));
  // Alice travelled before she had a party, so she is in a copy of her own; a new arrival with the party's id gets a copy shared by the party.
  const rooms = [...mgr.instances.values()].filter((i) => i.mapPath.endsWith('room.json'));
  assert(rooms.length === roomsBefore + 1, 'Bob\'s party got its own copy');
  const bobRoom = instOf(bob);
  assert(bobRoom.partyId === 'party-1' && bobRoom.players.length === 1);
});

test('the way back works too, to the right landmark in the shared map', async () => {
  const alice = bots[0];
  const sp = serverPlayer(alice);
  sp.actor.teleport([-11, 0, 9]);
  alice.walk(1, 0);
  await waitFor(() => alice.welcomes.length >= 3, 3000, 'Alice to arrive back');
  alice.stand();
  const back = alice.welcomes[2];
  assert(back.map.endsWith('arena.json'));
  const f = serverPlayer(alice).actor.feet;
  assert(Math.hypot(f[0] - 10, f[2] - 10) < 1.5, `arrived at from_room, at ${f.map((v) => v.toFixed(1))}`);
});

test('a portal to a map that does not exist is refused kindly and nothing moves', async () => {
  const alice = bots[0];
  const before = alice.welcomes.length;
  const sp = serverPlayer(alice);
  mgr.requestTravel(sp, 'game/maps/nowhere.json', null);
  await waitFor(() => alice.events.some((e) => e.ty === 'note' && /BLOCKED/.test(JSON.stringify(e.d))), 1500, 'the refusal');
  assert(alice.welcomes.length === before, 'no new welcome: nothing moved');
  assert(serverPlayer(alice) === sp && sp.instance.players.includes(sp) && !sp.traveling, 'still where they were, and free to try again');
});

test('a dropped connection keeps the player in the world, and a reconnect with the token returns them', async () => {
  const bob = bots[1];
  const sp = serverPlayer(bob);
  const token = bob.welcomes[bob.welcomes.length - 1].resume;
  const actorId = sp.actor.id;
  const room = instOf(bob);
  sp.actor.data.mark = 'kept';
  bob.drop();
  await waitFor(() => sp.disconnectedAt !== null, 1000, 'the server to notice');
  assert(room.players.includes(sp) && sp.actor.system, 'still in the world during the grace period');

  const again = new NetSession({ url: `ws://127.0.0.1:${server.port}`, hello: { game: 'testgame', name: 'Bob', resume: token } });
  const w = await again.connect();
  assert(w.resumed === true && w.actor === actorId && w.instance === room.id, JSON.stringify([w.resumed, w.actor, w.instance]));
  await waitFor(() => again.own && again.own.dd && again.own.dd.mark === 'kept', 1500, 'the full state to be resent');
  assert(sp.disconnectedAt === null && sp.session, 'reattached');
  again.close();
  await sleep(100);
});

test('a player who never comes back is removed after the grace period', async () => {
  const carol = bot('Carol');
  await carol.join();
  const sp = serverPlayer(carol);
  const room = instOf(carol);
  carol.drop();
  await waitFor(() => !room.players.includes(sp), 4000, 'the body to be removed');
  assert(!room.actors.actors.includes(sp.actor));
});

test('an empty copy is torn down after its idle timeout, and static ones never are', async () => {
  for (const b of bots) b.leave();
  await sleep(300);
  for (const i of mgr.instances.values()) for (const p of [...i.players]) i.removePlayer(p);
  await waitFor(() => ![...mgr.instances.values()].some((i) => i.mapPath.endsWith('room.json')), 6000, 'the room copies to close');
  assert(![...mgr.instances.values()].some((i) => i.players.length), 'and nobody is left in any copy');
});

test('a static map spreads players to the emptiest copy and its copies are never torn down', async () => {
  server.gameData.maps.get('game/maps/room.json').config.instance = { policy: 'static', cap: 2, idleTimeout: 0.2 };
  const first = await mgr.instanceFor('game/maps/room.json', { playerId: 'x' });
  const fake = (n) => ({ id: `f${n}`, session: { send() {} }, config: { name: `F${n}` } });
  first.addPlayer(fake(1));
  const second = await mgr.instanceFor('game/maps/room.json', { playerId: 'y' });
  assert(second === first, 'with room left, the same copy');
  first.addPlayer(fake(2));
  const third = await mgr.instanceFor('game/maps/room.json', { playerId: 'z' });
  assert(third !== first, 'a full copy overflows');
  for (const p of [...first.players]) first.removePlayer(p);
  await sleep(2600);
  assert(mgr.instances.has(first.id), 'an empty static copy is kept for good');
});

for (const b of bots) b.stop();
await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
