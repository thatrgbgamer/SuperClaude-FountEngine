// Decals: marks stamped on the ground. Scorch under a fireball, blood where a
// monster fell, footprints in snow. Each is one sprite frame laid flat and
// aligned to the world, drawn with the same pixel-art sprite pipeline as
// everything else, so they pixelate, light and fog like the rest of the scene.
//
//   game.decals.add('splat', [x, y, z], { size: 1.2, life: 30, fade: 5, tint: [0.6, 0, 0] })
//   game.decals.clear()
//
// `sprite` is any registered sprite (its first frame of `anim`, default idle); `size` is its width in
// metres. Decals past `max` (default 300) replace the oldest. They fade out over the last `fade` seconds
// by shrinking and darkening: sprite alpha is a cut-out, not a blend, so a smooth fade would pop.

export class Decals {
  constructor(sprites, options = {}) {
    this.sprites = sprites;
    this.max = options.max ?? 300;
    this.items = [];
    this.lift = options.lift ?? 0.02;       // above the surface, so it never fights the floor
  }

  add(spriteName, pos, options = {}) {
    const sprite = this.sprites.get(spriteName);
    if (!sprite) { this.sprites.warnOnce(`decal:${spriteName}`, `decal: no sprite named "${spriteName}"`); return null; }
    const anim = sprite.anims[options.anim || 'idle'] || Object.values(sprite.anims)[0];
    if (!anim) return null;
    const dir = anim.dirNames[0];
    const ids = anim.ids[dir];
    const d = {
      sprite, frame: ids[(options.frame ?? 0) % ids.length],
      pos: [pos[0], pos[1] + this.lift, pos[2]],
      scale: options.size ? options.size / (sprite.w / sprite.ppu) : (options.scale ?? 1),
      tint: options.tint || [1, 1, 1],
      life: options.life ?? 20, age: 0, fade: options.fade ?? 4,
    };
    this.items.push(d);
    if (this.items.length > this.max) this.items.shift();
    return d;
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i];
      d.age += dt;
      if (d.age >= d.life) this.items.splice(i, 1);
    }
  }

  draw(renderer) {
    for (const d of this.items) {
      const left = d.life - d.age;
      const k = left < d.fade ? Math.max(0, left / d.fade) : 1;
      renderer.drawSpriteFrame(d.frame, d.pos, {
        sprite: d.sprite, scale: d.scale * (0.6 + 0.4 * k), tint: [d.tint[0] * k, d.tint[1] * k, d.tint[2] * k], alpha: 1, tilt: -1,
      });
    }
  }

  clear() { this.items.length = 0; }
}
