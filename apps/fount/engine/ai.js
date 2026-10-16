// Generic monster AI: a small state machine, tuned entirely from map JSON.
//
//   idle -> wander -> idle ...       standing about, drifting near home
//   idle|wander -> notice            a hostile came within aggroRadius (and line of sight)
//   notice -> chase                  after a short "!" beat
//   chase -> attack                  close enough (or in line of sight, for ranged)
//   chase|attack -> leash            target lost, too far, or strayed beyond leashRadius
//   leash -> idle                    back home, healed
//
// It writes only actor.intent (where to move, what to face) and asks the
// ability system to attack, so it neither knows nor cares what the actor looks
// like. Navigation goes through the baked NavGrid when the map has one.

import { dist } from './math.js';

export const AI_DEFAULTS = {
  aggroRadius: 8,          // notice hostiles this close
  loseRadius: 14,          // give up the chase this far from the target
  leashRadius: 20,         // never stray this far from home
  noticeTime: 0.35,
  wanderRadius: 3,
  wanderPause: [1.5, 4],
  wanderSpeed: 0.45,       // fraction of full speed while idly wandering
  canWander: true,
  attackRange: 1.6,        // reach, measured from the edge of the target
  preferRange: null,       // ranged units back off if the target gets closer than 60% of this
  senses: 'los',           // 'los' needs line of sight to notice; 'radius' does not
  groupAggro: 0,           // radius in which same-faction allies are alerted too
  attackAbility: null,     // an ability id, or leave null and use `attack` below
  attack: { damage: { type: 'physical', amount: 8 }, interval: 1.4, windup: 0.3, arc: 120 },
};

const norm2 = (x, z) => {
  const l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : [0, 0];
};

export class AIController {
  constructor(actor, config = {}) {
    this.actor = actor;
    this.cfg = { ...AI_DEFAULTS, ...config, attack: { ...AI_DEFAULTS.attack, ...(config.attack || {}) } };
    this.state = 'idle';
    this.timer = 0;
    this.time = 0;
    this.home = [...actor.feet];
    this.target = null;
    this.wanderTarget = null;
    this.path = null;
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.lastDest = null;
    this.scanTimer = Math.random() * 0.25;
    this.stuckTimer = 0;
    this.stuckFrom = [...actor.feet];
    this.stuckCount = 0;
    this.noticed = false;
    this.enabled = true;        // a map can switch a monster's brain off (it then just stands there)
    this.alerted = false;       // told about a target by an ally rather than seeing it, so it has to keep believing in it
    this.abilityId = this.cfg.attackAbility;
    actor.ai = this;
  }

  /** Called once the actor has joined a system: registers the inline attack as an ability. */
  attach(system) {
    this.system = system;
    if (!this.abilityId) {
      const a = this.cfg.attack;
      const ranged = !!a.projectile;
      this.abilityId = `__attack_${this.actor.id}`;
      system.abilities.define(this.abilityId, {
        name: 'Attack',
        targeting: 'direction',
        range: this.cfg.attackRange,
        cooldown: a.interval,
        castTime: a.windup,
        recovery: 0.1,
        anim: 'attack',
        effects: [ranged
          ? { type: 'projectile', ...a.projectile, damage: a.damage }
          : { type: 'melee', range: this.cfg.attackRange, arc: a.arc, window: 0.14, damage: a.damage, knockback: a.knockback }],
      });
    }
  }

  setState(next) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.timer = 0;
    if (next === 'idle') this.alerted = false;
    this.path = null;
    this.stuckCount = 0;
    this.actor.emit('ai-state', this.actor, next, prev);
    if (this.system) this.system.bus.emit('ai-state', this.actor, next, prev);
  }

  // ---- awareness -------------------------------------------------------------

  /** Distance from the actor's edge to the target's edge on the ground plane. */
  gap(target) {
    const a = this.actor.feet, t = target.feet;
    return Math.hypot(t[0] - a[0], t[2] - a[2]) - this.actor.radius - target.radius;
  }

  hasLine(target) {
    return this.system.combat.hasLine(this.actor.chest, target.chest);
  }

  /** The nearest hostile that can be noticed right now, or null. */
  scan() {
    const a = this.actor;
    let best = null, bestD = Infinity;
    for (const o of this.system.actors) {
      if (o.dead || !a.isHostile(o)) continue;
      const d = this.gap(o);
      if (d > this.cfg.aggroRadius || d >= bestD) continue;
      if (this.cfg.senses === 'los' && !this.hasLine(o)) continue;
      best = o; bestD = d;
    }
    return best;
  }

  /** Someone nearby spotted trouble: skip the wondering and notice it too. */
  alert(target) {
    if ((this.state === 'idle' || this.state === 'wander') && !this.actor.dead) {
      this.target = target;
      this.noticed = false;
      this.alerted = true;
      this.setState('notice');
    }
  }

  alertAllies(target) {
    const r = this.cfg.groupAggro;
    if (!(r > 0)) return;
    for (const o of this.system.actors) {
      if (o === this.actor || o.dead || !o.ai || o.faction !== this.actor.faction) continue;
      if (dist(o.feet, this.actor.feet) <= r) o.ai.alert(target);
    }
  }

  // ---- movement ----------------------------------------------------------------

  /** Walk toward a world point along the nav grid, or straight if nothing is in the way. */
  moveTo(dest, speed = 1) {
    const a = this.actor;
    const feet = a.feet;
    const nav = this.system.nav;
    let aim = dest;

    if (nav) {
      this.repathTimer -= this.dtLast;
      const moved = this.lastDest ? Math.hypot(dest[0] - this.lastDest[0], dest[2] - this.lastDest[2]) : Infinity;
      if (!this.path || this.repathTimer <= 0 || moved > nav.cell * 2) {
        this.repathTimer = 0.35 + Math.random() * 0.2;
        this.lastDest = [...dest];
        this.path = nav.lineClear(feet, dest) ? null : nav.findPath(feet, dest);
        this.pathIndex = 0;
        this.direct = !this.path;
      }
      if (this.path) {
        while (this.pathIndex < this.path.length - 1 && Math.hypot(this.path[this.pathIndex][0] - feet[0], this.path[this.pathIndex][2] - feet[2]) < 0.4) this.pathIndex++;
        aim = this.path[Math.min(this.pathIndex, this.path.length - 1)];
      }
    }

    const d = norm2(aim[0] - feet[0], aim[2] - feet[2]);
    a.intent.move = [d[0] * speed, d[1] * speed];
    a.intent.face = null;
    this.watchForStuck(speed);
  }

  /** If we have been pushing for half a second and gone nowhere, repath, then give up. */
  watchForStuck(speed) {
    this.stuckTimer += this.dtLast;
    if (this.stuckTimer < 0.5) return;
    const f = this.actor.feet;
    const moved = Math.hypot(f[0] - this.stuckFrom[0], f[2] - this.stuckFrom[2]);
    if (moved < 0.12 * speed) {
      this.stuckCount++;
      this.path = null;
      this.repathTimer = 0;
    } else {
      this.stuckCount = 0;
    }
    this.stuckFrom = [...f];
    this.stuckTimer = 0;
  }

  stop() { this.actor.intent.move = [0, 0]; }

  faceTarget(target) {
    const a = this.actor.feet, t = target.feet;
    const d = norm2(t[0] - a[0], t[2] - a[2]);
    if (d[0] || d[1]) this.actor.intent.face = d;
  }

  // ---- the state machine -----------------------------------------------------------

  update(dt) {
    const a = this.actor;
    this.dtLast = dt;
    this.time += dt;
    this.timer += dt;
    if (a.dead) { this.state = 'dead'; return; }
    if (!this.enabled || !a.canAct()) { this.stop(); return; }

    // Hit by someone we have not noticed: turn on them straight away.
    if ((this.state === 'idle' || this.state === 'wander') && a.lastAttacker && !a.lastAttacker.dead
      && a.clock - a.lastDamagedAt < 0.2) {
      this.target = a.lastAttacker;
      this.noticed = true;
      this.alertAllies(this.target);
      this.setState('chase');
    }

    switch (this.state) {
      case 'idle': this.updateIdle(dt); break;
      case 'wander': this.updateWander(dt); break;
      case 'notice': this.updateNotice(dt); break;
      case 'chase': this.updateChase(dt); break;
      case 'attack': this.updateAttack(dt); break;
      case 'leash': this.updateLeash(dt); break;
      default: this.setState('idle');
    }
  }

  tryNotice(dt) {
    this.scanTimer -= dt;
    if (this.scanTimer > 0) return false;
    this.scanTimer = 0.25;
    const t = this.scan();
    if (!t) return false;
    this.target = t;
    this.noticed = false;
    this.setState('notice');
    return true;
  }

  updateIdle(dt) {
    this.stop();
    if (this.tryNotice(dt)) return;
    const [lo, hi] = this.cfg.wanderPause;
    if (this.cfg.canWander && this.cfg.wanderRadius > 0 && this.timer > this.pause) {
      this.pause = lo + Math.random() * (hi - lo);
      const nav = this.system.nav;
      for (let tries = 0; tries < 6; tries++) {
        const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.cfg.wanderRadius;
        const p = [this.home[0] + Math.cos(ang) * r, this.home[1], this.home[2] + Math.sin(ang) * r];
        if (!nav || nav.isWalkable(p[0], p[2])) { this.wanderTarget = p; this.setState('wander'); return; }
      }
      this.timer = 0;
    } else if (this.pause === undefined) {
      this.pause = lo + Math.random() * (hi - lo);
    }
  }

  updateWander(dt) {
    if (this.tryNotice(dt)) return;
    const f = this.actor.feet;
    if (!this.wanderTarget || Math.hypot(this.wanderTarget[0] - f[0], this.wanderTarget[2] - f[2]) < 0.45 || this.timer > 8 || this.stuckCount > 2) {
      this.setState('idle');
      return;
    }
    this.moveTo(this.wanderTarget, this.cfg.wanderSpeed);
  }

  updateNotice(dt) {
    const t = this.target;
    this.stop();
    const keep = this.alerted ? this.cfg.loseRadius : this.cfg.aggroRadius * 1.3;
    if (!t || t.dead || this.gap(t) > keep) { this.target = null; this.setState('idle'); return; }
    this.faceTarget(t);
    if (!this.noticed) {
      this.noticed = true;
      this.actor.emit('aggro', this.actor, t);
      if (this.system) this.system.bus.emit('aggro', this.actor, t);
      this.alertAllies(t);
    }
    if (this.timer >= this.cfg.noticeTime) this.setState('chase');
  }

  shouldLeash() {
    const t = this.target;
    if (!t || t.dead) return true;
    if (this.gap(t) > this.cfg.loseRadius) return true;
    return dist(this.actor.feet, this.home) > this.cfg.leashRadius;
  }

  inAttackRange() {
    const t = this.target;
    const ranged = !!this.cfg.attack.projectile;
    return this.gap(t) <= this.cfg.attackRange && (!ranged || this.hasLine(t));
  }

  updateChase() {
    if (this.shouldLeash()) { this.setState('leash'); return; }
    const t = this.target;
    if (this.inAttackRange()) { this.stop(); this.setState('attack'); return; }
    this.moveTo(t.feet, 1);
  }

  updateAttack() {
    const a = this.actor;
    const t = this.target;
    if (this.shouldLeash()) { this.setState('leash'); return; }
    if (this.gap(t) > this.cfg.attackRange * 1.35 || (this.cfg.attack.projectile && !this.hasLine(t))) { this.setState('chase'); return; }

    this.faceTarget(t);
    const pref = this.cfg.preferRange;
    if (pref && this.gap(t) < pref * 0.6 && !a.casting) {
      // Ranged units give ground rather than trading blows.
      const away = norm2(a.feet[0] - t.feet[0], a.feet[2] - t.feet[2]);
      a.intent.move = [away[0] * 0.8, away[1] * 0.8];
      a.intent.face = norm2(t.feet[0] - a.feet[0], t.feet[2] - a.feet[2]);
    } else {
      this.stop();
    }
    if (a.casting || a.cooldownRemaining(this.abilityId) > 0) return;
    const dir = norm2(t.feet[0] - a.feet[0], t.feet[2] - a.feet[2]);
    this.system.abilities.use(a, this.abilityId, { target: t, dir, point: t.feet });
  }

  updateLeash(dt) {
    const a = this.actor;
    a.lastAttacker = null;
    this.target = null;
    // Walking home restores health, so a monster cannot be kited to death.
    a.health = Math.min(a.maxHealth, a.health + a.maxHealth * 0.25 * dt);
    const f = a.feet;
    if (Math.hypot(this.home[0] - f[0], this.home[2] - f[2]) < 0.6 || this.stuckCount > 3 || this.timer > 15) {
      this.stop();
      a.health = a.maxHealth;
      this.setState('idle');
      return;
    }
    this.moveTo(this.home, 1);
  }
}
