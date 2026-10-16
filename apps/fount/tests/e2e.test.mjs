// The whole online loop in one test, through the real HTTP API, real WebSockets and the real client netcode:
// two accounts, two characters, one monster, one party, one instance move, one disconnect and reconnect, one save.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { AccountClient } from '../engine/account.js';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

const root = makeGameFolder({ config: { server: { startMap: 'game/maps/arena.json' } } });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fount-e2e-'));
const server = await startServer({
  root, port: 0, quiet: true, host: '127.0.0.1', auth: 'required', reconnectGraceSeconds: 5, backupIntervalMinutes: 0,
  store: { kind: 'file', path: path.join(data, 'store') },
});
const base = `http://127.0.0.1:${server.port}`;
const makeAccount = () => new AccountClient(base, { fetch, storageKey: 'x' });

const alice = makeAccount(), bob = makeAccount();
await alice.register('alice', 'a long password 1');
await bob.register('bob', 'another long password');
const ac = await alice.createCharacter('Aeris', 'warrior');
const bc = await bob.createCharacter('Brann', 'ranger');

const bots = [];
const join = async (acct, ch) => {
  const b = new Bot(server.port, root, acct.hello(ch.id));
  bots.push(b);
  await b.join();
  return b;
};
const social = server.social;
const pl = (name) => social.byName(name);

let a, b;

test('two players log in with their characters and see each other', async () => {
  a = await join(alice, ac);
  b = await join(bob, bc);
  assert(a.welcomes[0].name === 'Aeris' && b.welcomes[0].name === 'Brann');
  await waitFor(() => a.actorNamed('Brann') && b.actorNamed('Aeris'), 3000, 'each sees the other');
  assert(a.welcomes[0].instance === b.welcomes[0].instance, 'same shared copy');
});

test('a monster is killed by a player and both clients see it die', async () => {
  const inst = pl('Aeris').instance;
  const imp = inst.actors.actors.find((x) => x.name === 'Imp');
  const p = pl('Aeris').actor.controller.position;
  p[0] = imp.feet[0] + 1; p[2] = imp.feet[2];
  const face = [imp.feet[0] - p[0], imp.feet[2] - p[2]];
  for (let i = 0; i < 12 && !imp.dead; i++) { a.session.useAbility('strike', { dir: face }); await sleep(250); }
  assert(imp.dead, `the imp is dead (hp ${imp.health})`);
  await waitFor(() => b.eventsOf('death').length > 0, 2000, 'Brann sees the death');
});

test('they form a party and travel together to a private party instance', async () => {
  a.partyOp('invite', 'Brann');
  await waitFor(() => b.partyMsgs.some((m) => m.ev === 'invite'), 2000);
  b.partyOp('accept');
  await waitFor(() => a.party && a.party.members.length === 2, 2000, 'party formed');
  const mgr = server.manager;
  await mgr.requestTravel(pl('Aeris'), 'game/maps/room.json', 'from_arena');
  await mgr.requestTravel(pl('Brann'), 'game/maps/room.json', 'from_arena');
  await waitFor(() => a.welcomes.length === 2 && b.welcomes.length === 2, 3000, 'both arrived');
  assert(a.welcomes[1].instance === b.welcomes[1].instance, 'the same party copy');
  assert(a.welcomes[1].instance !== a.welcomes[0].instance && /room/.test(a.welcomes[1].instance));
  await waitFor(() => a.actorNamed('Brann'), 2000, 'together in the room');
  assert(a.party && a.party.members.length === 2, 'the party survived the move');
});

test('a dropped connection resumes in place, in the same party', async () => {
  const before = [...pl('Brann').actor.feet];
  const token = b.welcomes[1].resume;
  const roomId = b.welcomes[1].instance;
  b.drop();
  await waitFor(() => pl('Brann') && pl('Brann').disconnectedAt !== null, 2000, 'server notices');
  assert(a.party.members.length === 2, 'still a member while away');
  const b2 = new Bot(server.port, root, { resume: token, ...bob.hello(bc.id) });
  bots.push(b2);
  const w = await b2.join();
  assert(w.resumed && w.instance === roomId, 'resumed into the same instance');
  const now = pl('Brann').actor.feet;
  assert(Math.hypot(now[0] - before[0], now[2] - before[2]) < 0.5, 'standing where they were');
  await waitFor(() => b2.party && b2.party.members.length === 2, 2000, 'party frame resent');
  b = b2;
});

test('leaving saves the characters where they stood', async () => {
  a.leave(); b.leave();
  await waitFor(() => !pl('Aeris') && !pl('Brann'), 8000, 'both gone');
  await sleep(300);
  const saved = await server.store.getCharacter(ac.id);
  assert(saved.record.position && /room/.test(saved.record.position.map), `saved in the room (${saved.record.position && saved.record.position.map})`);
  assert(saved.record.snapshot && saved.record.snapshot.maxHealth === 100);
  const again = new Bot(server.port, root, alice.hello(ac.id));
  bots.push(again);
  const w = await again.join();
  assert(/room/.test(w.map), 'logging in again puts them back where they were');
});

for (const x of bots) x.stop();
await finish();
await server.close();
cleanup(root);
fs.rmSync(data, { recursive: true, force: true });
process.exit(process.exitCode || 0);
