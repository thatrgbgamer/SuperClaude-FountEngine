// Paper-doll characters: one body, many pieces. A character is drawn as a stack
// of sprite layers (body, hair, armour, weapon) that all follow the body's
// animation, so a player's gear shows on them without a sprite for every
// combination. Layers are ordinary sprites; they only have to share animation
// names and frame counts with the body, which is a naming discipline, not a tool.
//
//   actor.setLayers([
//     { sprite: 'hair_long', palette: { h: '#c04020' } },    // palette swaps recolour a layer
//     { sprite: 'plate',     order: 'over' },
//     { sprite: 'cloak',     order: 'under' },                 // drawn behind the body
//   ]);
//
// Online, put the same list in actor.publicData.layers on the server and every client
// that can see the character builds the stack from it.

export class PaperDoll {
  constructor(library, body) {
    this.library = library;
    this.body = body;                // the body's SpriteInstance
    this.layers = [];                // { instance, order }
    this.key = '';
  }

  /** Replace the stack. Cheap to call every frame with the same list: it only rebuilds on a change. */
  set(list) {
    const key = JSON.stringify(list || []);
    if (key === this.key) return false;
    this.key = key;
    this.layers = [];
    for (const l of list || []) {
      if (!l || !this.library.has(l.sprite)) {
        if (l) this.library.warnOnce(`layer:${l.sprite}`, `paper doll: no sprite named "${l.sprite}"`);
        continue;
      }
      const name = l.palette ? this.library.variant(l.sprite, l.palette) : l.sprite;
      const instance = new (this.body.constructor)(this.library, name, { scale: this.body.scale });
      this.layers.push({ instance, order: l.order === 'under' ? 'under' : 'over', tint: l.tint || null });
    }
    return true;
  }

  /** Follow the body: same animation, same frame, same facing. A layer without that animation just holds its idle. */
  sync() {
    const b = this.body;
    for (const { instance: i } of this.layers) {
      if (b.animName && i.has(b.animName) && i.animName !== b.animName) i.play(b.animName, { restart: true });
      i.time = b.time;
      i.frame = b.frame;
      i.heading = b.heading;
      i.scale = b.scale;
      i.alpha = b.alpha;
      i._flash = b._flash;
      i._flashTotal = b._flashTotal;
    }
  }

  /** Draw the layers behind the body. Call before the body's own draw. */
  drawUnder(renderer, position, yaw, options = {}) { this.drawSide('under', renderer, position, yaw, options); }
  /** Draw the layers in front of the body. Call after the body's own draw. */
  drawOver(renderer, position, yaw, options = {}) { this.drawSide('over', renderer, position, yaw, options); }

  drawSide(order, renderer, position, yaw, options) {
    this.sync();
    let n = 0;
    for (const l of this.layers) {
      if (l.order !== order) continue;
      n++;
      // Layers share the body's plane, so nudge each toward the camera (or away, for 'under') to settle which is on top.
      const cp = renderer.camPos;
      let p = position;
      if (cp) {
        const dx = cp[0] - position[0], dy = cp[1] - position[1], dz = cp[2] - position[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        const k = (order === 'over' ? 1 : -1) * 0.006 * n / len;
        p = [position[0] + dx * k, position[1] + dy * k, position[2] + dz * k];
      }
      l.instance.draw(renderer, p, yaw, { ...options, tint: l.tint ? l.tint : options.tint });
    }
  }
}

/**
 * Bring an actor's look in line with its public data: `palette` (a swap map) recolours the body,
 * `layers` builds the paper-doll stack. Runs every frame on whatever draws actors, and only does work on a change.
 */
export function syncAppearance(actor, library) {
  const sprite = actor.sprite;
  if (!sprite) return;
  const pd = actor.publicData || {};
  const palKey = pd.palette ? JSON.stringify(pd.palette) : '';
  if (actor._palKey !== palKey) { actor._palKey = palKey; sprite.setPalette(pd.palette || null); }
  if (pd.layers && pd.layers.length) {
    if (!actor.paperdoll || actor.paperdoll.body !== sprite) actor.paperdoll = new PaperDoll(library, sprite);
    actor.paperdoll.set(pd.layers);
  } else if (actor.paperdoll) {
    actor.paperdoll = null;
  }
}
