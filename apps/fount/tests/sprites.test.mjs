import { test, assert, near, throws, finish } from './harness.mjs';
import { SpriteLibrary, SpriteInstance, selectDir, parseColor } from '../engine/sprites.js';
import { BUILTIN_SPRITES } from '../engine/builtin_sprites.js';
import { defaultFont } from '../engine/font.js';

const imp = () => ({
  name: 'imp',
  size: [4, 4],
  anchor: [2, 3],
  palette: { '.': null, k: '#101010', o: '#f07020' },
  animations: {
    idle: { fps: 4, dirs: 4, frames: {
      S: [['.kk.', 'kook', 'kook', '.kk.'], ['.kk.', 'kook', 'kook', '.kk.']],
      E: [['.kk.', '.kok', '.kok', '.kk.'], ['.kk.', '.kok', 'kokk', '.kk.']],
      N: [['.kk.', 'kkkk', 'kkkk', '.kk.'], ['.kk.', 'kkkk', 'kkkk', '.kk.']],
    } },
    attack: { fps: 10, loop: false, dirs: 1, events: { 1: 'hit' }, frames: [['kkkk', 'k..k', 'k..k', 'kkkk'], ['kkkk', 'kook', 'kook', 'kkkk'], ['....', '.kk.', '.kk.', '....']] },
    death: { fps: 5, loop: false, frames: [['....', '....', '....', 'kkkk'], ['....', '....', '....', 'oooo']] },
  },
});

test('parses a sprite and packs every frame into one atlas', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const atlas = lib.atlas();
  assert(atlas.width >= 256 && (atlas.width & (atlas.width - 1)) === 0, 'atlas width should be a power of two');
  // 3 facings x 2 frames + 3 attack + 2 death; W is mirrored, not stored again.
  assert(lib.frames.length === 11, `expected 11 stored frames, got ${lib.frames.length}`);
  return `${lib.frames.length} frames in ${atlas.width}x${atlas.height}`;
});

test('a missing facing is mirrored from the opposite side', () => {
  const lib = new SpriteLibrary();
  const sprite = lib.register(imp());
  const idle = sprite.anims.idle;
  assert(idle.flip.W === true && idle.flip.E === false, 'W should flip E');
  assert(idle.ids.W === idle.ids.E, 'mirrored facing shares the source frames');
});

test('pixels land where the rows say, with transparency', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const f = lib.frames[0]; // idle S frame 0, row 0 is ".kk."
  assert(f.rgba[3] === 0, 'col 0 of ".kk." is transparent');
  assert(f.rgba[4 + 3] === 255 && f.rgba[4] === 0x10, 'col 1 is the dark ink');
});

test('bad sprites fail loudly, all problems at once, and leave no frames behind', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const before = lib.frames.length;
  const bad = imp();
  bad.name = 'bad';
  bad.animations.idle.frames.S[0][1] = 'koo';        // short row
  bad.animations.idle.frames.E[0][2] = 'kzok';       // unknown palette char
  bad.animations.attack.events = { 9: 'hit' };       // event past the end
  try { lib.register(bad); assert(false, 'should have thrown'); } catch (err) {
    assert(/is 3 wide/.test(err.message), 'reports the short row');
    assert(/"z".*not in the palette/.test(err.message), 'reports the bad palette char');
    assert(/event "hit" is on frame 9/.test(err.message), 'reports the bad event');
  }
  assert(lib.frames.length === before, 'a failed sprite must not leak frames into the atlas');
  assert(!lib.has('bad'));
});

test('facing follows the heading as seen from the camera', () => {
  const four = ['S', 'E', 'N', 'W'];
  // Camera yaw 90 looks along -Z: screen-up is -Z, screen-right is +X.
  assert(selectDir(four, 0, 1, 90) === 'S', 'heading +Z walks toward the camera');
  assert(selectDir(four, 0, -1, 90) === 'N', 'heading -Z walks away');
  assert(selectDir(four, 1, 0, 90) === 'E', 'heading +X is screen-right');
  assert(selectDir(four, -1, 0, 90) === 'W', 'heading -X is screen-left');
  // Rotating the camera must rotate every facing with it.
  assert(selectDir(four, 1, 0, 0) === 'N', 'camera yaw 0 looks along +X, so +X is away');
  const eight = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];
  assert(selectDir(eight, 1, 1, 90) === 'SE', 'toward camera and screen-right');
  assert(selectDir(eight, -1, -1, 90) === 'NW', 'away and screen-left');
});

test('a one-shot fires its event on the right frame, then returns to idle', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const s = new SpriteInstance(lib, 'imp');
  const log = [];
  s.onEvent = (n) => log.push(`event:${n}@${s.frame}`);
  s.onFinish = (n) => log.push(`finish:${n}`);
  s.play('attack');
  for (let i = 0; i < 40; i++) s.update(1 / 120);
  assert(log.join(',') === 'event:hit@1,finish:attack', `got ${log.join(',')}`);
  assert(s.animName === 'idle', 'returns to idle');
});

test('a long step does not skip an event frame', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const s = new SpriteInstance(lib, 'imp');
  let hits = 0;
  s.onEvent = () => hits++;
  s.play('attack');
  s.update(0.25); // 2.5 frames at once
  assert(hits === 1, `event should fire once, fired ${hits}`);
});

test('death holds its last frame instead of returning to idle', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const s = new SpriteInstance(lib, 'imp');
  s.play('death');
  for (let i = 0; i < 200; i++) s.update(1 / 60);
  assert(s.animName === 'death' && s.finished && s.frame === 1);
});

test('asking for the playing animation does not restart it; missing ones warn once', () => {
  const lib = new SpriteLibrary();
  lib.register(imp());
  const s = new SpriteInstance(lib, 'imp');
  s.update(0.3);
  const t = s.time;
  s.play('idle');
  assert(s.time === t, 'play(idle) while idle must be a no-op');
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  s.play('dance'); s.play('dance'); s.play('dance');
  console.warn = orig;
  assert(warnings.length === 1 && /no animation "dance"/.test(warnings[0]), `warned ${warnings.length} times`);
});

test('the built-in fx sprites all parse', () => {
  const lib = new SpriteLibrary();
  lib.registerAll(BUILTIN_SPRITES);
  for (const n of ['fx_px', 'fx_spark', 'fx_glow', 'fx_smoke', 'fx_fire', 'fx_orb', 'fx_heal', 'fx_exclaim']) assert(lib.has(n), n);
  return `${lib.frames.length} frames`;
});

test('colours parse in the forms authors write', () => {
  assert(parseColor('#f80').join() === '255,136,0,255');
  assert(parseColor('#112233').join() === '17,34,51,255');
  assert(parseColor('#11223380')[3] === 128);
  assert(parseColor(null)[3] === 0);
  throws(() => parseColor('red'), /not a colour/);
});

test('every glyph in the built-in font is 5 wide and 7 tall', () => {
  const font = defaultFont();
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ !?.,') assert(font.glyphs.has(ch), `missing ${ch}`);
  for (const [ch, g] of font.glyphs) assert(g.w === 5 && g.rows.length === 7, `glyph ${ch}`);
});

test('font layout, lower-case fallback and rasterising', () => {
  const font = defaultFont();
  assert(font.glyph('a') === font.glyph('A'), 'lower-case draws as capitals');
  near(font.measure('12').width, 11, 0, 'two glyphs plus a gap');
  const out = font.rasterize('7', { scale: 2 });
  assert(out.width === 10 && out.height === 14);
  // "7" top row is "#####": the whole first scaled row should be ink.
  for (let x = 0; x < 10; x++) assert(out.data[x * 4 + 3] === 255, `top row pixel ${x}`);
  const outlined = font.rasterize('7', { outline: [0, 0, 0] });
  assert(outlined.width === 7 && outlined.height === 9, 'outline adds a pixel border');
});

test('a font registers its glyphs into the atlas', () => {
  const lib = new SpriteLibrary();
  lib.registerFont(defaultFont());
  const entry = lib.fonts.get('fount5x7');
  assert(entry.glyphs.size === defaultFont().glyphs.size);
  assert(lib.atlas().rects[entry.glyphs.get('A')].w === 5);
});

finish();
