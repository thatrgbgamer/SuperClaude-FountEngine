// Who may hurt whom when both are players.
//
// NPC hostility is the faction table (combat.js Relations). Players share a
// faction, so by default they are friends. This adds the rules for when they
// are not, decided per map:
//
//   off       players never hurt each other (the default)
//   free      any two players are hostile, except party members
//   flagged   hostile only if both have switched their PvP flag on
//   teams     hostile if their `team` differs (actor.data.team), whatever the flags
//
// A duel overrides all of that between its two players, party or not. Neutral
// ground rules (the map's mode) are set by whoever owns the instance; the game
// decides what a kill costs through its own hooks.

export class Pvp {
  /** options: { mode: 'off', sameParty: (a, b) => boolean } */
  constructor(options = {}) {
    this.mode = options.mode || 'off';
    this.sameParty = options.sameParty || (() => false);
    this.flags = new Set();          // actors with their flag on
    this.duels = new Map();          // actor -> opponent
  }

  setFlag(actor, on) { if (on) this.flags.add(actor); else this.flags.delete(actor); }
  flagged(actor) { return this.flags.has(actor); }

  duel(a, b) { this.duels.set(a, b); this.duels.set(b, a); }
  endDuel(a) {
    const b = this.duels.get(a);
    this.duels.delete(a);
    if (b) this.duels.delete(b);
    return b || null;
  }
  opponentOf(a) { return this.duels.get(a) || null; }

  forget(actor) { this.flags.delete(actor); this.endDuel(actor); }

  /** Whether player actors a and b are hostile to each other. */
  hostile(a, b) {
    if (a === b) return false;
    if (this.duels.get(a) === b) return true;
    if (this.duels.has(a) || this.duels.has(b)) return false;        // someone in a duel is not fair game for others
    if (this.mode === 'off') return false;
    if (this.sameParty(a, b)) return false;
    if (this.mode === 'free') return true;
    if (this.mode === 'flagged') return this.flags.has(a) && this.flags.has(b);
    if (this.mode === 'teams') return (a.data.team ?? null) !== (b.data.team ?? null);
    return false;
  }
}
