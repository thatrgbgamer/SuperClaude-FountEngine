// Everything about fighting together that belongs to an instance rather than
// to a single actor: PvP rules and duels, scaling an encounter to the size of
// the group, resetting it when the group is wiped, death hooks, loot for
// several players and fitting a player to an area's power level.
//
// Hooks a game can define (all optional):
//   actorDied(instance, actor, killer)       any actor died (killer may be null)
//   pvpKill(instance, killer, victim)        a player killed another player outside a duel
//   duelEnded(instance, winner, loser, how)  how: 'yield' | 'left'
//   encounterReset(instance, actor)          a monster was reset after a wipe
//   scalePlayer(instance, player)            -> { hp, damageDealt, damageTaken, speed } | null: sidekicking
//
// NPC map entities opt in with keyvalues:
//   scales: true            health and damage follow the number of living players (config below)
//   resetOnWipe: true       goes back to full health and its post when every player has died
//
// Scaling tables (map `instance.scaling` or `server.scaling`), indexed by living players - 1:
//   { "hp": [1, 1.7, 2.4, 3.1, 3.8], "damage": [1, 1.1, 1.2, 1.3, 1.4] }

import { Pvp } from '../engine/pvp.js';

const DUEL_RANGE = 40;

export class Encounters {
  constructor(instance, options = {}) {
    this.instance = instance;
    const srv = instance.config.server || {};
    const block = (instance.doc && instance.doc.instance) || {};
    this.scaling = block.scaling || srv.scaling || null;
    this.sidekick = block.sidekick ?? null;
    this.pvp = new Pvp({
      mode: block.pvp || srv.pvp || 'off',
      sameParty: (a, b) => !!(a.player && b.player && a.player.partyId && a.player.partyId === b.player.partyId),
    });
    instance.actors.pvp = this.pvp;
    this.duelInvites = new Map();     // target player id -> { from, expires }
    this.wiped = false;
    this.lastScaleCount = -1;
    this.timer = 0;

    const combat = instance.actors.combat;
    // A duel ends short of death: the blow that would kill leaves the loser on one health.
    combat.modifiers.push((ev, source, target) => {
      if (!source || !target || this.pvp.opponentOf(target) !== source) return;
      if (target.health - ev.amount < 1) {
        ev.amount = Math.max(0, target.health - 1);
        ev.ignoreResist = true;
        this.endDuel(target, 'yield');
      }
    });
    instance.bus.on('death', (actor, cause) => this.onDeath(actor, cause));
  }

  // ---- PvP and duels ------------------------------------------------------------

  get mode() { return this.pvp.mode; }

  setFlag(player, on) {
    if (this.pvp.mode !== 'flagged') return false;
    this.pvp.setFlag(player.actor, on);
    player.actor.publicData.pvp = on ? 1 : undefined;
    if (!on) delete player.actor.publicData.pvp;
    return true;
  }

  requestDuel(from, to) {
    if (from === to || this.pvp.opponentOf(from.actor) || this.pvp.opponentOf(to.actor)) return 'busy';
    if (from.actor.dead || to.actor.dead) return 'dead';
    const a = from.actor.feet, b = to.actor.feet;
    if (Math.hypot(a[0] - b[0], a[2] - b[2]) > DUEL_RANGE) return 'far';
    this.duelInvites.set(to.id, { from: from.id, expires: Date.now() + 30000 });
    return 'sent';
  }

  acceptDuel(player) {
    const inv = this.duelInvites.get(player.id);
    this.duelInvites.delete(player.id);
    if (!inv || inv.expires < Date.now()) return null;
    const from = this.instance.players.find((p) => p.id === inv.from);
    if (!from || this.pvp.opponentOf(from.actor) || this.pvp.opponentOf(player.actor)) return null;
    this.pvp.duel(from.actor, player.actor);
    return from;
  }

  endDuel(loserActor, how) {
    const winner = this.pvp.opponentOf(loserActor);
    if (!winner) return;
    this.pvp.endDuel(loserActor);
    this.instance.gameData.callHook('duelEnded', this.instance, winner, loserActor, how);
    for (const a of [winner, loserActor]) if (a.player) a.player.notify('toast', { text: a === winner ? 'DUEL WON' : 'DUEL LOST', color: [1, 0.9, 0.4] });
  }

  playerLeft(player) {
    this.endDuel(player.actor, 'left');
    this.pvp.forget(player.actor);
    this.duelInvites.delete(player.id);
    for (const [k, v] of this.duelInvites) if (v.from === player.id) this.duelInvites.delete(k);
    player.actor.setScale('instance', null);
  }

  onDeath(actor, cause) {
    const killer = cause && cause.source ? cause.source : null;
    this.instance.gameData.callHook('actorDied', this.instance, actor, killer);
    if (actor.kind === 'player' && killer && killer.kind === 'player') {
      this.instance.gameData.callHook('pvpKill', this.instance, killer, actor);
    }
    if (actor.kind === 'player') this.pvp.endDuel(actor);
  }

  // ---- scaling, sidekicking and wipes ---------------------------------------------

  /** Called whenever the group changes and now and then: keeps scaled monsters and sidekicked players in step. */
  refresh() {
    const inst = this.instance;
    const living = inst.players.filter((p) => !p.actor.dead && p.disconnectedAt === null).length;
    const n = Math.max(1, living);
    if (this.scaling && n !== this.lastScaleCount) {
      this.lastScaleCount = n;
      const pick = (arr) => (Array.isArray(arr) ? arr[Math.min(n, arr.length) - 1] ?? 1 : 1);
      const mods = { hp: pick(this.scaling.hp), damageDealt: pick(this.scaling.damage) };
      for (const a of inst.actors.actors) if (a.entity && a.entity.kv && a.entity.kv.scales && !a.dead) a.setScale('group', mods);
    }
  }

  sidekickPlayer(player) {
    const mods = this.instance.gameData.callHook('scalePlayer', this.instance, player);
    player.actor.setScale('instance', mods && typeof mods === 'object' ? mods : null);
  }

  /** Every player is down: reset the monsters that asked for it, so the next attempt starts clean. */
  checkWipe() {
    const inst = this.instance;
    const present = inst.players.filter((p) => p.disconnectedAt === null);
    const wiped = present.length > 0 && present.every((p) => p.actor.dead);
    if (wiped && !this.wiped) {
      for (const a of inst.actors.actors) {
        const kv = a.entity && a.entity.kv;
        if (!kv || !kv.resetOnWipe || a.dead || !a.ai) continue;
        a.ai.threat.clear();
        a.ai.target = null;
        a.lastAttacker = null;
        a.health = a.maxHealth;
        a.ai.setState('leash');
        inst.gameData.callHook('encounterReset', inst, a);
      }
    }
    this.wiped = wiped;
  }

  update(dt) {
    this.timer += dt;
    if (this.timer < 0.5) return;
    this.timer = 0;
    this.refresh();
    this.checkWipe();
    const now = Date.now();
    for (const [k, v] of this.duelInvites) if (v.expires < now) this.duelInvites.delete(k);
    for (const p of this.instance.players) {
      const a = p.actor;
      if (a._pvpOffAt && a._pvpOffAt < now) { a._pvpOffAt = 0; this.setFlag(p, false); }
    }
  }

  // ---- loot ------------------------------------------------------------------------

  /**
   * Drop something for players to pick up. `entity` is an entity description ({ classname, origin, ...keyvalues }).
   * mode 'shared': one entity anyone may take. mode 'personal': one per recipient, each visible only to them,
   * so nobody else sees or steals it. Returns the entities.
   */
  dropLoot(entity, options = {}) {
    const world = this.instance.world;
    if (options.mode !== 'personal') return [world.spawn(entity)];
    const out = [];
    for (const r of options.recipients || []) {
      const e = world.spawn({ ...entity, name: entity.name ? `${entity.name}_${r.id}` : undefined });
      if (e && e.showOnlyTo) e.showOnlyTo([r.id]);
      if (e) out.push(e);
    }
    return out;
  }
}
