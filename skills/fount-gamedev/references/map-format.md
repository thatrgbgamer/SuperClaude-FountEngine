# Fount map format

A map is one JSON document in `apps/fount/game/maps/<name>.json`. Nothing is compiled — the engine reads this file directly, so editing it and refreshing the browser is the whole iteration loop.

## Contents

- [Top-level shape](#top-level-shape)
- [Coordinate system](#coordinate-system)
- [Brushes](#brushes)
- [Materials](#materials)
- [Engine config blocks](#engine-config-blocks)
- [Sky and lighting](#sky-and-lighting)
- [Entities](#entities)
- [Scale reference](#scale-reference)

## Top-level shape

```json
{
  "name": "dm_example",
  "sky": { "color": [0.3, 0.38, 0.5], "sunDir": [-0.45, -0.78, -0.42],
           "sunColor": [1.05, 0.97, 0.84], "ambient": [0.26, 0.29, 0.36],
           "fogColor": [0.3, 0.38, 0.5], "fogDensity": 0.011 },
  "materials": [],
  "brushes": [],
  "entities": [],
  "player": { "maxHealth": 100, "ammo": 120, "maxSpeed": 7.2, "jumpSpeed": 7.4 }
}
```

`materials` may be omitted entirely to use the built-in set. `player` is optional and overrides player tuning for this map.

## Coordinate system

- **Y is up.** X/Z are the horizontal plane. 1 unit = 1 metre.
- `angles` are `[pitch, yaw, roll]` in degrees. Yaw 0 faces +X; yaw 90 faces -Z.
- Colours are `[r, g, b]` floats, normally 0–1. Values above 1 are allowed for lights and read as overbright.

## Brushes

Every brush is a convex volume. Author the friendly shapes below; the engine lowers all of them to intersecting planes, which is what both the renderer and the collision tracer consume.

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | `box` (default), `ramp`, `wedge`, `cylinder`, `planes` |
| `min`, `max` | all but `planes` | Opposite corners of the axis-aligned bounds. `min` must be componentwise smaller than `max`. |
| `material` | all | Material name; defaults to the first material |
| `tint` | all | `[r,g,b]` multiplier over the material colour |
| `uvScale` | all | Texture repeat rate; default `0.5`. Lower = larger texels |
| `nonSolid` | all | Renders but does not collide (decoration) |
| `invisible` | all | Collides but does not render (clip brushes) |
| `trigger` | all | Neither renders nor collides; defines a volume a `trigger_multiple` reads. Requires `name` |
| `name` | trigger brushes | Links the volume to the entity of the same name |
| `axis`, `dir`, `low` | `ramp` | Horizontal axis the slope climbs (`"x"`/`"z"`), direction (`1`/`-1`), and the starting height |
| `corner` | `wedge` | Which corner is cut: `nx-nz`, `px-nz`, `nx-pz`, `px-pz` |
| `sides` | `cylinder` | Side count; default `8`. 10–12 looks round, costs little |
| `planes` | `planes` | Raw halfspaces as `[nx, ny, nz, dist]`, normals pointing **outward**, solid where `dot(n,p) - dist <= 0` |

### Ramps

`dir` sets which end is high, and it is the single easiest thing to get backwards. With `axis: "z"`, `dir: 1`, `min: [0,0,4]`, `max: [4,3,8]`: the ramp is at height `low` at `z=4` and rises to `max[1]` (3) at `z=8`. With `dir: -1` it is high at `z=4` instead.

A ramp whose high end does not meet the thing it leads to leaves a step the player has to jump. Match `max[1]` to the target platform's top surface.

### Worked example: a room with a ramp to a ledge

```json
{ "type": "box", "min": [-10, -1, -10], "max": [10, 0, 10], "material": "floor_tile" },
{ "type": "box", "min": [-11, 0, -11], "max": [11, 6, -10], "material": "concrete" },
{ "type": "box", "min": [4, 0, -10], "max": [10, 3, -4], "material": "concrete" },
{ "type": "ramp", "min": [4, 0, -4], "max": [10, 3, 0], "axis": "z", "dir": -1, "low": 0, "material": "metal" }
```

The ledge top is `y=3`; the ramp's `max[1]` is also 3 and its high end (`dir: -1` → low z) sits against the ledge at `z=-4`. They meet flush.

## Materials

Omit `materials` to use the built-in set: `concrete`, `floor_tile`, `brick`, `metal`, `grass`, `panel`, `grid`, `light_panel`, `flesh`, `cloth`.

Custom materials are generated procedurally at load — there are no image files anywhere in this engine.

```json
{ "name": "rust", "generator": "noise", "color": [0.45, 0.24, 0.16], "contrast": 0.22, "scale": 7, "seed": 42 }
```

| Generator | Notable parameters |
|---|---|
| `solid` | `color`, `emissive` |
| `noise` | `scale`, `contrast`, `seed` |
| `checker` | `scale`, `contrast` |
| `grid` | `scale`, `lineWidth`, `lineDarkness`, `contrast` |
| `brick` | `rows`, `cols`, `mortar`, `mortarDarkness`, `seed` |
| `tiles` | `scale`, `gap`, `gapDarkness`, `seed` |
| `metal` | `scale`, `plates`, `seed` |
| `grass` | `scale`, `seed` |
| `panel` | `scale`, `border`, `seed` |

`emissive: true` makes a material ignore lighting — use it for light fixtures, screens, lava. (Older builds declared this flag but ignored it; it now works per material.)

Two more generators animate seamlessly, looping their `phase`: `lava` (dark crust with hot cracks; `scale`, `seed`, `drift`; use a `color` like `[1, 0.45, 0.1]`) and `water` (`scale`, `seed`).

| Material key | Meaning |
|---|---|
| `size` | Texture resolution in pixels (16, 32, 64...). Default is the map's `render.textureSize`, else 256. Small sizes give chunky pixel textures |
| `frames`, `fps` | An animated material: `frames` images (max 16) played at `fps` (default 4). `lava` and `water` advance smoothly; other generators reseed per frame, which reads as flicker (good for torches and runes) |
| `emissive` | Ignore lighting |

Up to 64 materials can animate or glow. Texture filtering is `nearest` whenever the map has a `render.resolution`, so close textures never blur; see `rpg.md` for the `render` block. Brushes tile a texture by world size (`uvScale`, default 0.5 is one repeat per 2 m), so for pixel art choose `uvScale` so a texel lands on about one screen pixel.

## Engine config blocks

A map can also carry blocks that configure the engine rather than describe geometry: `mode`, `camera`, `render`, `player`, `nav`, `sprites`, `spriteDefs`, `abilities`, `statuses`, `particles`, `relations`. They are optional (a map with none is the classic first-person game), and the same blocks can live game-wide in a file loaded with `game.loadConfig()`. Their keys are in `rpg.md`; sprites are in `sprites-and-audio.md`.

```json
{ "mode": "topdown",
  "camera": { "pitch": 58, "yaw": 45, "ortho": true, "pixelsPerUnit": 16 },
  "render": { "resolution": [480, 270], "palette": ["#000000", "#1d2b53", "#7e2553"], "textureSize": 32 } }
```

**If you define `materials` at all, you replace the built-in list entirely.** Any brush referencing a name you did not define falls back to layer 0.

## Sky and lighting

| Field | Meaning |
|---|---|
| `color` | Background colour where no geometry is visible |
| `sunDir` | Direction the sunlight travels; keep `y` negative so it points down |
| `sunColor` | Directional light colour; drives the shadow-casting light |
| `ambient` | Flat fill light. Below ~0.2 leaves undersides and interiors nearly black |
| `fogColor`, `fogDensity` | Distance fade. `0.01` is mild, `0.05` is thick |

There is one shadow-casting directional light per map. Everything else is a `light` entity (point light, max 16 active at once, no shadows).

Interiors and the undersides of catwalks are lit by `ambient` alone. If a space reads as pure black, either raise `ambient` or put a `light` entity in it — that is the intended fix, not a bug.

## Entities

See `entities.md` for every classname, its keyvalues, and its inputs/outputs.

```json
{ "classname": "npc_grunt", "name": "guard_1", "origin": [4, 0.1, -2],
  "angles": [0, 180, 0], "health": 40,
  "connections": [ { "output": "OnDeath", "target": "gate", "input": "Open", "delay": 0.5 } ] }
```

Common to all entities: `classname` (required), `name` (needed only if something targets it), `origin`, `angles`, `enabled`, `connections`.

## Scale reference

Use these so spaces feel right the first time:

| Thing | Size |
|---|---|
| Player capsule | 0.7 wide, 1.8 tall |
| Player eye height | ~1.6 |
| Max step the player walks up | 0.55 |
| Comfortable jump height | ~1.2 |
| Doorway | 1.2 wide, 2.2 tall minimum |
| Corridor | 2–3 wide |
| Room ceiling | 3–5 |
| Open arena | 30–50 across |

Set an `info_player_start` `origin` on the floor surface (e.g. `y: 0.2` for a floor whose top is `y: 0`); the engine raises the player to standing height itself. A spawn buried in geometry is reported in the HUD and lifted to free space, but fix the map rather than relying on that.
