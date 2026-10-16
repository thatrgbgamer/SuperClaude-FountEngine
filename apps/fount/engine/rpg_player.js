// The top-down player. ActorPlayer wraps an Actor in the interface the rest of
// the engine already expects of `game.player` (position, health, takeDamage...),
// so pickups, triggers, the console and the net client keep working unchanged,
// and stepTopDownPlayer() turns input into actor intent every physics step.

import { lenSq } from './math.js';

export class ActorPlayer {
  constructor(actor, config = {}) {
    this.actor = actor;
    this.config = config;
    actor.player = this;
    this.angles = [0, 0, 0];
    this.kills = 0;
    this.deaths = 0;
    this.ammo = 0;                 // first-person leftovers, read by the stock HUD
    this.noclip = false;
    this.fireCooldown = 0;
    this.damageFlash = 0;
    this.respawnTimer = 0;
    this.respawnDelay = config.respawnDelay ?? 3;
    this.spawnPoint = [0, 0, 0];   // feet position
    this.hotbar = [...(config.hotbar || [])];
    this.target = null;            // the actor last clicked on
    this.moveTarget = null;        // click-to-move destination
    this.entity = null;
    this.pathTimer = 0;
    this.path = null;
    this.pathIndex = 0;

    actor.on('damage', (ev) => { if (ev.final > 0) this.damageFlash = 1; });
    actor.on('death', () => { this.respawnTimer = this.respawnDelay; this.moveTarget = null; this.deaths++; });
    actor.on('kill', () => { this.kills++; });
  }

  // ---- the first-person Player surface ----------------------------------------

  get controller() { return this.actor.controller; }
  get position() { return this.actor.controller.position; }
  get prevPosition() { return this.actor.prevPosition; }
  set prevPosition(v) { this.actor.prevPosition = v; }
  get eyePosition() { const f = this.actor.feet; return [f[0], f[1] + this.actor.height * 0.9, f[2]]; }
  get maxHealth() { return this.actor.maxHealth; }
  get health() { return this.actor.health; }
  set health(v) { this.actor.health = Math.max(0, Math.min(this.actor.maxHealth, v)); }
  get dead() { return this.actor.dead; }
  get godMode() { return this.actor.godMode; }
  set godMode(v) { this.actor.godMode = !!v; }
  get forward() { const f = this.actor.facing; return [f[0], 0, f[1]]; }

  takeDamage(amount, source = null) {
    // Legacy entities (NPC grunts, pickups) hurt "the player" with a bare number.
    this.actor.takeDamage({ amount, type: 'physical', source: source && source.actor ? source.actor : null, kind: 'legacy' });
  }

  interpolatedEye(alpha) {
    const f = this.actor.drawPosition(alpha);
    return [f[0], f[1] + this.actor.height * 0.9, f[2]];
  }

  /** Move to a controller-centre position, as the first-person Player does. */
  teleport(center) {
    const half = this.actor.halfHeight;
    this.actor.teleport([center[0], center[1] - half, center[2]]);
    this.moveTarget = null;
  }

  respawn() {
    this.actor.revive();
    this.actor.teleport(this.spawnPoint);
    this.actor.cooldowns = {};
    for (const r of Object.values(this.actor.resources)) r.value = r.max;
    this.moveTarget = null;
  }

  // ---- abilities ---------------------------------------------------------------

  useSlot(game, slot) {
    const id = this.hotbar[slot];
    if (!id) return { ok: false, reason: 'empty' };
    return this.useAbility(game, id);
  }

  useAbility(game, id) {
    const result = game.actors.abilities.use(this.actor, id, game.aimFor(this));
    if (!result.ok) game.events.emit('ability-failed', { id, reason: result.reason, actor: this.actor });
    return result;
  }
}

/**
 * Per physics step: read the player's input and set the actor's intent.
 * WASD moves relative to the camera; click-to-move (if enabled) paths to the
 * clicked ground point; hotbar keys and the primary attack use abilities aimed
 * at the cursor.
 */
export function stepTopDownPlayer(game, dt) {
  const P = game.player;
  const A = P.actor;
  const input = game.input;
  const cam = game.topCamera;
  const cfg = P.config;

  P.damageFlash = Math.max(0, P.damageFlash - dt * 2.2);

  // Camera rotation works whether or not you are alive.
  if (input.pressed('camLeft')) cam.rotate(-1);
  if (input.pressed('camRight')) cam.rotate(1);

  if (A.dead) {
    P.respawnTimer -= dt;
    A.intent.move = [0, 0];
    if (P.respawnTimer <= 0) game.respawnPlayer();
    return;
  }

  // ---- movement
  const basis = cam.moveBasis();
  const f = (input.isDown('forward') ? 1 : 0) - (input.isDown('back') ? 1 : 0);
  const r = (input.isDown('right') ? 1 : 0) - (input.isDown('left') ? 1 : 0);
  let mx = basis.forward[0] * f + basis.right[0] * r;
  let mz = basis.forward[2] * f + basis.right[2] * r;
  const keyed = f !== 0 || r !== 0;
  const mag = Math.hypot(mx, mz);
  if (mag > 1) { mx /= mag; mz /= mag; }

  if (cfg.clickToMove && input.pressed('primary') && game.hover.ground && !game.hover.actor) {
    P.moveTarget = [...game.hover.ground];
    P.path = null;
  }
  if (keyed) P.moveTarget = null;

  if (keyed) {
    A.intent.move = [mx, mz];
  } else if (P.moveTarget) {
    followClick(game, P, dt);
  } else {
    A.intent.move = [0, 0];
  }

  // ---- facing
  const aim = game.aimFor(P);
  if (cfg.facing === 'mouse' && game.hover.ground) A.intent.face = aim.dir;
  else A.intent.face = null;

  // ---- abilities
  for (let i = 0; i < 10; i++) {
    if (input.pressed(`hotbar${i + 1}`)) P.useSlot(game, i);
  }
  const attackAction = cfg.clickToMove ? 'secondary' : 'primary';
  if (input.isDown(attackAction) && game.hover.inside) {
    if (game.hover.actor && A.isHostile(game.hover.actor)) P.target = game.hover.actor;
    // Holding the button keeps attacking: the cooldown is the limit, not the click rate.
    if (A.canCast()) P.useSlot(game, cfg.primarySlot ?? 0);
  }

  // ---- interacting with the world
  if (input.pressed('interact')) game.interact(P);
}

/** Walk toward a clicked point, along the nav grid when there is one. */
function followClick(game, P, dt) {
  const A = P.actor;
  const feet = A.feet;
  const dest = P.moveTarget;
  const gap = Math.hypot(dest[0] - feet[0], dest[2] - feet[2]);
  if (gap < 0.25) { P.moveTarget = null; A.intent.move = [0, 0]; return; }

  let aim = dest;
  const nav = game.actors.nav;
  if (nav) {
    P.pathTimer -= dt;
    if (!P.path || P.pathTimer <= 0) {
      P.pathTimer = 0.4;
      P.path = nav.lineClear(feet, dest) ? null : nav.findPath(feet, dest);
      P.pathIndex = 0;
    }
    if (P.path) {
      while (P.pathIndex < P.path.length - 1 && Math.hypot(P.path[P.pathIndex][0] - feet[0], P.path[P.pathIndex][2] - feet[2]) < 0.4) P.pathIndex++;
      aim = P.path[Math.min(P.pathIndex, P.path.length - 1)];
    }
  }
  const dx = aim[0] - feet[0], dz = aim[2] - feet[2];
  const d = Math.hypot(dx, dz) || 1;
  A.intent.move = [dx / d, dz / d];
  if (lenSq(A.intent.move) < 1e-6) P.moveTarget = null;
}
