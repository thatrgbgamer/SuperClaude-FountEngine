// Abilities as data. An ability is a JSON object: a cooldown, a cost, an
// optional cast time, how it is aimed, and a list of effects (the same combat
// primitives statuses and map entities use). A hotbar slot just names one.
//
//   {
//     "id": "fireball", "name": "Fireball", "icon": "icon_fire",
//     "cooldown": 3, "cost": { "mana": 12 }, "castTime": 0.45,
//     "range": 14, "targeting": "direction",        // self | target | ground | direction
//     "anim": "cast", "sound": "cast",
//     "effects": [{ "type": "projectile", "speed": 12, "sprite": "fx_orb",
//                   "damage": { "type": "fire", "amount": [18, 26] } }]
//   }

import { dist } from './math.js';

const norm2 = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-6 ? [v[0] / l, v[1] / l] : null;
};

export class AbilitySystem {
  /** `defs` may be a Map shared across maps, so abilities are defined once per game, not once per level. */
  constructor(system, defs = null) {
    this.system = system;
    this.defs = defs || new Map();
  }

  /** Register one ability: define(id, def), define(def), define([defs]) or define({ id: def, ... }). */
  define(idOrTable, def) {
    if (typeof idOrTable === 'string') { this._set(idOrTable, def); return; }
    if (Array.isArray(idOrTable)) { for (const d of idOrTable) this._set(d.id, d); return; }
    if (idOrTable && typeof idOrTable.id === 'string') { this._set(idOrTable.id, idOrTable); return; }
    for (const [id, d] of Object.entries(idOrTable || {})) this._set(id, d);
  }

  _set(id, def) {
    if (!id) throw new Error('An ability needs an "id".');
    this.defs.set(id, {
      name: id, cooldown: 0, cost: {}, castTime: 0, recovery: 0, range: 2, targeting: 'direction',
      effects: [], ...def, id,
    });
  }

  get(id) { return this.defs.get(id) || null; }
  has(id) { return this.defs.has(id); }

  /**
   * Try to use an ability. `aim` is { dir: [x, z], point: [x, y, z], target: Actor }, whatever
   * the caller has: a player's cursor, an AI's target. Returns { ok, reason }.
   * Reasons: unknown, cannot-act, busy, cooldown, resource, no-target, range, not-hostile.
   */
  use(actor, id, aim = {}) {
    const def = this.defs.get(id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (!actor.canAct()) return { ok: false, reason: 'cannot-act' };
    if (actor.hasFlag('silence') && !def.ignoreSilence) return { ok: false, reason: 'cannot-act' };
    if (actor.casting || actor.clock < actor.busyUntil) return { ok: false, reason: 'busy' };
    if (actor.cooldownRemaining(id) > 0) return { ok: false, reason: 'cooldown' };
    if (!actor.canAfford(def.cost)) return { ok: false, reason: 'resource' };

    const feet = actor.feet;
    let target = aim.target || null;
    let point = aim.point ? [...aim.point] : null;
    let dir = aim.dir ? norm2(aim.dir) : null;

    switch (def.targeting) {
      case 'self':
        target = actor; point = feet; dir = dir || actor.facing;
        break;
      case 'target': {
        if (!target || target.dead) return { ok: false, reason: 'no-target' };
        if (def.hostile && !actor.isHostile(target)) return { ok: false, reason: 'not-hostile' };
        if (def.friendly && actor.isHostile(target)) return { ok: false, reason: 'not-hostile' };
        const d = Math.hypot(target.feet[0] - feet[0], target.feet[2] - feet[2]) - target.radius - actor.radius;
        if (d > def.range) return { ok: false, reason: 'range' };
        point = target.feet;
        dir = norm2([target.feet[0] - feet[0], target.feet[2] - feet[2]]) || actor.facing;
        break;
      }
      case 'ground': {
        if (!point) return { ok: false, reason: 'no-target' };
        const dx = point[0] - feet[0], dz = point[2] - feet[2];
        const d = Math.hypot(dx, dz);
        // Aiming past the maximum range casts at the limit rather than failing:
        // that is what a cursor dragged off the edge of reach should do.
        if (d > def.range) { point[0] = feet[0] + (dx / d) * def.range; point[2] = feet[2] + (dz / d) * def.range; }
        dir = norm2([dx, dz]) || actor.facing;
        break;
      }
      default: { // direction
        dir = dir || (point ? norm2([point[0] - feet[0], point[2] - feet[2]]) : null) || actor.facing;
        point = [feet[0] + dir[0] * def.range, feet[1], feet[2] + dir[1] * def.range];
      }
    }

    actor.intent.face = dir;
    actor.facing = dir;
    actor.casting = { def, t: 0, total: def.castTime, aim: { dir, point, target } };
    const anim = def.anim || (def.castTime > 0 ? 'cast' : 'attack');
    actor.playAction(anim);
    this.system.bus.emit('cast-start', actor, def);
    actor.emit('cast-start', actor, def);

    if (def.castTime <= 0) this.finishCast(actor);
    return { ok: true, reason: null };
  }

  /** Called by the actor when its cast bar fills (or immediately for instant abilities). */
  finishCast(actor) {
    const cast = actor.casting;
    if (!cast) return;
    const { def, aim } = cast;
    actor.casting = null;

    // The target may have died, or run, while we were winding up.
    if (def.targeting === 'target') {
      if (!aim.target || aim.target.dead) { this.system.bus.emit('cast-cancel', actor, def, 'lost-target'); return; }
      const d = dist(actor.feet, aim.target.feet) - aim.target.radius - actor.radius;
      if (d > def.range * 1.3) { this.system.bus.emit('cast-cancel', actor, def, 'range'); return; }
    }
    if (!actor.canAfford(def.cost)) { this.system.bus.emit('cast-cancel', actor, def, 'resource'); return; }

    actor.spend(def.cost);
    if (def.cooldown > 0) actor.cooldowns[def.id] = def.cooldown * actor.statMult('cooldown');
    actor.busyUntil = actor.clock + (def.recovery || 0);

    if (def.sound) this.system.combat.sound(def.sound, actor.feet);
    this.system.combat.run(def.effects, {
      source: actor, ability: def, aim,
      target: aim.target || null,
      point: def.targeting === 'target' && aim.target ? aim.target.chest : aim.point,
    });
    this.system.bus.emit('ability', actor, def, aim);
    actor.emit('ability', actor, def, aim);
  }

  /** 0 when ready, up to 1 right after use: what a hotbar's cooldown sweep draws. */
  cooldownFraction(actor, id) {
    const def = this.defs.get(id);
    if (!def || !(def.cooldown > 0)) return 0;
    return Math.min(1, actor.cooldownRemaining(id) / def.cooldown);
  }

  /** Whether `actor` could use `id` right now, ignoring aim: for greying out hotbar slots. */
  isReady(actor, id) {
    const def = this.defs.get(id);
    return !!def && actor.canAct() && !actor.hasFlag('silence') && actor.cooldownRemaining(id) <= 0 && actor.canAfford(def.cost);
  }
}
