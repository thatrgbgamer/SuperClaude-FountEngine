import { test, assert, finish } from './harness.mjs';
import { startServer } from '../server/mmo.mjs';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

const root = makeGameFolder({ config: { server: { startMap: 'game/maps/arena.json', partySize: 3, sayRadius: 15, viewRadius: 12 } } });
const server = await startServer({ root, port: 0, quiet: true, host: '127.0.0.1' });
const social = server.social;
const bots = [];
const bot = (name) => { const b = new Bot(server.port, root, { name }); bots.push(b); return b; };
const sp = (b) => social.byName(b.session.self.name);
const place = (b, x, z) => { const p = sp(b).actor.controller.position; p[0] = x; p[2] = z; };
const heard = (b, text) => b.chats.some((c) => c.text === text);

const [a, b, c, d] = ['Alice', 'Bob', 'Cora', 'Dane'].map(bot);
await Promise.all([a, b, c, d].map((x) => x.join()));
place(d, 25, 20);

test('say reaches only players within the say radius, and shows as a bubble over the speaker', async () => {
  a.say('hello there');
  await waitFor(() => heard(b, 'hello there'), 2000, 'Bob hears');
  await sleep(150);
  assert(heard(a, 'hello there'), 'the speaker sees their own line');
  assert(!heard(d, 'hello there'), 'Dane, far away, does not');
  await waitFor(() => { const x = b.actorNamed('Alice'); return x && x.publicData.bubble && x.publicData.bubble.t === 'hello there'; }, 2000, 'bubble replicated');
});

test('chat is rate limited, and oversize text never gets through', async () => {
  const before = b.chats.length;
  for (let i = 0; i < 20; i++) a.say(`spam ${i}`);
  await sleep(300);
  const got = b.chats.slice(before).filter((x) => x.text.startsWith('spam')).length;
  assert(got > 0 && got <= 6, `only the first few got through (${got})`);
  a.say('x'.repeat(5000));
  await sleep(100);
  assert(!b.chats.some((x) => x.text.length > 200));
});

test('whispers go to one player by name, and an ignored sender is silent', async () => {
  c.say('psst', 'whisper', 'Bob');
  await waitFor(() => b.chats.some((x) => x.ch === 'whisper' && x.text === 'psst'), 2000);
  assert(c.chats.some((x) => x.ch === 'whisper' && x.echo), 'the sender gets an echo');
  assert(!a.chats.some((x) => x.text === 'psst'));
  b.session.send({ t: 'social', op: 'ignore', name: 'Cora' });
  await sleep(150);
  c.say('are you there', 'whisper', 'Bob');
  await sleep(250);
  assert(!heard(b, 'are you there'), 'ignored');
  assert(sp(b).actor.data.socialIgnored.includes('cora'), 'the ignore list lives in saved character data');
  b.session.send({ t: 'social', op: 'unignore', name: 'Cora' });
  await sleep(100);
});

test('a party: invite, accept, a frame that reaches distant members, party chat, promote, kick', async () => {
  a.partyOp('invite', 'Bob');
  await waitFor(() => b.partyMsgs.some((m) => m.ev === 'invite' && m.from === 'Alice'), 2000, 'invitation');
  b.partyOp('accept');
  await waitFor(() => a.party && a.party.members.length === 2 && b.party, 2000, 'both have the frame');
  assert(sp(a).partyId && sp(a).partyId === sp(b).partyId);

  place(b, -20, -20);                                  // outside Alice's view radius: still in the frame
  b.say('regroup', 'party');
  await waitFor(() => a.chats.some((x) => x.ch === 'party' && x.text === 'regroup'), 2000, 'party chat');
  assert(a.party.members.find((m) => m.name === 'Bob').hp > 0, 'frame data for a member out of range');
  assert(!c.chats.some((x) => x.text === 'regroup'), 'outsiders do not hear it');

  c.partyOp('invite', 'Dane');                          // Cora has no party yet: this makes one
  await waitFor(() => d.partyMsgs.some((m) => m.ev === 'invite'), 2000);
  d.partyOp('accept');
  await waitFor(() => c.party && c.party.members.length === 2, 2000);
  a.partyOp('invite', 'Cora');                          // already in a party
  await waitFor(() => a.chats.some((x) => x.text.includes('already in a party')), 2000);

  b.partyOp('kick', 'Alice');                           // Bob is not the leader yet
  await sleep(150);
  assert(a.party.members.length === 2, 'only the leader can kick');
  a.partyOp('promote', 'Bob');
  await waitFor(() => a.party && a.party.leader === sp(b).id, 2000, 'promoted');
  b.partyOp('kick', 'Alice');
  await waitFor(() => a.partyMsgs.at(-1).party === null, 2000, 'Alice told she is out');
  await waitFor(() => !social.partyFor(sp(b)), 2000, 'a party of one is dissolved');
  assert(sp(a).partyId === null && sp(b).partyId === null);
});

test('a full party refuses another member, and a member who is gone leaves the party', async () => {
  c.partyOp('leave');
  await waitFor(() => !d.party, 2000, 'Cora left, so Dane is alone');
  b.partyOp('invite', 'Alice');
  await waitFor(() => a.partyMsgs.filter((m) => m.ev === 'invite').length >= 1, 2000);
  a.partyOp('accept');
  await waitFor(() => a.party && a.party.members.length === 2, 2000);
  b.partyOp('invite', 'Cora');
  await waitFor(() => c.partyMsgs.filter((m) => m.ev === 'invite').length >= 1, 2000);
  c.partyOp('accept');
  await waitFor(() => a.party && a.party.members.length === 3, 2000, 'three members');
  b.partyOp('invite', 'Dane');
  await waitFor(() => b.chats.some((x) => x.text === 'Your party is full.'), 2000);
  server.manager.options.reconnectGraceSeconds = 0;
  c.leave();
  await waitFor(() => a.party && a.party.members.length === 2, 3000, 'Cora removed from the party when gone');
});

test('XP is split among nearby party members, the remainder to the earner', () => {
  const pa = sp(a);
  place(a, 0, 0); place(b, 3, 0);
  const got = {};
  social.shareXp(pa, 101, (m, n) => { got[m.actor.name] = n; });
  assert(got.Alice === 51 && got.Bob === 50, JSON.stringify(got));
  place(b, 30, 0);
  const far = {};
  social.shareXp(pa, 100, (m, n) => { far[m.actor.name] = n; }, { radius: 20 });
  assert(far.Alice === 100 && !far.Bob, 'a distant member gets nothing');
});

test('emotes are whitelisted and replicated for a moment', async () => {
  place(a, -9, 0); place(b, -8, 1);
  a.session.send({ t: 'emote', id: 'explode' });
  a.session.emote('wave');
  await waitFor(() => { const x = b.actorNamed('Alice'); return x && x.publicData.emote && x.publicData.emote.id === 'wave'; }, 2000, 'emote seen');
  assert(!a.chats.some((x) => x.text.includes('explode')));
  assert(a.chats.some((x) => x.ch === 'emote' && x.text === 'Alice waves.'));
});

test('a muted player is silent, a filter hook can refuse text, and reports reach the hook', async () => {
  social.mute(sp(a), 60);
  a.say('muted words');
  await sleep(250);
  assert(!heard(b, 'muted words'));
  social.unmute(sp(a));
  const reports = [];
  const orig = server.gameData.callHook.bind(server.gameData);
  server.gameData.callHook = (name, ...args) => {
    if (name === 'chatFilter') return /badword/.test(args[0]) ? false : undefined;
    if (name === 'chatReport') { reports.push(args[0]); return undefined; }
    return orig(name, ...args);
  };
  a.say('this is a badword');
  await sleep(250);
  assert(!heard(b, 'this is a badword'));
  b.session.send({ t: 'social', op: 'report', name: 'Alice', reason: 'rude' });
  await waitFor(() => reports.length === 1, 2000, 'report hook');
  assert(reports[0].against === 'alice' && reports[0].by === 'Bob');
});

for (const x of bots) x.stop();
await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
