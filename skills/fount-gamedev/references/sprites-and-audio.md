# Sprites, particles, text and sound

Like everything else in Fount, sprites, fonts and effects are **text**: no PNGs, no audio files. A sprite is a JSON document whose frames are rows of characters indexing a palette.

## Contents

- [The sprite format](#the-sprite-format)
- [Facings and mirroring](#facings-and-mirroring)
- [Animations and events](#animations-and-events)
- [Using sprites from code](#using-sprites-from-code)
- [How sprites are drawn](#how-sprites-are-drawn)
- [Built-in effect sprites](#built-in-effect-sprites)
- [Particles](#particles)
- [Floating text and the bitmap font](#floating-text-and-the-bitmap-font)
- [Text in your own HTML UI](#text-in-your-own-html-ui)
- [Sound presets](#sound-presets)

## The sprite format

```json
{
  "name": "fire_imp",
  "size": [12, 16],
  "anchor": [6, 16],
  "ppu": 16,
  "palette": { ".": null, "k": "#1a0d0d", "o": "#f07020", "y": "#ffd040" },
  "animations": {
    "idle":   { "fps": 4, "dirs": 4, "frames": { "S": [["....kk....", "..."], ["..."]], "E": [["..."]], "N": [["..."]] } },
    "walk":   { "fps": 8, "dirs": 4, "frames": { "S": [["..."]], "E": [["..."]], "N": [["..."]] } },
    "attack": { "fps": 12, "loop": false, "dirs": 1, "events": { "2": "hit" }, "frames": [["..."], ["..."], ["..."]] },
    "death":  { "fps": 5, "loop": false, "dirs": 1, "frames": [["..."], ["..."]] }
  }
}
```

| Field | Meaning |
|---|---|
| `size` | `[width, height]` in sprite pixels. Every frame must match it exactly |
| `anchor` | The point on the sprite that sits at the entity's position, in pixels from the top-left. Default `[width / 2, height]`: bottom centre, so the sprite stands on the ground. It is a *point*, not a pixel: for a 24-tall sprite, `[12, 24]` puts the feet on the ground |
| `ppu` | Sprite pixels per world metre (default 16). A 24px sprite is 1.5 m tall. Match it to the camera's `pixelsPerUnit` so a sprite pixel is one screen pixel |
| `palette` | Single character to `"#rgb"`, `"#rrggbb"`, `"#rrggbbaa"`, or `null` for transparent. `.` is transparent unless redefined |
| `animations` | Name to animation. `idle`, `walk`, `attack`, `hurt`, `death` are the names the engine itself plays |
| `autoMirror` | Default true; see below |

A frame is an array of row strings (one per pixel row), or a single string with rows separated by `/`: `"..kk../.kkkk."`. Alpha is a cut-out, never a blend, so edges stay hard.

Invalid sprites fail loudly at load, listing every problem at once (wrong row width, unknown palette character, missing facing, event on a frame that does not exist), and a half-parsed sprite leaves nothing behind.

## Facings and mirroring

`dirs` is `1`, `4` (`S E N W`) or `8` (`S SE E NE N NW W SW`). With one facing, `frames` may be a plain list. **S faces the camera, E is screen-right, N faces away**, whatever the camera's yaw: facing is chosen from the actor's heading *as seen from the camera*, so rotating the camera in 45 degree steps turns every sprite to match.

You only need to draw one side. A missing `W` is drawn as `E` flipped, a missing `SW` as `SE`, and so on (`"autoMirror": false` turns that off). To be explicit, write `"W": "mirror:E"`. Mirrored facings share the source's pixels and keep the anchor on the same world point.

## Animations and events

| Field | Meaning |
|---|---|
| `fps` | Frames per second (default 8) |
| `loop` | Default true |
| `dirs`, `frames` | As above. Every facing needs the same number of frames |
| `events` | `{ "frameIndex": "name" }` (or a list of names). The engine reports each event as the animation passes that frame, even across a long step. This is how an attack's hit frame lines up with its swing |
| `next` | What plays when a one-shot ends. Default `idle`; `death` and anything with `"hold": true` stay on their last frame; `null` also holds |

## Using sprites from code

Register sprites by listing them in the config (`"sprites": [...]`, URLs or inline, see `rpg.md`), or directly: `game.sprites.register(def)` / `registerAll([defs])`.

An actor with a `sprite` plays `idle` and `walk` on its own, `hurt` when hit, `death` when it dies, and the ability's animation when it acts. Behaviours that animate their own things use a `SpriteInstance`:

```js
import { SpriteInstance } from '../../engine/sprites.js';

const s = new SpriteInstance(world.context.sprites, 'fire_imp', { scale: 1 });
s.play('attack');                          // no-op if it is already playing; { restart: true } to force
s.onEvent = (name) => { if (name === 'hit') doDamage(); };
s.onFinish = (anim) => {};                 // a one-shot ended
s.setHeading(dx, dz);                      // which way it faces, in world XZ
s.flash(0.12);                             // white hit flash
s.tint = [1, 0.7, 0.7]; s.alpha = 0.5;     // alpha fades by dithering, never a blend
s.update(dt);                              // in think()
s.draw(renderer, position, world.context.game.cameraYaw);   // in draw()
```

`play()` with an animation the sprite does not have warns once and does nothing. For a one-off draw with no instance: `renderer.drawSprite(name, anim, frameIndex, position, scale, tint, shadowPass, { dir, flash, alpha, overlay })`. Sprites do not cast into the shadow map (`shadowPass` returns immediately); draw a ground shadow with `renderer.drawBlobShadow(position, radius, alpha)`, a dithered dark disc that actors and `prop_sprite` use.

## How sprites are drawn

They are camera-facing quads that keep their feet on the ground (cylindrical billboards), queued during the frame and drawn in one call at the end. They receive the map's fog, point lights and the sun's shadow at their feet. The camera's `spriteTilt` leans them toward the view plane: `0` stays perfectly upright, which looks squashed under a steep camera; around `0.5` is a good three-quarter compromise, `1` faces the view fully.

## Built-in effect sprites

Always available, white or greyscale so a tint colours them: `fx_px` (1px), `fx_spark`, `fx_glow`, `fx_smoke`, `fx_fire`, `fx_orb`, `fx_heal`, `fx_exclaim` (the "!" over an alerted monster). Register a sprite with the same name to replace one.

## Particles

Presets are data. Built in: `spark`, `hit`, `smoke`, `fire`, `ember`, `heal`, `magic`, `explosion`, `dust`, `portal`, `notice`. Add or replace with the `particles` config key or `game.particles.define(name, def)`:

```json
{ "sprite": "fx_spark", "anim": "idle", "frames": "life",
  "count": 8, "life": [0.25, 0.5], "speed": [2, 5], "up": [1, 3],
  "gravity": 12, "drag": 0, "radius": 0.1,
  "size": [1, 0.4], "tint": [[1, 0.9, 0.4], [1, 0.3, 0.1]], "alpha": [1, 0] }
```

`speed` is horizontal (in a random direction), `up` vertical, both a number or `[min, max]`; `gravity` is downward, so a negative value rises. `frames` is `life` (step through the animation over the particle's life), `loop`, or `random`. `size`, `tint` and `alpha` run from the first value to the second over a particle's life; fading is dithered.

Trigger them from effects (`{ "type": "particles", "preset": "explosion", "at": "point" }`), from `env_particles` and `func_hazard` entities, or from code:

```js
game.particles.burst('spark', [x, y, z], { count: 12, scale: 1.5, tint: [1, 0.4, 0.4] });
const e = game.particles.emitter('smoke', () => actor.chest, { rate: 10, duration: 4 });   // position may be a function
e.stop();
```

Particles step at the engine's fixed rate and draw through the same batch as characters, so a thousand sparks are one draw call. The cap is 2500.

## Floating text and the bitmap font

The built-in font is 5x7, defined as text in `engine/font.js`. It is upper-case only (lower-case letters draw as capitals) and covers digits and common punctuation. A game can define a full font in the same format (`{ name, size: [w, h], advance, lineHeight, glyphs: { "A": ".###./#...#/..." } }`) and register it with `game.sprites.registerFont(new BitmapFont(def))`.

```js
game.floatText.spawn('128', [x, y, z], { color: [1, 0.8, 0.3], crit: false, scale: 1, life: 0.85, rise: 1.5, outline: [0, 0, 0] });
renderer.drawText('LEVEL UP', position, { scale: 1, color: [1, 1, 0.4], align: 'center', outline: [0, 0, 0], overlay: true });
```

Damage and heal numbers are spawned automatically from the `damage` and `heal` events, coloured by damage type (`game.damageColors`), larger and popped for crits. World text faces the camera and draws over geometry by default so a wall never hides a number (`overlay: false` to depth-test it).

## Text in your own HTML UI

```js
import { registerFountText, pixelText, drawPixelText } from './engine/ui.js';
registerFountText();                      // once
```

```html
<fount-text text="HP 100/100" scale="3" color="#ffd040" outline="#000"></fount-text>
```

Changing the `text` attribute re-renders it. `pixelText('GOLD 50', { scale: 2 })` returns a `<canvas>` for building DOM from code. This is a crisp-pixel canvas, not a webfont: a generated font file would be exactly the kind of opaque binary this engine avoids, and for pixel-art labels the picture is identical. It is not selectable, and a real `<input>` still needs a CSS font.

## Sound presets

All sound is synthesised from named presets; `"sound": "name"` in an ability, effect or entity plays one. An unknown name warns once instead of staying silent.

`shoot shotgun impact hurt die step land jump explosion pickup door button ragdoll` (first-person set) and, for RPGs: `swing hit crit cast heal portal click enemyhurt enemydie error levelup`.

The engine plays `swing` on melee, `hit` / `crit` / `hurt` on damage, `heal`, `enemydie` / `die` on death, `error` when an ability fails for a reason the player should hear (not for cooldown), and `portal` on level travel. Music sequencing is not built yet.
