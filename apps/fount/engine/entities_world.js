// World entities that follow the world clock.
//
// func_water  a volume of water with a surface that rises and falls with the tide.
//   min, max       the volume (the surface sits at max[1] at mid tide)
//   tide           { amplitude: 0.4, period: seconds, phase: 0..1 }  amplitude 0 = still water
//   slow           speed multiplier for anything wading (default 0.6)
//   material       the surface material (default 'water'; give it `scroll: [0.05, 0.02]` to make it flow)
//   Outputs: OnEnter, OnExit (an actor stepped into / left the water)
//
// The server owns the level (a pure function of world time, so every player agrees) and applies
// the slowdown; clients only draw the surface where the server says it is.

import { defineEntity } from './entity.js';

const layerOf = (world, name, fallback) => world.context.materialIndex.get(name) ?? fallback;

function levelAt(entity, time) {
  const s = entity.state;
  const t = entity.get('tide', null);
  if (!t || !(t.amplitude > 0)) return s.base;
  const period = t.period || 240;
  return s.base + t.amplitude * Math.cos(((time / period) + (t.phase || 0)) * Math.PI * 2);
}

defineEntity('func_water', {
  server: {
    spawn(entity) {
      const s = entity.state;
      s.min = entity.get('min', [0, 0, 0]);
      s.max = entity.get('max', [1, 1, 1]);
      s.base = s.max[1];
      s.level = s.base;
      s.slow = entity.get('slow', 0.6);
      s.inside = new Set();
    },
    think(entity, world) {
      const s = entity.state;
      const ctx = world.context;
      const time = ctx.worldTime ? ctx.worldTime() : 0;
      s.level = Math.round(levelAt(entity, time) * 100) / 100;
      const key = `water:${entity.id ?? entity.name}`;
      const system = ctx.actors;
      const now = new Set();
      if (system) {
        for (const a of system.actors) {
          if (a.dead) continue;
          const f = a.feet;
          const inXZ = f[0] > s.min[0] && f[0] < s.max[0] && f[2] > s.min[2] && f[2] < s.max[2];
          if (inXZ && f[1] < s.level && f[1] + a.height > s.min[1]) {
            now.add(a);
            if (!s.inside.has(a)) { a.setScale(key, { speed: s.slow }); world.fireOutput(entity, 'OnEnter', a.entity || null); }
          }
        }
        for (const a of s.inside) {
          if (!now.has(a)) { a.setScale(key, null); world.fireOutput(entity, 'OnExit', a.entity || null); }
        }
      }
      s.inside = now;
    },
    replicate(entity) { return { level: entity.state.level }; },
  },

  client: {
    spawn(entity, world) {
      const s = entity.state;
      s.layer = layerOf(world, entity.get('material', 'water'), 0);
      s.uvScale = entity.get('uvScale', 0.5);
      s.min = s.min || entity.get('min', [0, 0, 0]);
      s.max = s.max || entity.get('max', [1, 1, 1]);
      s.level = s.level ?? s.max[1];
    },
    apply(entity, state) { if (state && state.level !== undefined) entity.state.level = state.level; },
    draw(entity, renderer, shadowPass) {
      if (shadowPass) return;
      const s = entity.state;
      const top = Math.max(s.level, s.min[1] + 0.02);
      renderer.drawBrushBox(s.min, [s.max[0], top, s.max[2]], s.layer, entity.get('tint', [0.8, 0.9, 1]), s.uvScale, false);
    },
  },
});
