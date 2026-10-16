// Sprites as text. A sprite is a JSON document whose frames are rows of
// characters indexing into a palette, the same way a texture is a generator
// and a sound is a synth preset: diffable, reviewable, no binary assets.
//
// This file is deliberately GL-free. It parses, validates and packs sprites,
// and runs animation state, so all of it can be tested in Node. The renderer
// only ever sees the packed atlas and a frame id.

export const DIR_NAMES = {
  1: ['S'],
  4: ['S', 'E', 'N', 'W'],
  8: ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'],
};

// The facing on the other side of the vertical axis. A sprite that only draws
// one side can be flipped to cover the other, which halves the authoring work.
const MIRROR_OF = { E: 'W', W: 'E', SE: 'SW', SW: 'SE', NE: 'NW', NW: 'NE' };

const DEFAULT_PPU = 16; // sprite pixels per world unit: a 24px sprite is 1.5m tall

export function parseColor(value) {
  if (value === null || value === undefined || value === 'transparent') return [0, 0, 0, 0];
  if (Array.isArray(value)) {
    // [r,g,b] or [r,g,b,a] in 0-255.
    return [value[0] | 0, value[1] | 0, value[2] | 0, value.length > 3 ? value[3] | 0 : 255];
  }
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) throw new Error(`"${value}" is not a colour (use #rgb, #rrggbb or null for transparent)`);
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

// A frame may be an array of row strings, or one string with rows separated by
// "/" or newlines. The second is much easier to write by hand in JSON.
function frameRows(frame) {
  if (typeof frame === 'string') return frame.split(/[\/\n]/);
  if (Array.isArray(frame)) return frame;
  return null;
}

function rasterizeFrame(rows, w, h, palette, where) {
  if (!rows) throw new Error(`${where}: a frame must be an array of row strings`);
  if (rows.length !== h) throw new Error(`${where}: has ${rows.length} rows, sprite size says ${h}`);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = String(rows[y]);
    if (row.length !== w) throw new Error(`${where}: row ${y} is ${row.length} wide, sprite size says ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      const color = palette[ch];
      if (!color) throw new Error(`${where}: row ${y} col ${x} uses "${ch}", which is not in the palette`);
      const i = (y * w + x) * 4;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
    }
  }
  return rgba;
}

/**
 * Validate a sprite document and turn it into pixels. Collects every problem
 * before throwing: a sprite with 12 bad rows should say so once, not make the
 * author fix and re-run twelve times.
 */
export function parseSprite(def, library) {
  const name = def && def.name;
  if (!name || typeof name !== 'string') throw new Error('Sprite has no "name".');
  const label = `sprite "${name}"`;
  const size = def.size;
  if (!Array.isArray(size) || size.length !== 2 || !(size[0] > 0) || !(size[1] > 0)) {
    throw new Error(`${label}: "size" must be [width, height]`);
  }
  const [w, h] = size.map((n) => n | 0);
  const problems = [];

  const palette = {};
  for (const [ch, value] of Object.entries(def.palette || {})) {
    if (ch.length !== 1) { problems.push(`palette key "${ch}" must be a single character`); continue; }
    try { palette[ch] = parseColor(value); } catch (err) { problems.push(`palette "${ch}": ${err.message}`); }
  }
  if (!('.' in palette)) palette['.'] = [0, 0, 0, 0]; // "." is transparent unless redefined

  const sprite = {
    name,
    w, h,
    anchor: Array.isArray(def.anchor) ? [def.anchor[0], def.anchor[1]] : [w / 2, h - 1],
    ppu: def.ppu > 0 ? def.ppu : DEFAULT_PPU,
    anims: {},
  };

  const firstFrame = library.frames.length;
  const autoMirror = def.autoMirror !== false;

  for (const [animName, anim] of Object.entries(def.animations || {})) {
    const where = `${label} animation "${animName}"`;
    const dirs = anim.dirs || 1;
    const dirNames = DIR_NAMES[dirs];
    if (!dirNames) { problems.push(`${where}: "dirs" must be 1, 4 or 8`); continue; }

    // With one facing, "frames" may be a plain list instead of {S: [...]}.
    let source = anim.frames;
    if (Array.isArray(source)) {
      if (dirs !== 1) { problems.push(`${where}: with dirs ${dirs}, "frames" must be an object keyed by facing (${dirNames.join(', ')})`); continue; }
      source = { S: source };
    }
    if (!source || typeof source !== 'object') { problems.push(`${where}: has no "frames"`); continue; }

    const before = problems.length;
    const pixels = {};   // facing -> [rgba]  (only facings that carry their own pixels)
    const mirror = {};   // facing -> facing it flips

    for (const dir of dirNames) {
      const value = source[dir];
      if (value === undefined || (typeof value === 'string' && value.startsWith('mirror:'))) continue;
      if (!Array.isArray(value) || !value.length) { problems.push(`${where} facing ${dir}: needs a list of frames`); continue; }
      try {
        pixels[dir] = value.map((f, i) => rasterizeFrame(frameRows(f), w, h, palette, `${where} facing ${dir} frame ${i}`));
      } catch (err) { problems.push(err.message); }
    }
    for (const dir of dirNames) {
      if (pixels[dir]) continue;
      const value = source[dir];
      let from = null;
      if (typeof value === 'string' && value.startsWith('mirror:')) from = value.slice(7);
      else if (autoMirror && MIRROR_OF[dir] && pixels[MIRROR_OF[dir]]) from = MIRROR_OF[dir];
      if (from && pixels[from]) mirror[dir] = from;
      else if (problems.length === before) problems.push(`${where}: facing ${dir} has no frames and nothing to mirror`);
    }
    if (problems.length > before) continue;

    let count = null;
    for (const dir of Object.keys(pixels)) {
      if (count === null) count = pixels[dir].length;
      else if (pixels[dir].length !== count) problems.push(`${where}: facing ${dir} has ${pixels[dir].length} frames but others have ${count}`);
    }
    const events = {};
    for (const [frame, evName] of Object.entries(anim.events || {})) {
      const idx = Number(frame);
      if (!Number.isInteger(idx) || idx < 0 || idx >= count) { problems.push(`${where}: event "${evName}" is on frame ${frame}, but there are ${count} frames`); continue; }
      (events[idx] ||= []).push(...[].concat(evName));
    }
    if (problems.length > before) continue;

    const ids = {};
    for (const dir of Object.keys(pixels)) {
      ids[dir] = pixels[dir].map((rgba) => library._addFrame(name, animName, w, h, rgba));
    }
    for (const dir of Object.keys(mirror)) ids[dir] = ids[mirror[dir]];

    const fps = anim.fps > 0 ? anim.fps : 8;
    const loop = anim.loop !== false;
    sprite.anims[animName] = {
      name: animName, fps, loop, dirs, dirNames, count,
      ids,                                           // facing -> [frame id]
      flip: Object.fromEntries(dirNames.map((d) => [d, !!mirror[d]])),
      events,                                        // frame index -> [event name]
      // A one-shot returns to idle unless told to hold its last frame.
      next: anim.next !== undefined ? anim.next : (loop || anim.hold || animName === 'death' ? null : 'idle'),
      duration: count / fps,
    };
  }

  if (!problems.length && !Object.keys(sprite.anims).length) problems.push('has no animations');
  if (problems.length) {
    library.frames.length = firstFrame; // do not leave a half-parsed sprite's pixels in the atlas
    const shown = problems.slice(0, 10).join('\n  ');
    const more = problems.length > 10 ? `\n  ...and ${problems.length - 10} more` : '';
    throw new Error(`${label} is invalid:\n  ${shown}${more}`);
  }
  return sprite;
}

/**
 * Pick the facing for a heading, as seen from the camera. "S" faces the camera
 * (screen-down), "E" screen-right, "N" away. Headings are world-space XZ and
 * the camera yaw uses the engine's convention (0 looks along +X).
 */
export function selectDir(dirNames, headingX, headingZ, cameraYawDeg) {
  if (dirNames.length === 1) return dirNames[0];
  const y = (cameraYawDeg * Math.PI) / 180;
  const rx = Math.sin(y), rz = Math.cos(y);        // camera right
  const fx = Math.cos(y), fz = -Math.sin(y);       // camera forward (screen-up)
  const sx = headingX * rx + headingZ * rz;
  const sy = headingX * fx + headingZ * fz;
  const a = Math.atan2(sx, -sy);                   // 0 = toward the camera
  const n = dirNames.length;
  const idx = ((Math.round(a / (Math.PI * 2 / n)) % n) + n) % n;
  return dirNames[idx];
}

/** All parsed sprites, plus the packed atlas the renderer uploads. */
export class SpriteLibrary {
  constructor() {
    this.sprites = new Map();
    this.fonts = new Map();     // name -> { font, glyphs: Map(char -> frame id) }
    this.frames = [];           // id -> { w, h, rgba, sprite, anim }
    this.version = 0;           // bumps on any change; the renderer re-uploads when it moves
    this._atlas = null;
    this._warned = new Set();
  }

  _addFrame(sprite, anim, w, h, rgba) {
    this.frames.push({ w, h, rgba, sprite, anim });
    return this.frames.length - 1;
  }

  has(name) { return this.sprites.has(name); }
  get(name) { return this.sprites.get(name) || null; }
  names() { return [...this.sprites.keys()]; }

  register(def) {
    const sprite = parseSprite(def, this);
    this.sprites.set(sprite.name, sprite);
    this._atlas = null;
    this.version++;
    return sprite;
  }

  registerAll(defs) {
    for (const def of defs) this.register(def);
  }

  registerFont(font) {
    const glyphs = new Map();
    for (const [ch, g] of font.glyphs) {
      const rgba = new Uint8Array(g.w * font.height * 4);
      for (let y = 0; y < font.height; y++) {
        for (let x = 0; x < g.w; x++) {
          if (g.rows[y][x] === '#') rgba.set([255, 255, 255, 255], (y * g.w + x) * 4);
        }
      }
      glyphs.set(ch, this._addFrame(`font:${font.name}`, ch, g.w, font.height, rgba));
    }
    this.fonts.set(font.name, { font, glyphs });
    this._atlas = null;
    this.version++;
  }

  /** Warn once per key: a typo'd animation name must be loud, but not 120 times a second. */
  warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`[fount] ${message}`);
  }

  /**
   * Shelf-pack every frame into one RGBA image. One texture for every sprite
   * means the whole sprite layer is a single draw call with no rebinds.
   */
  atlas() {
    if (this._atlas) return this._atlas;
    const pad = 1;
    const order = this.frames.map((_, id) => id).sort((a, b) => this.frames[b].h - this.frames[a].h);
    let width = 256;
    const area = this.frames.reduce((s, f) => s + (f.w + pad) * (f.h + pad), 0);
    while (width * width < area * 1.4 && width < 2048) width *= 2;

    const rects = new Array(this.frames.length);
    let x = 0, y = 0, rowH = 0;
    for (const id of order) {
      const f = this.frames[id];
      if (x + f.w + pad > width) { x = 0; y += rowH + pad; rowH = 0; }
      rects[id] = { x, y, w: f.w, h: f.h };
      x += f.w + pad;
      rowH = Math.max(rowH, f.h);
    }
    let height = 1;
    while (height < y + rowH + pad) height *= 2;
    if (height > 4096) throw new Error(`The sprite atlas would be ${width}x${height}: too many sprite pixels for one texture.`);

    const data = new Uint8Array(width * height * 4);
    for (const id of order) {
      const f = this.frames[id], r = rects[id];
      for (let row = 0; row < f.h; row++) {
        data.set(f.rgba.subarray(row * f.w * 4, (row + 1) * f.w * 4), ((r.y + row) * width + r.x) * 4);
      }
    }
    const uv = rects.map((r) => r && [r.x / width, r.y / height, (r.x + r.w) / width, (r.y + r.h) / height]);
    this._atlas = { width, height, data, rects, uv };
    return this._atlas;
  }
}

/** Animation state for one thing on screen. The renderer is passed in, never imported. */
export class SpriteInstance {
  constructor(library, name, options = {}) {
    this.library = library;
    this.name = name;
    this.sprite = library.get(name);
    if (!this.sprite) {
      throw new Error(`No sprite named "${name}" (registered: ${library.names().join(', ') || 'none'})`);
    }
    this.scale = options.scale ?? 1;
    this.tint = options.tint ? [...options.tint] : [1, 1, 1];
    this.alpha = 1;
    this.heading = [0, 1];       // world XZ
    this.speed = 1;
    this.anim = null;
    this.time = 0;
    this.frame = 0;
    this._step = -1;
    this.finished = false;
    this.onEvent = null;         // (eventName, instance): e.g. the "hit" frame of an attack
    this.onFinish = null;        // (animName, instance): fires when a one-shot ends
    this._onceFinish = null;
    this._flash = 0;
    this._flashTotal = 0;
    this.play(options.anim || (this.sprite.anims.idle ? 'idle' : Object.keys(this.sprite.anims)[0]));
  }

  has(anim) { return !!this.sprite.anims[anim]; }
  get animName() { return this.anim ? this.anim.name : null; }

  /**
   * Start an animation. Asking for the one already playing does nothing, so a
   * behaviour can call play("walk") every step without restarting it.
   */
  play(name, options = {}) {
    const anim = this.sprite.anims[name];
    if (!anim) {
      this.library.warnOnce(`${this.name}/${name}`,
        `sprite "${this.name}" has no animation "${name}" (it has: ${Object.keys(this.sprite.anims).join(', ')})`);
      return false;
    }
    if (this.anim === anim && !options.restart && !this.finished) return true;
    this.anim = anim;
    this.time = 0;
    this.frame = 0;
    this._step = -1;
    this.finished = false;
    this.speed = options.speed ?? 1;
    this._onceFinish = options.onFinish || null;
    return true;
  }

  flash(duration = 0.12) {
    this._flash = this._flashTotal = duration;
  }

  get flashAmount() {
    return this._flashTotal > 0 ? Math.max(0, this._flash / this._flashTotal) : 0;
  }

  setHeading(x, z) {
    if (x * x + z * z > 1e-8) { this.heading[0] = x; this.heading[1] = z; }
  }

  update(dt) {
    if (this._flash > 0) this._flash = Math.max(0, this._flash - dt);
    const anim = this.anim;
    if (!anim || this.finished) return;

    this.time += dt * this.speed * anim.fps;
    const target = Math.floor(this.time);

    // Fire events for every frame passed, not just the one landed on: a long
    // step must not skip an attack's hit frame.
    let step = this._step;
    let ended = false;
    const limit = step + anim.count * 2 + 1;
    while (step < target && step < limit) {
      step++;
      if (!anim.loop && step >= anim.count) { ended = true; break; }
      // Handlers read instance.frame, so it has to be current when they run.
      this.frame = step % anim.count;
      const names = anim.events[step % anim.count];
      if (names && this.onEvent) for (const n of names) this.onEvent(n, this);
    }
    if (ended) {
      this._step = anim.count - 1;
      this.frame = anim.count - 1;
    } else {
      this._step = step;
      this.frame = anim.loop ? step % anim.count : Math.min(step, anim.count - 1);
      if (anim.loop && this.time > anim.count * 64) { this.time -= anim.count * 64; this._step -= anim.count * 64; }
    }

    if (ended) {
      this.finished = true;
      const done = anim.name;
      const once = this._onceFinish;
      this._onceFinish = null;
      if (once) once(done, this);
      if (this.onFinish) this.onFinish(done, this);
      if (anim.next && this.anim === anim && this.sprite.anims[anim.next]) this.play(anim.next);
    }
  }

  /** Which frame to draw, as seen from a camera with this yaw (degrees). */
  currentFrame(cameraYawDeg) {
    const anim = this.anim;
    const dir = selectDir(anim.dirNames, this.heading[0], this.heading[1], cameraYawDeg);
    const ids = anim.ids[dir];
    return { id: ids[Math.min(this.frame, ids.length - 1)], flip: anim.flip[dir], dir };
  }

  get worldHeight() { return (this.sprite.h / this.sprite.ppu) * this.scale; }
  get worldWidth() { return (this.sprite.w / this.sprite.ppu) * this.scale; }

  draw(renderer, position, cameraYawDeg, options = {}) {
    const f = this.currentFrame(cameraYawDeg);
    renderer.drawSpriteFrame(f.id, position, {
      sprite: this.sprite,
      scale: this.scale * (options.scale ?? 1),
      flip: f.flip,
      tint: options.tint || this.tint,
      alpha: options.alpha ?? this.alpha,
      flash: Math.max(this.flashAmount, options.flash || 0),
      tilt: options.tilt,
    });
  }
}
