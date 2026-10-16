// An Actor is anything with health that acts in the world: the player, a
// townsperson, a skeleton. It owns the RPG state (health, resources, statuses,
// cooldowns, faction) and a CharacterController for movement, and reports what
// happens to it as events, so the same code runs headless in tests and, later,
// on a server. It knows nothing about rendering beyond holding a sprite.
//
// Input comes in as `intent`: a player controller or an AI writes
// actor.intent.move / .face each step, and update() turns that into motion.

import { Emitter } from './events.js';
import { CharacterController } from './physics.js';
import { lenSq, clamp } from './math.js';

export const DAMAGE_TYPES = ['physical', 'fire', 'frost', 'holy', 'shadow'];

// ---------------------------------------------------------------------------
// Status effects: timed buffs and debuffs, defined as data.
// ---------------------------------------------------------------------------
//
//   defineStatus('burning', {
//     duration: 4,
//     tick: { interval: 1, effects: [{ type: 'damage', damage: { type: 'fire', amount: 3 } }] },
//     mods: { speed: 0.9, damageTaken: 1.1, resist: { frost: -0.2 } },
//     flags: ['stun' | 'root' | 'silence' | 'invulnerable'],
//     stacking: 'refresh' | 'stack' | 'ignore' | 'replace', maxStacks: 3,
//     tint: [1, 0.6, 0.4],
//     onApply(actor, status) {}, onTick(actor, status, dt) {}, onExpire(actor, status) {},
//   })

const STATUS_DEFS = new Map();

export function defineStatus(id, def) {
  STATUS_DEFS.set(id, { id, stacking: 'refresh', maxStacks: 1, duration: 5, ...def });
}

export function defineStatuses(table) {
  for (const [id, def] of Object.entries(table || {})) defineStatus(id, def);
}

export function getStatusDef(id) { return STATUS_DEFS.get(id) || null; }

let nextActorId = 1;

/**
 * One step of an actor's movement. The server, an online client predicting its
 * own player, and a headless bot all call exactly this, which is what lets a
 * client replay its recent inputs on top of the server's state and land on the
 * same answer. `move` is [x, z] (magnitude up to 1) and `speed` the actor's
 * current top speed.
 */
export function stepMovement(controller, collision, move, speed, dt) {
  const mag = Math.min(1, Math.hypot(move[0], move[1]));
  controller.maxSpeed = speed * (mag || 1);
  if (collision) controller.update(collision, [move[0], 0, move[1]], false, dt);
  return mag;
}

function normaliseResources(input = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(input)) {
    if (typeof spec === 'number') out[name] = { value: spec, max: spec, regen: 0 };
    else out[name] = { max: spec.max ?? spec.value ?? 0, value: spec.value ?? spec.max ?? 0, regen: spec.regen ?? 0 };
  }
  return out;
}

export class Actor extends Emitter {
  constructor(options = {}) {
    super();
    this.id = nextActorId++;
    this.name = options.name || 'Actor';
    this.kind = options.kind || 'npc';             // 'player' | 'npc'
    this.faction = options.faction ?? 'neutral';
    this.maxHealth = options.health ?? options.maxHealth ?? 100;
    this.health = options.currentHealth ?? this.maxHealth;
    this.resources = normaliseResources(options.resources);
    this.stats = { ...(options.stats || {}) };      // free-form: power, critChance, ... read by damage specs
    this.resist = { ...(options.resist || {}) };    // fraction of damage ignored, per type; negative = vulnerable

    this.radius = options.radius ?? 0.35;
    this.height = options.height ?? 1.7;
    this.mass = options.mass ?? 1;                  // heavier actors are pushed less when crowding
    this.baseSpeed = options.speed ?? 4;

    const half = [this.radius, this.height / 2, this.radius];
    const feet = options.feet || [0, 0, 0];
    this.controller = new CharacterController({
      position: [feet[0], feet[1] + half[1], feet[2]],
      halfExtents: half,
      maxSpeed: this.baseSpeed,
      acceleration: options.acceleration ?? 50,     // top-down characters answer instantly
      friction: options.friction ?? 14,
      gravity: options.gravity,
    });
    this.prevPosition = [...this.controller.position];

    this.facing = options.facing ? [...options.facing] : [0, 1];   // unit vector on the ground plane
    this.intent = { move: [0, 0], face: null };

    this.dead = false;
    this.deadFor = 0;
    this.corpseTime = options.corpseTime ?? 6;
    this.removed = false;
    this.godMode = false;

    this.statuses = [];
    this.cooldowns = {};
    this.casting = null;
    this.busyUntil = 0;
    this.clock = 0;

    this.sprite = null;
    this.spriteScale = options.spriteScale ?? 1;
    this._action = null;
    this.actionName = null;         // the last one-shot animation requested...
    this.actionSeq = 0;             // ...and a counter, so a client can tell "attack again" from "still attacking"
    this.publicData = {};           // plain data every nearby player sees (level, title): nameplates read this
    this.movementPaused = false;    // a server sets this for a tick whose movement was already played (see ServerPlayer)
    this.lastAttacker = null;
    this.lastDamagedAt = -Infinity;
    this.ai = null;
    this.system = null;                             // set when added to an ActorSystem
    this.entity = null;                             // the map entity that owns this actor, if any
    this.data = {};                                 // anything else a game wants to hang on an actor
  }

  // ---- geometry -------------------------------------------------------------

  get position() { return this.controller.position; }
  get velocity() { return this.controller.velocity; }
  get halfHeight() { return this.controller.halfExtents[1]; }
  get feet() { const p = this.controller.position; return [p[0], p[1] - this.halfHeight, p[2]]; }
  /** Roughly chest height: where projectiles leave and line-of-sight is traced. */
  get chest() { const f = this.feet; return [f[0], f[1] + this.height * 0.62, f[2]]; }

  /** Interpolated feet position for drawing between physics steps. */
  drawPosition(alpha) {
    const p = this.controller.position, q = this.prevPosition;
    return [
      q[0] + (p[0] - q[0]) * alpha,
      q[1] + (p[1] - q[1]) * alpha - this.halfHeight,
      q[2] + (p[2] - q[2]) * alpha,
    ];
  }

  teleport(feet) {
    this.controller.position = [feet[0], feet[1] + this.halfHeight, feet[2]];
    this.controller.velocity = [0, 0, 0];
    this.prevPosition = [...this.controller.position];
  }

  // ---- state queries ---------------------------------------------------------

  hasFlag(flag) {
    for (const s of this.statuses) if (s.def.flags && s.def.flags.includes(flag)) return true;
    return false;
  }

  /** Product of one multiplier across every active status (per stack). */
  statMult(key) {
    let m = 1;
    for (const s of this.statuses) {
      const v = s.def.mods && s.def.mods[key];
      if (v !== undefined) m *= Math.pow(v, s.stacks);
    }
    return m;
  }

  resistance(type) {
    let r = this.resist[type] || 0;
    for (const s of this.statuses) {
      const v = s.def.mods && s.def.mods.resist && s.def.mods.resist[type];
      if (v) r += v * s.stacks;
    }
    return clamp(r, -2, 0.95);
  }

  get speed() { return this.baseSpeed * this.statMult('speed'); }

  canAct() { return !this.dead && !this.hasFlag('stun'); }
  canMove() {
    if (!this.canAct() || this.hasFlag('root')) return false;
    if (this.casting && !this.casting.def.moveWhileCasting) return false;
    return true;
  }
  canCast() { return this.canAct() && !this.hasFlag('silence') && !this.casting && this.clock >= this.busyUntil; }

  isHostile(other) { return !!this.system && this.system.relations.hostile(this.faction, other.faction) && other !== this; }

  cooldownRemaining(id) { return Math.max(0, this.cooldowns[id] || 0); }

  // ---- resources --------------------------------------------------------------

  canAfford(cost) {
    for (const [name, amount] of Object.entries(cost || {})) {
      const r = this.resources[name];
      if (!r || r.value < amount) return false;
    }
    return true;
  }

  spend(cost) {
    for (const [name, amount] of Object.entries(cost || {})) {
      const r = this.resources[name];
      if (r) r.value = clamp(r.value - amount, 0, r.max);
    }
  }

  gain(name, amount) {
    const r = this.resources[name];
    if (r) r.value = clamp(r.value + amount, 0, r.max);
  }

  // ---- damage, healing, death --------------------------------------------------

  /**
   * Take a damage event: { type, amount, crit, source, ability, kind }. Source-side
   * scaling has already happened (CombatSystem does it); this applies what the
   * *target* brings to it: resistance, statuses, invulnerability. Returns the
   * damage actually dealt, and fills in ev.final and ev.killed.
   */
  takeDamage(event) {
    if (this.dead) return 0;
    // The caller's own object is filled in (final, killed), so whoever dealt
    // the damage can read back what actually landed.
    const ev = event;
    ev.type ??= 'physical';
    ev.amount ??= 0;
    ev.crit ??= false;
    ev.source ??= null;
    ev.target = this;

    let amount = ev.amount;
    if (!ev.ignoreResist) {
      amount *= 1 - this.resistance(ev.type);
      amount *= this.statMult('damageTaken');
    }
    if (this.godMode || this.hasFlag('invulnerable')) amount = 0;
    amount = amount > 0 ? Math.max(1, Math.round(amount)) : 0;

    ev.final = amount;
    ev.killed = false;
    this.health = Math.max(0, this.health - amount);
    if (amount > 0) {
      if (ev.source && ev.source !== this) this.lastAttacker = ev.source;
      this.lastDamagedAt = this.clock;
      if (this.sprite) {
        this.sprite.flash(0.14);
        if (this.sprite.has('hurt') && this.health > 0) this.playAction('hurt');
      }
    }
    if (this.health <= 0) {
      ev.killed = true;
      this.die(ev);
      if (ev.source && ev.source.emit) ev.source.emit('kill', ev.source, this, ev);
    }

    this.emit('damage', ev);
    if (this.system) this.system.bus.emit('damage', ev);
    return amount;
  }

  heal(amount, source = null, options = {}) {
    if (this.dead || amount <= 0) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    const ev = { target: this, source, amount: this.health - before, requested: amount, crit: !!options.crit };
    this.emit('heal', ev);
    if (this.system) this.system.bus.emit('heal', ev);
    return ev.amount;
  }

  die(cause = null) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.deadFor = 0;
    this.cancelCast('died');
    this.intent.move = [0, 0];
    this.statuses.length = 0;
    this.controller.velocity = [0, 0, 0];
    if (this.sprite) this.sprite.play('death', { restart: true });
    this.emit('death', this, cause);
    if (this.system) this.system.bus.emit('death', this, cause);
  }

  revive(health = this.maxHealth) {
    this.dead = false;
    this.removed = false;
    this.deadFor = 0;
    this.health = clamp(health, 1, this.maxHealth);
    this._action = null;
    if (this.sprite) this.sprite.play('idle', { restart: true });
    this.emit('revive', this);
  }

  // ---- statuses -----------------------------------------------------------------

  /**
   * Apply a status by id (or an inline definition). Returns the live status
   * record, or null if it was refused (unknown id, ignored by stacking rules).
   */
  addStatus(idOrDef, options = {}) {
    if (this.dead) return null;
    let def;
    if (typeof idOrDef === 'string') {
      def = getStatusDef(idOrDef);
      if (!def) {
        console.warn(`[fount] unknown status "${idOrDef}" (define it with defineStatus or the statuses block)`);
        return null;
      }
    } else {
      def = { id: idOrDef.id || 'inline', stacking: 'refresh', maxStacks: 1, duration: 5, ...idOrDef };
    }
    const duration = options.duration ?? def.duration;
    const existing = this.statuses.find((s) => s.def.id === def.id);
    if (existing) {
      if (def.stacking === 'ignore') return null;
      if (def.stacking === 'stack') existing.stacks = Math.min(def.maxStacks, existing.stacks + (options.stacks ?? 1));
      if (def.stacking === 'replace') { existing.tickAcc = 0; existing.source = options.source || null; }
      existing.remaining = Math.max(existing.remaining, duration);
      existing.duration = duration;
      return existing;
    }
    const status = { def, remaining: duration, duration, stacks: options.stacks ?? 1, tickAcc: 0, source: options.source || null };
    this.statuses.push(status);
    if (def.onApply) def.onApply(this, status);
    this.emit('status', this, status, 'apply');
    if (this.system) this.system.bus.emit('status', this, status, 'apply');
    return status;
  }

  removeStatus(id) {
    const i = this.statuses.findIndex((s) => s.def.id === id);
    if (i < 0) return false;
    const [s] = this.statuses.splice(i, 1);
    if (s.def.onExpire) s.def.onExpire(this, s);
    this.emit('status', this, s, 'expire');
    if (this.system) this.system.bus.emit('status', this, s, 'expire');
    return true;
  }

  hasStatus(id) { return this.statuses.some((s) => s.def.id === id); }

  // ---- casting ---------------------------------------------------------------------

  cancelCast(reason = 'cancelled') {
    if (!this.casting) return;
    const c = this.casting;
    this.casting = null;
    this.emit('cast-cancel', this, c.def, reason);
    if (this.system) this.system.bus.emit('cast-cancel', this, c.def, reason);
  }

  // ---- animation ---------------------------------------------------------------------

  /** Play a one-shot (attack, cast, hurt) that locomotion must not override until it ends. */
  playAction(name) {
    // Recorded even with no sprite: a server has none, and tells clients which one-shot to play.
    this.actionName = name;
    this.actionSeq++;
    if (!this.sprite || !this.sprite.has(name)) return false;
    this.sprite.play(name, { restart: true });
    this._action = name;
    return true;
  }

  // ---- the step ------------------------------------------------------------------------

  update(dt) {
    this.clock += dt;
    this.prevPosition = [...this.controller.position];

    if (this.dead) {
      this.deadFor += dt;
      if (this.sprite) this.sprite.update(dt);
      if (this.kind !== 'player' && this.deadFor >= this.corpseTime) this.removed = true;
      return;
    }

    // Statuses: tick, expire.
    for (let i = this.statuses.length - 1; i >= 0; i--) {
      const s = this.statuses[i];
      s.remaining -= dt;
      const tick = s.def.tick;
      if (tick && tick.interval > 0) {
        s.tickAcc += dt;
        while (s.tickAcc >= tick.interval && !this.dead) {
          s.tickAcc -= tick.interval;
          if (tick.effects && this.system) {
            this.system.combat.run(tick.effects, { source: s.source || this, target: this, point: this.feet, status: s.def.id, aim: { dir: this.facing, point: this.feet, target: this } });
          }
        }
      }
      if (s.def.onTick) s.def.onTick(this, s, dt);
      if (this.dead) return;
      if (s.remaining <= 0 && Number.isFinite(s.remaining)) this.removeStatus(s.def.id);
    }

    // Resources regenerate; cooldowns count down.
    for (const r of Object.values(this.resources)) {
      if (r.regen && r.value < r.max) r.value = Math.min(r.max, r.value + r.regen * dt);
    }
    for (const id of Object.keys(this.cooldowns)) {
      this.cooldowns[id] -= dt;
      if (this.cooldowns[id] <= 0) delete this.cooldowns[id];
    }

    // A cast in progress counts up, then fires.
    if (this.casting) {
      if (this.casting.def.interruptOnMove && lenSq(this.intent.move) > 0.01) {
        this.cancelCast('moved');
      } else {
        this.casting.t += dt;
        if (this.casting.t >= this.casting.total && this.system) this.system.abilities.finishCast(this);
      }
    }
    if (this.hasFlag('stun')) this.cancelCast('stunned');

    // Movement.
    const move = this.canMove() ? this.intent.move : [0, 0];
    const mag = this.movementPaused ? 0 : stepMovement(this.controller, this.system ? this.system.collision : null, move, this.speed, dt);

    // Facing: an explicit target wins, otherwise face where we are going.
    if (this.intent.face && (this.intent.face[0] || this.intent.face[1])) {
      this.facing = normalise2(this.intent.face);
    } else if (mag > 0.05 && this.canMove()) {
      this.facing = normalise2(move);
    }

    if (this.sprite) {
      this.sprite.setHeading(this.facing[0], this.facing[1]);
      this.sprite.update(dt);
      this.updateLocomotionAnim();
    }
  }

  updateLocomotionAnim() {
    const s = this.sprite;
    if (this._action && s.animName === this._action && !s.finished) return; // let the one-shot finish
    this._action = null;
    const v = this.controller.velocity;
    const moving = v[0] * v[0] + v[2] * v[2] > 0.35 * 0.35;
    s.play(moving && s.has('walk') ? 'walk' : 'idle');
  }

  // ---- persistence (map transitions, save games) -----------------------------------------

  /** The state worth carrying to another map or into a save file. Plain JSON. */
  snapshot() {
    return {
      name: this.name,
      health: this.health,
      maxHealth: this.maxHealth,
      resources: Object.fromEntries(Object.entries(this.resources).map(([k, r]) => [k, { ...r }])),
      stats: { ...this.stats },
      statuses: this.statuses.map((s) => ({ id: s.def.id, remaining: s.remaining, stacks: s.stacks })),
      cooldowns: { ...this.cooldowns },
      data: JSON.parse(JSON.stringify(this.data)),
    };
  }

  restore(snap) {
    if (!snap) return;
    this.maxHealth = snap.maxHealth ?? this.maxHealth;
    this.health = clamp(snap.health ?? this.health, 1, this.maxHealth);
    if (snap.resources) {
      for (const [k, r] of Object.entries(snap.resources)) this.resources[k] = { ...r };
    }
    if (snap.stats) Object.assign(this.stats, snap.stats);
    if (snap.data) this.data = JSON.parse(JSON.stringify(snap.data));
    this.cooldowns = { ...(snap.cooldowns || {}) };
    for (const s of snap.statuses || []) {
      const st = this.addStatus(s.id, { duration: s.remaining, stacks: s.stacks });
      if (st) st.remaining = s.remaining;
    }
  }
}

function normalise2(v) {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-6 ? [v[0] / l, v[1] / l] : [0, 1];
}

