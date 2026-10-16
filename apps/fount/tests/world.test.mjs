import { test, assert, finish } from './harness.mjs';
import { WorldClock } from '../engine/worldclock.js';
import { noteFrequency, validateSong, Sequencer, MusicPlayer } from '../engine/music.js';
import { SpriteLibrary, SpriteInstance } from '../engine/sprites.js';
import { PaperDoll, syncAppearance } from '../engine/paperdoll.js';
import { Decals } from '../engine/decals.js';
import { Flow } from '../engine/flow.js';
import { Emitter } from '../engine/events.js';
import { startServer } from '../server/mmo.mjs';
import { makeGameFolder, cleanup, Bot, sleep, waitFor } from './mmo-helpers.mjs';

// ---- the clock ---------------------------------------------------------------------

test('the world clock derives hour, daylight, season and tide from one number', () => {
  const c = new WorldClock({ dayLength: 240, startHour: 12, seasons: ['spring', 'summer', 'autumn', 'winter'], seasonLength: 2, tidePeriod: 100 });
  const noon = c.sample(0);
  assert(noon.hour === 12 && noon.daylight === 1 && !noon.isNight, 'starts at noon');
  const midnight = c.sample(120);
  assert(Math.abs(midnight.hour - 0) < 1e-9 || Math.abs(midnight.hour - 24) < 1e-9);
  assert(midnight.daylight === 0 && midnight.isNight);
  assert(c.sample(0).season === 'spring' && c.sample(240 * 2).season === 'summer' && c.sample(240 * 6).season === 'winter');
  assert(c.sample(240 * 8).season === 'spring' && c.sample(240 * 8).year === 1, 'the year wraps');
  assert(c.sample(0).tide === 1 && Math.abs(c.sample(50).tide + 1) < 1e-9, 'tide peaks and troughs');
  assert(c.sample(777).hour === c.sample(777).hour, 'pure');
});

test('the clock raises events as the hour, day and season tick over', () => {
  const c = new WorldClock({ dayLength: 240, startHour: 0, seasonLength: 1 });
  let t = 0;
  c.source = () => t;
  const seen = [];
  const emit = (n) => seen.push(n);
  c.update(emit);
  t = 11; c.update(emit);                            // one hour is 10 s
  t = 241; c.update(emit);                           // next day, next season
  assert(seen.includes('hour-changed') && seen.includes('day-changed') && seen.includes('season-changed'), seen.join());
  const dark = c.lighting({}, c.sample(0)), bright = c.lighting({}, c.sample(120));
  assert(dark.ambient[0] < bright.ambient[0], 'lighting follows the hour');
});

// ---- music -------------------------------------------------------------------------

test('note names become frequencies', () => {
  assert(Math.abs(noteFrequency('A4') - 440) < 1e-9 && Math.abs(noteFrequency('C4') - 261.6256) < 1e-3);
  assert(Math.abs(noteFrequency('Bb3') - noteFrequency('A#3')) < 1e-9);
  assert(noteFrequency('H9') === null && noteFrequency('-') === null);
});

test('a bad song is reported with every problem at once', () => {
  const p = validateSong({ bpm: 0, channels: [{ pattern: ['C4', 'X9', '.'] }, { patterns: { a: ['C4'] }, order: ['a', 'b'] }] });
  assert(p.length >= 3 && p.some((x) => /bpm/.test(x)) && p.some((x) => /X9/.test(x)) && p.some((x) => /"b"/.test(x)), p.join(' | '));
});

test('the sequencer hands out notes in time, holds them through "-", rests on ".", and loops', () => {
  const song = { bpm: 120, stepsPerBeat: 2, channels: [{ wave: 'square', pattern: ['C4', '-', '.', 'E4'] }, { patterns: { a: ['G3', 'G3'] }, order: ['a'] }] };
  const s = new Sequencer(song);
  assert(Math.abs(s.stepSeconds - 0.25) < 1e-9);
  s.start(10);
  const first = s.collect(11.01);                    // the first bar
  const ch0 = first.filter((n) => n.channel === 0);
  assert(ch0.length === 3 && Math.abs(ch0[0].duration - 0.5) < 1e-9, 'C4 holds two steps');
  assert(Math.abs(ch0[1].at - 10.75) < 1e-9 && Math.abs(ch0[1].freq - noteFrequency('E4')) < 1e-9, 'E4 starts on step 3');
  assert(first.filter((n) => n.channel === 1).length === 5, 'the short channel loops independently');
  assert(s.collect(11.01).length === 0, 'nothing is handed out twice');
  const once = new Sequencer({ ...song, loop: false });
  once.start(0);
  once.collect(100);
  assert(once.done, 'a song that does not loop ends');
});

test('the music player schedules ahead, switches songs and fades', () => {
  let now = 0;
  const played = [];
  const timers = [];
  const mp = new MusicPlayer({
    songs: { a: { bpm: 60, stepsPerBeat: 1, channels: [{ pattern: ['C4', '.', 'E4', '.'] }] }, b: { bpm: 60, stepsPerBeat: 1, channels: [{ pattern: ['G4', '-'] }] } },
    tone: (n) => played.push(n), now: () => now, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
  });
  assert(mp.play('a') && mp.playing === 'a' && !mp.play('missing'));
  assert(played.length >= 1, 'the first notes are queued at once');
  now = 2.5; timers[0]();
  assert(played.length >= 2, 'later notes follow the clock');
  mp.play('b', { fade: 4 });
  assert(mp.playing === 'b');
  const before = played.length;
  now = 4.5; timers[0]();
  const fresh = played.slice(before);
  assert(fresh.length > 0 && fresh.every((n) => n.volume < 0.25), 'the new song fades in');
  mp.stop();
  assert(mp.playing === null);
});

// ---- palette swaps and paper dolls -------------------------------------------------

const sprite = (name, palette) => ({
  name, size: [2, 2], palette: { '.': null, r: '#aa0000', k: '#101010', ...palette },
  animations: { idle: { frames: [['rk', 'kr']] }, walk: { frames: [['rr', 'kk'], ['kk', 'rr']] } },
});

test('a palette swap makes a cached recoloured variant, by character or by colour', () => {
  const lib = new SpriteLibrary();
  lib.register(sprite('hero'));
  const blue = lib.variant('hero', { r: '#0000cc' });
  assert(blue !== 'hero' && lib.has(blue) && lib.variant('hero', { r: '#0000cc' }) === blue, 'made once and cached');
  const byColour = lib.variant('hero', { '#aa0000': '#0000cc' });
  const a = lib.frames[lib.get(blue).anims.idle.ids[lib.get(blue).anims.idle.dirNames[0]][0]].rgba;
  const b = lib.frames[lib.get(byColour).anims.idle.ids[lib.get(byColour).anims.idle.dirNames[0]][0]].rgba;
  assert(JSON.stringify([...a]) === JSON.stringify([...b]) && a[2] === 0xcc && a[0] === 0, 'the same pixels either way');
  const inst = new SpriteInstance(lib, 'hero');
  inst.play('walk');
  inst.setPalette({ r: '#0000cc' });
  assert(inst.name === blue && inst.animName === 'walk', 'recolouring keeps the animation');
  inst.setPalette(null);
  assert(inst.name === 'hero');
});

test('a paper doll stacks layers that follow the body, and rebuilds only when the list changes', () => {
  const lib = new SpriteLibrary();
  lib.register(sprite('body'));
  lib.register(sprite('hair', { k: '#552200' }));
  lib.register(sprite('cloak'));
  const body = new SpriteInstance(lib, 'body');
  const doll = new PaperDoll(lib, body);
  assert(doll.set([{ sprite: 'hair', palette: { r: '#ffcc00' } }, { sprite: 'cloak', order: 'under' }, { sprite: 'missing' }]));
  assert(!doll.set([{ sprite: 'hair', palette: { r: '#ffcc00' } }, { sprite: 'cloak', order: 'under' }, { sprite: 'missing' }]), 'same list, no rebuild');
  assert(doll.layers.length === 2, 'a missing sprite is skipped, not fatal');
  body.play('walk'); body.update(0.4);
  const calls = [];
  const renderer = { camPos: [0, 10, 0], drawSpriteFrame: (id, pos, o) => calls.push({ id, pos, sprite: o.sprite.name }) };
  doll.drawUnder(renderer, [0, 0, 0], 0, {});
  doll.drawOver(renderer, [0, 0, 0], 0, {});
  assert(calls.length === 2 && calls[0].sprite.startsWith('cloak') && calls[1].sprite.startsWith('hair'), 'under first, over after');
  assert(doll.layers.every((l) => l.instance.animName === 'walk' && l.instance.frame === body.frame), 'layers follow the body frame');
  assert(calls[1].pos[1] > 0, 'the front layer is nudged toward the camera');

  const actor = { sprite: body, publicData: { palette: { r: '#00aa00' }, layers: [{ sprite: 'hair' }] } };
  syncAppearance(actor, lib);
  assert(body.name !== 'body' && actor.paperdoll && actor.paperdoll.layers.length === 1, 'public data drives the look');
  actor.publicData = {};
  syncAppearance(actor, lib);
  assert(body.name === 'body' && !actor.paperdoll, 'and clearing it restores the look');
});

// ---- decals ------------------------------------------------------------------------

test('decals lie flat, fade out, expire and are capped', () => {
  const lib = new SpriteLibrary();
  lib.register(sprite('splat'));
  const d = new Decals(lib, { max: 3 });
  assert(d.add('nope', [0, 0, 0]) === null);
  for (let i = 0; i < 5; i++) d.add('splat', [i, 1, 0], { size: 1, life: 10, fade: 4 });
  assert(d.items.length === 3 && d.items[0].pos[0] === 2, 'the oldest are replaced');
  const calls = [];
  const r = { drawSpriteFrame: (id, pos, o) => calls.push({ pos, o }) };
  d.draw(r);
  assert(calls.length === 3 && calls.every((c) => c.o.tilt === -1 && c.pos[1] > 1), 'flat, and just above the surface');
  d.update(8);
  calls.length = 0; d.draw(r);
  assert(calls[0].o.tint[0] < 1 && calls[0].o.scale < 1 / (2 / 16) * 1, 'fading shrinks and darkens');
  d.update(5);
  assert(d.items.length === 0, 'expired');
});

// ---- the flow ----------------------------------------------------------------------

test('the flow allows the stock path, refuses nonsense and reports failures', async () => {
  const events = new Emitter();
  let playing = null;
  const game = { events, online: { ok: true }, goOffline() { playing = null; }, async playOnline(url, o) { if (url === 'bad') throw new Error('Wrong password.'); playing = o; } };
  const account = { socketUrl: () => 'ws://x', hello: (id) => ({ token: 't', character: String(id) }) };
  const flow = new Flow(game);
  const seen = [];
  flow.on('change', (c) => seen.push(`${c.from}>${c.to}`));
  assert(flow.state === 'boot' && !flow.go('playing'), 'cannot play before the title');
  flow.start();
  assert(flow.state === 'title');
  assert(flow.go('login') && flow.go('characters') && flow.can('loading') && !flow.can('playing'));
  await flow.enter(account, 7);
  assert(flow.state === 'playing' && playing.hello.character === '7');
  events.emit('online-ended', { reason: 'kicked' });
  assert(flow.state === 'disconnected' && flow.data.reason === 'kicked');
  assert(flow.go('characters') && flow.go('loading'));
  game.playOnline = async () => { throw new Error('The server is full.'); };
  let failed = null;
  try { flow.state = 'characters'; await flow.enter(account, 1); } catch (e) { failed = e; }
  assert(failed && flow.state === 'disconnected' && /full/.test(flow.data.reason));
  flow.leave();
  assert(flow.state === 'title' && seen.length > 5);
  flow.allow('characters', 'create');
  flow.state = 'characters';
  assert(flow.go('create'), 'a game can add its own screen');
});

// ---- tides, on a real server --------------------------------------------------------

const root = makeGameFolder({
  arenaEntities: [{ classname: 'func_water', name: 'bay', min: [-14, -2, -4], max: [-6, 1.0, 4], tide: { amplitude: 0.5, period: 6 }, slow: 0.5 }],
});
const server = await startServer({ root, port: 0, quiet: true, host: '127.0.0.1' });

test('water follows the tide on the server, replicates its level, and slows what wades in it', async () => {
  const a = new Bot(server.port, root, { name: 'Wade' });
  await a.join();
  const inst = server.manager.instances.values().next().value;
  const water = inst.world.entities.find((e) => e.classname === 'func_water');
  const player = inst.players[0];
  const base = player.actor.speed;
  player.actor.controller.position[0] = -10; player.actor.controller.position[2] = 0;
  await waitFor(() => player.actor.speed < base, 2000, 'slowed in the water');
  assert(Math.abs(player.actor.speed - base * 0.5) < 1e-9, `half speed (${player.actor.speed})`);
  const levels = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) { levels.add(water.state.level); await sleep(60); }
  assert(levels.size > 5 && Math.min(...levels) >= 0.49 && Math.max(...levels) <= 1.51, `the surface rises and falls (${levels.size} levels)`);
  await waitFor(() => { const e = a.entityStates.get(water.id); return e && e.state && e.state.level !== undefined; }, 2000, 'level replicated');
  player.actor.controller.position[0] = 0;
  await waitFor(() => Math.abs(player.actor.speed - base) < 1e-9, 2000, 'speed restored on leaving');
  a.stop();
});

await finish();
await server.close();
cleanup(root);
process.exit(process.exitCode || 0);
