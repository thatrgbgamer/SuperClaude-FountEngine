// The actor system: owns every Actor in a map plus the combat, ability and
// navigation services they share, and steps them at the engine's fixed rate.
// Headless by design. Drawing is one method that takes a renderer, nothing in
// here imports GL, and everything that happens leaves through `bus` as an event
// (damage, death, fx, sound, ...) that audio, particles and the HUD subscribe to.

import { Emitter } from './events.js';
import { Actor } from './actor.js';
import { AIController } from './ai.js';
import { CombatSystem, Relations } from './combat.js';
import { AbilitySystem } from './abilities.js';
import { NavGrid } from './nav.js';
import { SpriteInstance } from './sprites.js';
import { clamp } from './math.js';

export class ActorSystem {
  /**
   * options: { collision, sprites, rng, nav: { cell, top, ... }, abilityDefs, relations }.
   * `abilityDefs` and `relations` are shared across maps, so a game defines
   * them once rather than on every level load.
   */
  constructor(options = {}) {
    this.collision = options.collision || null;
    this.sprites = options.sprites || null;
    this.rng = options.rng || Math.random;
    this.navOptions = options.nav || {};
    this.navEnabled = this.navOptions.enabled !== false;
    this._nav = null;
    this.bus = options.bus || new Emitter();      // a game passes its own so listeners outlive any one map
    this.actors = [];
    this.index = new Map();                       // actor id -> actor, for lookups by id from the network
    this.relations = options.relations || new Relations();
    this.combat = new CombatSystem(this);
    this.abilities = new AbilitySystem(this, options.abilityDefs);
    this.time = 0;
  }

  /** The baked walkable grid. Built on first use, so maps with no AI never pay for it. */
  get nav() {
    if (!this._nav && this.collision && this.navEnabled) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this._nav = NavGrid.build(this.collision, this.navOptions);
      const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      console.info(`[fount] nav baked: ${this._nav.w}x${this._nav.h} cells @ ${this._nav.cell}m, ${this._nav.walkableCount} walkable, ${ms.toFixed(0)}ms`);
    }
    return this._nav;
  }

  rebake() { this._nav = null; return this.nav; }

  // ---- membership ---------------------------------------------------------------

  /**
   * Create an actor and add it. options are Actor's, plus { sprite, ai }:
   * `sprite` is a registered sprite name, `ai` is an AI config object (or true for defaults).
   */
  spawn(options = {}) {
    const actor = new Actor(options);
    actor.spriteName = options.sprite || null;    // clients draw from the name, whether or not this side has a library
    if (options.sprite && this.sprites) {
      actor.sprite = new SpriteInstance(this.sprites, options.sprite, { scale: options.spriteScale ?? 1 });
      actor.sprite.setHeading(actor.facing[0], actor.facing[1]);
    }
    if (options.ai) new AIController(actor, options.ai === true ? {} : options.ai);
    return this.add(actor);
  }

  add(actor) {
    actor.system = this;
    this.actors.push(actor);
    this.index.set(actor.id, actor);
    if (actor.ai) actor.ai.attach(this);
    this.bus.emit('spawn', actor);
    return actor;
  }

  remove(actor) {
    const i = this.actors.indexOf(actor);
    if (i >= 0) this.actors.splice(i, 1);
    this.index.delete(actor.id);
    actor.system = null;
    this.bus.emit('remove', actor);
  }

  clear() {
    this.actors.length = 0;
    this.index.clear();
    this.combat.clear();
  }

  getById(id) { return this.index.get(id) || null; }

  // ---- queries ---------------------------------------------------------------------

  /** Living actors within `radius` of a point on the ground plane. */
  inRadius(point, radius, filter = null) {
    const out = [];
    for (const a of this.actors) {
      if (a.dead) continue;
      const f = a.feet;
      if (Math.hypot(f[0] - point[0], f[2] - point[2]) - a.radius > radius) continue;
      if (!filter || filter(a)) out.push(a);
    }
    return out;
  }

  nearestHostile(actor, radius = Infinity) {
    let best = null, bestD = radius;
    for (const o of this.actors) {
      if (o.dead || !actor.isHostile(o)) continue;
      const d = Math.hypot(o.feet[0] - actor.feet[0], o.feet[2] - actor.feet[2]) - o.radius;
      if (d < bestD) { best = o; bestD = d; }
    }
    return best;
  }

  byName(name) { return this.actors.filter((a) => a.name === name); }

  // ---- the step ----------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    for (const a of this.actors) if (a.ai && !a.dead) a.ai.update(dt);
    for (const a of this.actors) a.update(dt);
    this.separate(dt);
    this.combat.update(dt);

    for (const p of this.combat.projectiles) {
      if (!p.sprite) continue;
      p.sprite.setHeading(p.vel[0], p.vel[2]);
      p.sprite.update(dt);
    }
    for (let i = this.actors.length - 1; i >= 0; i--) {
      if (this.actors[i].removed) this.remove(this.actors[i]);
    }
  }

  /**
   * Actors are not solid to each other (the controller only knows the world),
   * so crowds would stack on one spot. A gentle push apart, weighted by mass so
   * a player is not shoved around by every rat.
   */
  separate(dt) {
    const list = this.actors;
    const k = Math.min(1, 12 * dt);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead) continue;
      const ap = a.controller.position;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead) continue;
        const bp = b.controller.position;
        if (Math.abs(ap[1] - bp[1]) > 1.5) continue;
        let dx = bp[0] - ap[0], dz = bp[2] - ap[2];
        const min = (a.radius + b.radius) * 0.9;
        let d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-4) { const ang = this.rng() * Math.PI * 2; dx = Math.cos(ang); dz = Math.sin(ang); d = 1; }
        const push = (min - d) * k;
        const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
        this.nudge(a, -dx / d * push * wa, -dz / d * push * wa);
        this.nudge(b, dx / d * push * wb, dz / d * push * wb);
      }
    }
  }

  nudge(actor, dx, dz) {
    const p = actor.controller.position;
    const next = [p[0] + dx, p[1], p[2] + dz];
    if (this.collision && this.collision.pointInSolid(next, actor.controller.halfExtents)) return;
    actor.controller.position = next;
  }

  // ---- drawing --------------------------------------------------------------------------

  attachProjectileSprite(p) {
    if (!this.sprites || !p.spec.sprite) return;
    try {
      p.sprite = new SpriteInstance(this.sprites, p.spec.sprite, { scale: p.spec.scale ?? 1, anim: p.spec.anim, tint: p.spec.tint });
    } catch (err) {
      this.sprites.warnOnce(`proj:${p.spec.sprite}`, err.message);
    }
  }

  groundBelow(feet, onGround) {
    if (onGround || !this.collision) return feet[1];
    const t = this.collision.traceRay(feet, [feet[0], feet[1] - 30, feet[2]]);
    return t.hit ? t.endPos[1] : feet[1];
  }

  /** Queue every actor, projectile and ground shadow on the renderer. */
  draw(renderer, cameraYaw, alpha = 1) {
    for (const a of this.actors) {
      if (!a.sprite) continue;
      const pos = a.drawPosition(alpha);
      const fade = a.dead ? clamp((a.corpseTime - a.deadFor) / 1.5, 0, 1) : 1;
      if (fade <= 0) continue;
      if (!a.dead) {
        renderer.drawBlobShadow([pos[0], this.groundBelow(pos, a.controller.onGround), pos[2]], a.radius * 1.3, 0.75);
      }
      let tint = a.sprite.tint;
      for (const s of a.statuses) {
        if (s.def.tint) tint = [tint[0] * s.def.tint[0], tint[1] * s.def.tint[1], tint[2] * s.def.tint[2]];
      }
      a.sprite.draw(renderer, pos, cameraYaw, { tint, alpha: fade });
    }
    for (const p of this.combat.projectiles) {
      if (p.sprite) p.sprite.draw(renderer, p.pos, cameraYaw);
    }
  }
}
