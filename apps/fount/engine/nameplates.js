// Name plates, health bars and speech bubbles, drawn in the world over actors.
// The engine draws them, so a game does not have to: they come from what is
// already replicated (an actor's name, health, faction and `publicData`, where
// the server puts a chat bubble and the last emote).
//
//   game.nameplates.enabled = true
//   game.nameplates.options.maxDistance   metres; plates fade out toward it
//   game.nameplates.options.npcNames      show non-player names (default false: only damaged NPCs get a bar)
//   game.nameplates.colorFor = (actor, game) => [r, g, b]     override the name colour
//
// Everything is drawn with the same bitmap font as damage numbers.

const BAR_CHARS = 6;

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
    while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width); }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

export class NamePlates {
  constructor(game, options = {}) {
    this.game = game;
    this.enabled = true;
    this.options = { maxDistance: 32, npcNames: false, ownName: false, bars: true, bubbles: true, scale: 0.8, ...options };
    this.colorFor = null;
    this.emoteSeen = new Map();       // actor id -> last emote counter, so each emote fires once
  }

  defaultColor(actor) {
    const g = this.game;
    const me = g.player && g.player.actor;
    if (actor === me) return [0.85, 0.95, 1];
    if (g.parties && g.parties.has(actor.name)) return [0.5, 1, 0.55];
    if (actor.kind === 'player') return [1, 1, 1];
    if (me && actor.isHostile && actor.isHostile(me)) return [1, 0.45, 0.4];
    return [1, 0.9, 0.5];
  }

  /** Once per frame: raises an 'emote' event the first time each emote is seen, for a game to animate. */
  update() {
    const actors = this.game.actors ? this.game.actors.actors : [];
    for (const a of actors) {
      const e = a.publicData && a.publicData.emote;
      if (!e) { this.emoteSeen.delete(a.id); continue; }
      if (this.emoteSeen.get(a.id) !== e.n) {
        this.emoteSeen.set(a.id, e.n);
        this.game.events.emit('emote', { actor: a, id: e.id });
      }
    }
  }

  draw(renderer) {
    if (!this.enabled) return;
    const g = this.game;
    const me = g.player && g.player.actor;
    if (!me || !g.actors) return;
    this.update();
    const o = this.options;
    const step = 0.32 * o.scale;
    for (const a of g.actors.actors) {
      if (a.removed) continue;
      const dist = Math.hypot(a.feet[0] - me.feet[0], a.feet[2] - me.feet[2]);
      if (dist > o.maxDistance) continue;
      const fade = dist > o.maxDistance * 0.75 ? Math.max(0, (o.maxDistance - dist) / (o.maxDistance * 0.25)) : 1;
      const x = a.feet[0], z = a.feet[2];
      let y = a.feet[1] + a.height * (a.spriteScale || 1) + 0.15;

      const bubble = o.bubbles && a.publicData && a.publicData.bubble;
      if (bubble && !a.dead) {
        const lines = wrap(bubble.t, 22);
        let by = y + step * (lines.length + (o.bars ? 1.4 : 0.9));
        for (const line of lines) {
          renderer.drawText(line, [x, by, z], { scale: o.scale, color: [1, 1, 1], alpha: fade, outline: [0.05, 0.05, 0.1] });
          by -= step;
        }
      }
      if (a.dead) continue;

      if (o.bars && a.maxHealth > 0 && (a.kind === 'player' || a.health < a.maxHealth)) {
        const frac = Math.max(0, Math.min(1, a.health / a.maxHealth));
        const full = Math.round(frac * BAR_CHARS);
        renderer.drawText('='.repeat(BAR_CHARS), [x, y, z], { scale: o.scale, color: [0.25, 0.05, 0.05], alpha: fade });
        if (full) {
          renderer.drawText('='.repeat(full), [x - (BAR_CHARS - full) * 0.5 * 6 * o.scale / 16, y + 0.001, z],
            { scale: o.scale, color: frac > 0.35 ? [0.3, 0.9, 0.35] : [0.95, 0.3, 0.25], alpha: fade });
        }
        y += step;
      }
      const named = a.kind === 'player' ? (a !== me || o.ownName) : o.npcNames;
      if (named && a.name) {
        const color = (this.colorFor ? this.colorFor(a, g) : null) || this.defaultColor(a);
        renderer.drawText(a.name, [x, y, z], { scale: o.scale, color, alpha: fade, outline: [0, 0, 0] });
      }
    }
  }
}
