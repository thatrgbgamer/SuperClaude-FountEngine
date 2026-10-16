// Combat primitives: melee arcs, projectiles and area effects, plus the effect
// runner that abilities, statuses and map entities all share.
//
// Everything here reports through the actor system's event bus (damage, fx,
// sound, melee, projectile-hit...) instead of touching audio, particles or the
// renderer, so it runs headless. A damage event always carries a type, an
// amount, a crit flag and its source, which is what damage numbers, resistance
// and logging hook onto.

import { add, sub, mul, norm, dist, clamp } from './math.js';

/** Who is at war with whom. Different factions are hostile unless said otherwise; 'neutral' fights nobody. */
export class Relations {
  constructor() { this.table = new Map(); }
  _key(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  /** state: 'hostile' | 'friendly' | 'neutral' */
  set(a, b, state) { this.table.set(this._key(a, b), state); }
  get(a, b) { return this.table.get(this._key(a, b)) || null; }
  hostile(a, b) {
    if (a === b) return false;
    const s = this.get(a, b);
    if (s) return s === 'hostile';
    return a !== 'neutral' && b !== 'neutral';
  }
  friendly(a, b) {
    if (a === b) return true;
    return this.get(a, b) === 'friendly';
  }
}

const norm2 = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-6 ? [v[0] / l, v[1] / l] : [0, 1];
};

export class CombatSystem {
  constructor(system) {
    this.system = system;
    this.swings = [];
    this.projectiles = [];
    this.zones = [];
    this.timers = [];
    this.nextId = 1;
    // Hooks a game can add to bend damage: (event, source, target) => void.
    // Runs after crit and before the target applies its own resistances.
    this.modifiers = [];
  }

  get rng() { return this.system.rng; }
  get collision() { return this.system.collision; }

  fx(preset, pos, options = {}) { this.system.bus.emit('fx', { preset, pos, ...options }); }
  sound(name, pos) { this.system.bus.emit('sound', { name, pos }); }

  // ---- damage ----------------------------------------------------------------

  /** Roll a spec like { type, amount: 5 | [3, 7], scale: { stat, mult }, critChance } into { type, amount, crit }. */
  rollDamage(source, spec) {
    let amount = Array.isArray(spec.amount) ? spec.amount[0] + (spec.amount[1] - spec.amount[0]) * this.rng() : (spec.amount ?? 0);
    for (const sc of [].concat(spec.scale || [])) {
      if (source) amount += (source.stats[sc.stat] || 0) * (sc.mult ?? 1);
    }
    if (source) amount *= source.statMult('damageDealt');
    const critChance = (spec.critChance ?? 0) + (source ? source.stats.critChance || 0 : 0);
    const crit = critChance > 0 && this.rng() < critChance;
    if (crit) amount *= spec.critMult ?? (source && source.stats.critMult) ?? 2;
    return { type: spec.type || 'physical', amount, crit };
  }

  dealDamage(source, target, spec, ctx = {}) {
    const rolled = this.rollDamage(source, spec);
    rolled.amount *= ctx.amountScale ?? 1;
    const ev = {
      ...rolled,
      source, target,
      kind: ctx.kind || 'direct',
      ability: ctx.ability ? ctx.ability.id : null,
      point: ctx.point || target.chest,
      ignoreResist: !!spec.ignoreResist,
    };
    for (const mod of this.modifiers) mod(ev, source, target);
    target.takeDamage(ev);
    return ev;
  }

  healTarget(source, target, spec, ctx = {}) {
    let amount = Array.isArray(spec.amount) ? spec.amount[0] + (spec.amount[1] - spec.amount[0]) * this.rng() : (spec.amount ?? 0);
    for (const sc of [].concat(spec.scale || [])) {
      if (source) amount += (source.stats[sc.stat] || 0) * (sc.mult ?? 1);
    }
    const critChance = (spec.critChance ?? 0) + (source ? source.stats.critChance || 0 : 0);
    const crit = critChance > 0 && this.rng() < critChance;
    if (crit) amount *= spec.critMult ?? 1.5;
    return target.heal(amount * (ctx.amountScale ?? 1), source, { crit });
  }

  knockback(target, from, strength) {
    if (!strength || target.dead) return;
    const t = target.feet;
    const d = norm2([t[0] - from[0], t[2] - from[2]]);
    const v = target.controller.velocity;
    target.controller.velocity = [v[0] + d[0] * strength, v[1], v[2] + d[1] * strength];
  }

  hasLine(a, b) {
    const col = this.collision;
    if (!col) return true;
    const t = col.traceRay(a, b);
    return !t.hit || t.fraction > 0.97;
  }

  targetable(source, target, mode = 'hostile') {
    if (target.dead || target.removed) return false;
    if (mode === 'all') return true;
    if (mode === 'self') return target === source;
    if (mode === 'ally') return target !== source && !source.isHostile(target);
    return source.isHostile(target);
  }

  /** Apply everything a spec says to one target: damage, heal, status, knockback, follow-up effects. */
  applyHit(source, target, spec, ctx = {}) {
    const point = ctx.point || target.chest;
    let ev = null;
    if (spec.damage) ev = this.dealDamage(source, target, spec.damage, { ...ctx, point });
    if (spec.heal) this.healTarget(source, target, spec.heal, ctx);
    for (const st of [].concat(spec.status || [])) {
      target.addStatus(typeof st === 'string' ? st : st.id, { source, ...(typeof st === 'string' ? {} : st) });
    }
    if (spec.knockback) this.knockback(target, source ? source.feet : point, spec.knockback);
    if (spec.onHit) this.run(spec.onHit, { ...ctx, source, target, point });
    this.system.bus.emit('hit', { source, target, event: ev, spec, ctx });
    return ev;
  }

  // ---- melee ------------------------------------------------------------------

  /**
   * An arc in front of the source that is live for a short window. Anything that
   * walks into it while it is live is hit once. `range` is edge to edge.
   * spec: { range, arc (deg), window,
   * hits, targets, damage, status, knockback, onHit }.
   */
  melee(source, spec, ctx = {}) {
    const dir = norm2((ctx.aim && ctx.aim.dir) || source.facing);
    const swing = {
      id: this.nextId++, source, spec, ctx, dir,
      remaining: spec.window ?? 0.12, hit: new Set(), count: 0,
    };
    this.system.bus.emit('melee', { source, spec, dir });
    this.testSwing(swing);
    if (swing.remaining > 0) this.swings.push(swing);
    return swing;
  }

  testSwing(sw) {
    const { source, spec } = sw;
    const f = source.feet;
    const range = spec.range ?? 1.6;
    const half = ((spec.arc ?? 100) * Math.PI) / 360;
    const maxHits = spec.hits ?? Infinity;

    for (const t of this.system.actors) {
      if (sw.count >= maxHits) break;
      if (t === source || sw.hit.has(t) || !this.targetable(source, t, spec.targets)) continue;
      const tf = t.feet;
      const dx = tf[0] - f[0], dz = tf[2] - f[2];
      const d = Math.hypot(dx, dz);
      // Reach is measured edge to edge: a weapon's range is how far past the
      // wielder's own body it extends, whoever is swinging.
      if (d > range + source.radius + t.radius) continue;
      if (d > 0.25) {
        // Widen the cone by the angle the target's body subtends, so a hit on a
        // fat target's edge still counts.
        const slack = Math.atan2(t.radius, d);
        const ang = Math.acos(clamp((dx * sw.dir[0] + dz * sw.dir[1]) / d, -1, 1));
        if (ang > half + slack) continue;
      }
      if (tf[1] > f[1] + source.height + 0.3 || tf[1] + t.height < f[1] - 0.3) continue;
      if (!this.hasLine(source.chest, t.chest)) continue;
      sw.hit.add(t);
      sw.count++;
      this.applyHit(source, t, spec, { ...sw.ctx, kind: 'melee', point: t.chest });
    }
    if (sw.count >= maxHits) sw.remaining = 0;
  }

  // ---- projectiles ---------------------------------------------------------------

  /**
   * spec: { speed, radius, gravity, lifetime, range, sprite, anim, scale, homing: { turn },
   * pierce, spawnOffset, damage, status, onHit, onExpire, targets, trail }
   */
  projectile(source, spec, ctx = {}) {
    const dir = norm2((ctx.aim && ctx.aim.dir) || source.facing);
    const speed = spec.speed ?? 12;
    const pos = add(source.chest, [dir[0] * (spec.spawnOffset ?? 0.5), 0, dir[1] * (spec.spawnOffset ?? 0.5)]);
    const p = {
      id: this.nextId++, source, spec, ctx,
      pos, prev: [...pos],
      vel: [dir[0] * speed, 0, dir[1] * speed],
      speed, age: 0, traveled: 0,
      pierceLeft: spec.pierce ?? 0,
      hit: new Set(),
      target: spec.homing ? (ctx.aim && ctx.aim.target) || null : null,
      sprite: null,
      trailTimer: 0,
      dead: false,
    };
    if (spec.pitch) {
      const pr = (spec.pitch * Math.PI) / 180;
      p.vel = [dir[0] * speed * Math.cos(pr), speed * Math.sin(pr), dir[1] * speed * Math.cos(pr)];
    }
    this.system.attachProjectileSprite(p);
    this.system.bus.emit('projectile-spawn', p);
    this.projectiles.push(p);
    return p;
  }

  segmentHitsActor(p0, p1, radius, actor) {
    const ax = actor.position[0], az = actor.position[2];
    const dx = p1[0] - p0[0], dz = p1[2] - p0[2];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-9 ? clamp(((ax - p0[0]) * dx + (az - p0[2]) * dz) / len2, 0, 1) : 0;
    const cx = p0[0] + dx * t, cz = p0[2] + dz * t;
    if (Math.hypot(cx - ax, cz - az) > radius + actor.radius) return null;
    const cy = p0[1] + (p1[1] - p0[1]) * t;
    const base = actor.feet[1];
    if (cy < base - radius || cy > base + actor.height + radius) return null;
    return { t, point: [cx, cy, cz] };
  }

  stepProjectile(p, dt) {
    const spec = p.spec;
    p.age += dt;
    p.prev = [...p.pos];

    if (p.target && !p.target.dead && spec.homing) {
      // Steer toward the target at a limited turn rate, keeping speed constant.
      const want = norm(sub(p.target.chest, p.pos));
      const cur = norm(p.vel);
      const k = Math.min(1, (spec.homing.turn ?? 4) * dt);
      const nd = norm(add(mul(cur, 1 - k), mul(want, k)));
      p.vel = mul(nd, p.speed);
    }
    if (spec.gravity) p.vel[1] -= spec.gravity * dt;

    const end = add(p.pos, mul(p.vel, dt));
    const r = spec.radius ?? 0.25;

    // Nearest actor along the step.
    let best = null;
    for (const t of this.system.actors) {
      if (t === p.source && !spec.hitsSource) continue;
      if (p.hit.has(t) || !this.targetable(p.source, t, spec.targets)) continue;
      const h = this.segmentHitsActor(p.pos, end, r, t);
      if (h && (!best || h.t < best.h.t)) best = { t, h };
    }
    let wall = null;
    if (this.collision) {
      const tr = this.collision.traceBox(p.pos, end, [r, r, r]);
      if (tr.hit) wall = tr;
    }

    if (best && (!wall || best.h.t <= wall.fraction)) {
      p.hit.add(best.t);
      p.pos = best.h.point;
      this.applyHit(p.source, best.t, spec, { ...p.ctx, kind: 'projectile', point: best.h.point });
      this.system.bus.emit('projectile-hit', p, best.t);
      if (p.pierceLeft > 0) p.pierceLeft--;
      else return this.endProjectile(p, 'hit');
    } else if (wall) {
      p.pos = wall.endPos;
      return this.endProjectile(p, 'wall');
    } else {
      p.pos = end;
    }

    p.traveled += p.speed * dt;
    if (p.age >= (spec.lifetime ?? 3) || (spec.range && p.traveled >= spec.range)) return this.endProjectile(p, 'expired');

    if (spec.trail) {
      p.trailTimer -= dt;
      if (p.trailTimer <= 0) { p.trailTimer = spec.trail.interval ?? 0.05; this.fx(spec.trail.preset, [...p.pos]); }
    }
  }

  endProjectile(p, why) {
    p.dead = true;
    // Spent on a target is the hit's own business; expiring in the air or on a
    // wall runs the expiry effects (an explosion, say) where it ended.
    if (why !== 'hit' && p.spec.onExpire) {
      this.run(p.spec.onExpire, { ...p.ctx, source: p.source, point: [...p.pos], aim: { dir: norm2([p.vel[0], p.vel[2]]), point: [...p.pos] } });
    } else if (why === 'hit' && p.spec.onExpire && p.spec.expireOnHit) {
      this.run(p.spec.onExpire, { ...p.ctx, source: p.source, point: [...p.pos] });
    }
    this.system.bus.emit('projectile-end', p, why);
  }

  // ---- areas ----------------------------------------------------------------------

  /**
   * A circle or cone. Instant, or lasting `duration` seconds and re-applying every
   * `tick`. spec: { shape, radius, arc, duration, tick, targets, maxTargets, falloff,
   * damage, heal, status, knockback, onHit, fx }.
   */
  area(source, spec, ctx = {}) {
    const center = [...(ctx.point || source.feet)];
    const dir = norm2((ctx.aim && ctx.aim.dir) || source.facing);
    if (spec.fx) this.fx(spec.fx, center, { radius: spec.radius });
    if (!(spec.duration > 0)) {
      this.applyArea(source, spec, center, dir, ctx);
      return null;
    }
    const zone = {
      id: this.nextId++, source, spec, ctx, center, dir,
      remaining: spec.duration, tickAcc: spec.tick ?? 0.5, tick: spec.tick ?? 0.5,
    };
    this.zones.push(zone);
    this.system.bus.emit('zone-spawn', zone);
    return zone;
  }

  applyArea(source, spec, center, dir, ctx) {
    const radius = spec.radius ?? 2;
    const cone = spec.shape === 'cone';
    const half = ((spec.arc ?? 90) * Math.PI) / 360;
    const found = [];
    for (const t of this.system.actors) {
      if (!this.targetable(source, t, spec.targets) && !(spec.targets === 'ally' && t === source && spec.includeSource)) continue;
      const tf = t.feet;
      const dx = tf[0] - center[0], dz = tf[2] - center[2];
      const d = Math.hypot(dx, dz);
      if (d > radius + t.radius) continue;
      if (cone && d > 0.25) {
        const ang = Math.acos(clamp((dx * dir[0] + dz * dir[1]) / d, -1, 1));
        if (ang > half + Math.atan2(t.radius, d)) continue;
      }
      if (Math.abs(tf[1] - center[1]) > (spec.height ?? 2.5)) continue;
      found.push({ t, d });
    }
    found.sort((a, b) => a.d - b.d);
    for (const { t, d } of found.slice(0, spec.maxTargets ?? Infinity)) {
      const scale = 1 - (spec.falloff ?? 0) * clamp(d / radius, 0, 1);
      this.applyHit(source, t, spec, { ...ctx, kind: 'area', point: t.chest, amountScale: scale });
    }
    return found.length;
  }

  // ---- effect runner ---------------------------------------------------------------

  schedule(delay, fn) { this.timers.push({ t: delay, fn }); }

  /**
   * Run a list of effects. ctx: { source, target, point, aim: { dir, point, target }, ability }.
   * Effect types: damage, heal, status, melee, projectile, area, knockback,
   * resource, particles, sound. Any effect may carry `delay` (seconds) and `chance`.
   */
  run(effects, ctx) {
    for (const effect of [].concat(effects || [])) {
      if (effect.chance !== undefined && this.rng() > effect.chance) continue;
      if (effect.delay > 0) { this.schedule(effect.delay, () => this.runOne(effect, ctx)); continue; }
      this.runOne(effect, ctx);
    }
  }

  runOne(effect, ctx) {
    const source = ctx.source;
    if (source && source.dead && !effect.survives) return;
    const target = ctx.target || null;
    switch (effect.type) {
      case 'damage':
        if (target) this.dealDamage(source, target, effect.damage || effect, ctx);
        break;
      case 'heal':
        this.healTarget(source, effect.self ? source : (target || source), effect.heal || effect, ctx);
        break;
      case 'status': {
        const who = effect.self ? source : (target || source);
        if (who) who.addStatus(effect.status, { source, duration: effect.duration, stacks: effect.stacks });
        break;
      }
      case 'melee': this.melee(source, effect, ctx); break;
      case 'projectile': this.projectile(source, effect, ctx); break;
      case 'area': this.area(source, effect, ctx); break;
      case 'knockback':
        if (target) this.knockback(target, source ? source.feet : ctx.point, effect.strength ?? 8);
        break;
      case 'resource':
        if (source) source.gain(effect.resource, effect.amount);
        break;
      case 'particles': {
        const at = effect.at === 'source' ? source.chest : effect.at === 'target' && target ? target.chest : (ctx.point || (source && source.feet));
        if (at) this.fx(effect.preset, [...at], { count: effect.count });
        break;
      }
      case 'sound': {
        const at = ctx.point || (source && source.feet);
        this.sound(effect.name, at ? [...at] : null);
        break;
      }
      default:
        console.warn(`[fount] unknown effect type "${effect.type}"`);
    }
  }

  // ---- the step ----------------------------------------------------------------------

  update(dt) {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const timer = this.timers[i];
      timer.t -= dt;
      if (timer.t <= 0) { this.timers.splice(i, 1); timer.fn(); }
    }

    for (let i = this.swings.length - 1; i >= 0; i--) {
      const sw = this.swings[i];
      sw.remaining -= dt;
      if (!sw.source.dead) this.testSwing(sw);
      if (sw.remaining <= 0 || sw.source.dead) this.swings.splice(i, 1);
    }

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p.dead) this.stepProjectile(p, dt);
      if (p.dead) this.projectiles.splice(i, 1);
    }

    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.remaining -= dt;
      z.tickAcc -= dt;
      if (z.spec.follow && z.source && !z.source.dead) z.center = [...z.source.feet];
      if (z.tickAcc <= 0) { z.tickAcc += z.tick; this.applyArea(z.source, z.spec, z.center, z.dir, z.ctx); }
      if (z.remaining <= 0 || (z.spec.follow && z.source && z.source.dead)) { this.zones.splice(i, 1); this.system.bus.emit('zone-end', z); }
    }
  }

  clear() {
    this.swings.length = 0;
    this.projectiles.length = 0;
    this.zones.length = 0;
    this.timers.length = 0;
  }
}

export { dist };
