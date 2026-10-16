// Sprite particles and floating text. Particles are tiny sprites (the built-in
// fx_* ones, or any sprite a game defines) stepped at the engine's fixed rate
// and drawn through the same batched sprite path as characters, so a thousand
// sparks cost one draw call. Presets are plain data; a game adds its own with
// particles.define(name, def).
//
//   {
//     sprite: 'fx_spark', anim: 'idle', frames: 'life' | 'loop' | 'random',
//     count: 8, life: [0.25, 0.5], speed: [2, 5], up: [1, 3],
//     gravity: 12, drag: 0, radius: 0.1,
//     size: [1, 0.4], tint: [[1, 0.9, 0.4], [1, 0.3, 0.1]], alpha: [1, 0],
//   }

import { clamp } from './math.js';

const range = (r, rng) => (Array.isArray(r) ? r[0] + (r[1] - r[0]) * rng() : r);
const lerp = (a, b, t) => a + (b - a) * t;

export const PARTICLE_PRESETS = {
  spark: { sprite: 'fx_spark', count: 8, life: [0.25, 0.55], speed: [2, 5], up: [1, 3], gravity: 14, size: [1, 0.5], tint: [[1, 0.95, 0.6], [1, 0.4, 0.1]], alpha: [1, 0] },
  hit: { sprite: 'fx_spark', count: 5, life: [0.15, 0.3], speed: [2, 4], up: [0.5, 2], gravity: 6, size: [1.2, 0.5], tint: [[1, 1, 1], [1, 0.6, 0.4]], alpha: [1, 0] },
  smoke: { sprite: 'fx_smoke', frames: 'life', count: 3, life: [0.6, 1.0], speed: [0.2, 0.7], up: [0.8, 1.5], gravity: -1, size: [0.6, 1.5], tint: [[0.75, 0.75, 0.78], [0.45, 0.45, 0.5]], alpha: [0.9, 0] },
  fire: { sprite: 'fx_fire', frames: 'loop', count: 2, life: [0.3, 0.6], speed: [0.1, 0.5], up: [0.6, 1.4], gravity: -3, size: [1, 0.4], tint: [[1, 1, 1], [1, 0.7, 0.5]], alpha: [1, 0] },
  ember: { sprite: 'fx_px', count: 6, life: [0.8, 1.6], speed: [0.4, 1.4], up: [1, 2.5], gravity: 2, size: [1.6, 0.6], tint: [[1, 0.7, 0.2], [0.8, 0.2, 0.1]], alpha: [1, 0] },
  heal: { sprite: 'fx_heal', frames: 'life', count: 5, life: [0.7, 1.1], speed: [0.2, 0.7], up: [0.8, 1.6], gravity: -0.5, radius: 0.35, size: [1, 0.8], tint: [[0.5, 1, 0.6], [0.7, 1, 0.8]], alpha: [1, 0] },
  magic: { sprite: 'fx_glow', frames: 'life', count: 8, life: [0.4, 0.8], speed: [0.6, 2], up: [0.2, 1.2], gravity: -0.5, size: [1, 0.4], tint: [[0.75, 0.65, 1], [0.35, 0.3, 1]], alpha: [1, 0] },
  explosion: { sprite: 'fx_glow', frames: 'life', count: 18, life: [0.3, 0.75], speed: [3, 7], up: [0.5, 3], gravity: 5, radius: 0.2, size: [2.2, 0.6], tint: [[1, 0.92, 0.55], [0.9, 0.25, 0.1]], alpha: [1, 0] },
  dust: { sprite: 'fx_smoke', frames: 'life', count: 4, life: [0.4, 0.7], speed: [0.4, 1.2], up: [0.2, 0.7], gravity: 1, size: [0.5, 1.1], tint: [[0.75, 0.65, 0.5], [0.6, 0.5, 0.4]], alpha: [0.8, 0] },
  portal: { sprite: 'fx_glow', frames: 'life', count: 4, life: [0.6, 1.2], speed: [0.1, 0.5], up: [0.8, 2.2], gravity: -1, radius: 0.6, size: [0.8, 0.3], tint: [[0.5, 0.85, 1], [0.7, 0.5, 1]], alpha: [1, 0] },
  notice: { sprite: 'fx_exclaim', count: 1, life: [0.9, 0.9], speed: 0, up: [1.4, 1.4], drag: 2.5, gravity: 0, size: [1, 1], tint: [[1, 1, 1], [1, 1, 1]], alpha: [1, 0.2] },
};

export class ParticleSystem {
  constructor(max = 2500, rng = Math.random) {
    this.max = max;
    this.rng = rng;
    this.presets = new Map(Object.entries(PARTICLE_PRESETS));
    this.live = [];
    this.pool = [];
    this.emitters = [];
    this.sprites = null;         // set by the game: the renderer's SpriteLibrary
  }

  define(name, def) { this.presets.set(name, def); }
  defineAll(table) { for (const [n, d] of Object.entries(table || {})) this.define(n, d); }
  has(name) { return this.presets.has(name); }
  get count() { return this.live.length; }

  clear() {
    this.pool.push(...this.live);
    this.live.length = 0;
    this.emitters.length = 0;
  }

  /** The parts of a preset the update loop needs, looked up once and cached on it. */
  resolve(def) {
    if (!this.sprites) return null;
    if (def._lib === this.sprites && def._version === this.sprites.version) return def._ids;
    const sprite = this.sprites.get(def.sprite || 'fx_px');
    if (!sprite) { this.sprites.warnOnce(`particle:${def.sprite}`, `particle preset uses unknown sprite "${def.sprite}"`); return null; }
    const anim = sprite.anims[def.anim || 'idle'] || Object.values(sprite.anims)[0];
    def._lib = this.sprites;
    def._version = this.sprites.version;
    def._ids = { sprite, anim, ids: anim.ids[anim.dirNames[0]] };
    return def._ids;
  }

  /**
   * Throw a burst of particles from a point. `name` is a preset or an inline
   * definition; options: { count, scale, tint: [r,g,b], dir: [x,y,z] bias }.
   */
  burst(name, pos, options = {}) {
    const def = typeof name === 'string' ? this.presets.get(name) : name;
    if (!def) {
      if (typeof name === 'string' && this.sprites) this.sprites.warnOnce(`preset:${name}`, `no particle preset "${name}"`);
      return;
    }
    const n = options.count ?? def.count ?? 1;
    for (let i = 0; i < n && this.live.length < this.max; i++) this.spawn(def, pos, options);
  }

  spawn(def, pos, options) {
    const rng = this.rng;
    const p = this.pool.pop() || { pos: [0, 0, 0], vel: [0, 0, 0] };
    const ang = rng() * Math.PI * 2;
    const rad = (def.radius || 0) * Math.sqrt(rng());
    const speed = range(def.speed ?? 1, rng);
    p.pos[0] = pos[0] + Math.cos(ang) * rad;
    p.pos[1] = pos[1];
    p.pos[2] = pos[2] + Math.sin(ang) * rad;
    const dirAng = rng() * Math.PI * 2;
    p.vel[0] = Math.cos(dirAng) * speed + (options.dir ? options.dir[0] : 0);
    p.vel[1] = range(def.up ?? 0, rng) + (options.dir ? options.dir[1] : 0);
    p.vel[2] = Math.sin(dirAng) * speed + (options.dir ? options.dir[2] : 0);
    p.age = 0;
    p.life = Math.max(0.05, range(def.life ?? 0.6, rng));
    p.def = def;
    p.scale = options.scale ?? 1;
    p.tint = options.tint || null;
    p.seed = rng();
    this.live.push(p);
  }

  /** A continuous source: rate particles per second, until stopped or `duration` runs out. */
  emitter(name, pos, options = {}) {
    const e = { name, pos, rate: options.rate ?? 8, duration: options.duration ?? Infinity, age: 0, acc: 0, options, alive: true, stop() { this.alive = false; } };
    this.emitters.push(e);
    return e;
  }

  update(dt) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.age += dt;
      if (!e.alive || e.age > e.duration) { this.emitters.splice(i, 1); continue; }
      e.acc += e.rate * dt;
      const at = typeof e.pos === 'function' ? e.pos() : e.pos;
      if (!at) continue;
      while (e.acc >= 1) { e.acc -= 1; this.burst(e.name, at, { ...e.options, count: 1 }); }
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.pool.push(p);
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        continue;
      }
      const d = p.def;
      if (d.gravity) p.vel[1] -= d.gravity * dt;
      if (d.drag) { const k = Math.max(0, 1 - d.drag * dt); p.vel[0] *= k; p.vel[1] *= k; p.vel[2] *= k; }
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
    }
  }

  draw(renderer) {
    for (const p of this.live) {
      const r = this.resolve(p.def);
      if (!r) continue;
      const t = p.age / p.life;
      const d = p.def;
      let frame = 0;
      if (d.frames === 'life') frame = Math.min(r.ids.length - 1, Math.floor(t * r.ids.length));
      else if (d.frames === 'loop') frame = Math.floor(p.age * r.anim.fps + p.seed * r.ids.length) % r.ids.length;
      else if (d.frames === 'random') frame = Math.floor(p.seed * r.ids.length);
      const size = lerp(d.size ? d.size[0] : 1, d.size ? d.size[1] : 1, t) * p.scale;
      const [c0, c1] = d.tint || [[1, 1, 1], [1, 1, 1]];
      const tint = p.tint || [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
      const alpha = d.alpha ? lerp(d.alpha[0], d.alpha[1], t) : 1;
      renderer.drawSpriteFrame(r.ids[frame], p.pos, { sprite: r.sprite, scale: size, tint, alpha, tilt: 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// Floating text: damage numbers, "LEVEL UP", pickups.
// ---------------------------------------------------------------------------

export class FloatingTexts {
  constructor() { this.items = []; }

  /** options: { color, scale, crit, life, rise, outline, shadow } */
  spawn(text, pos, options = {}) {
    this.items.push({
      text: String(text), pos: [pos[0] + (Math.random() - 0.5) * 0.3, pos[1], pos[2] + (Math.random() - 0.5) * 0.3],
      age: 0, life: options.life ?? (options.crit ? 1.1 : 0.85), rise: options.rise ?? 1.5,
      color: options.color || [1, 1, 1], scale: options.scale ?? 1, crit: !!options.crit,
      outline: options.outline ?? [0, 0, 0], shadow: options.shadow,
    });
    if (this.items.length > 200) this.items.shift();
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      if (it.age >= it.life) { this.items.splice(i, 1); continue; }
      // Fast at first, easing out: the number leaps off the target and settles.
      it.pos[1] += it.rise * (1 - it.age / it.life) * dt * 1.6;
    }
  }

  draw(renderer) {
    for (const it of this.items) {
      const t = it.age / it.life;
      // A crit pops large and shrinks back; an ordinary number gives a smaller kick.
      const pop = it.age < 0.14 ? (it.crit ? 0.9 : 0.35) * (1 - it.age / 0.14) : 0;
      const alpha = t < 0.65 ? 1 : clamp(1 - (t - 0.65) / 0.35, 0, 1);
      renderer.drawText(it.text, it.pos, {
        scale: it.scale * (it.crit ? 1.35 : 1) * (1 + pop), color: it.color, alpha, outline: it.outline, shadow: it.shadow,
      });
    }
  }

  clear() { this.items.length = 0; }
}
