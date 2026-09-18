// Game runtime: player, weapons, the fixed-timestep loop, and the glue that
// hands engine services to entity behaviours.

import { Renderer } from './render.js';
import { CollisionWorld, CharacterController } from './physics.js';
import { RagdollSystem, STEP_DT } from './ragdoll.js';
import { EntityWorld, defineEntity } from './entity.js';
import { buildMap, loadMap, pointInBrush } from './map.js';
import { playSound, playSoundAt, unlockAudio } from './audio.js';
import {
  add, sub, mul, norm, len, dot, dist, clamp,
  anglesToForward, anglesToRight,
} from './math.js';
import { killNPC } from './entities.js';
import { GameConsole } from './console.js';
import { NetClient } from './net.js';

// Single source of truth, shared with the ragdoll solver: impulses convert
// force to a verlet position offset using this exact value, so the two drifting
// apart silently doubles every impulse in the game.
const FIXED_DT = STEP_DT;
// frameTime is clamped to 0.25s below, which is 30 steps at 1/120. Capping
// lower than that meant a slow frame simulated less time than really elapsed
// and threw the remainder away — the world advancing by a different amount
// every frame, which is exactly what "janky" feels like.
const MAX_SUBSTEPS = Math.ceil(0.25 / FIXED_DT);

class Player {
  constructor(config = {}) {
    this.controller = new CharacterController({
      position: config.spawn || [0, 2, 0],
      halfExtents: [0.35, 0.9, 0.35],
      maxSpeed: config.maxSpeed ?? 7.2,
      jumpSpeed: config.jumpSpeed ?? 7.4,
    });
    this.angles = [0, config.yaw ?? 0, 0];
    this.maxHealth = config.maxHealth ?? 100;
    this.health = this.maxHealth;
    this.ammo = config.ammo ?? 120;
    this.eyeHeight = 0.72;
    this.fireCooldown = 0;
    this.damageFlash = 0;
    this.stepAccum = 0;
    this.kills = 0;
    this.dead = false;
    this.respawnTimer = 0;
    this.spawnPoint = config.spawn || [0, 2, 0];
  }

  get position() { return this.controller.position; }

  get eyePosition() {
    const p = this.controller.position;
    return [p[0], p[1] + this.eyeHeight, p[2]];
  }

  /** Eye position blended between the last two physics steps, for rendering. */
  interpolatedEye(alpha) {
    const p = this.controller.position;
    const q = this.prevPosition || p;
    return [
      q[0] + (p[0] - q[0]) * alpha,
      q[1] + (p[1] - q[1]) * alpha + this.eyeHeight,
      q[2] + (p[2] - q[2]) * alpha,
    ];
  }

  get forward() { return anglesToForward(this.angles); }

  /**
   * `fromServer` marks damage the server already applied and broadcast. Damage
   * without it came from something this client simulates alone — an NPC, an
   * explosion, a fall — and has to be reported, because NPCs run per-client and
   * the server owns health. Reporting your own damage is safe to trust: the
   * only thing a client can achieve by lying is hurting itself.
   */
  takeDamage(amount, source, fromServer = false) {
    if (this.dead || this.godMode) return;
    this.health -= amount;
    this.damageFlash = 1;
    playSound('hurt', 0.7);
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.respawnTimer = 2.5;
      playSound('die');
    }
    if (!fromServer && this.net && this.net.connected) this.net.reportSelfDamage(amount);
    void source;
  }

  /**
   * Move instantly, without a visible streak: the renderer blends between the
   * last two physics positions, so a teleport must reset both or the camera
   * sweeps across the map for one step.
   */
  teleport(pos) {
    this.controller.position = [pos[0], pos[1], pos[2]];
    this.controller.velocity = [0, 0, 0];
    this.prevPosition = [pos[0], pos[1], pos[2]];
  }

  respawn() {
    this.deaths = (this.deaths || 0) + 1;
    this.teleport(this.spawnPoint);
    // Deliberately keep the player's current yaw/pitch. Snapping the camera
    // back on respawn reads as the game wrestling the mouse away from you.
    this.angles[0] = 0;
    this.health = this.maxHealth;
    this.dead = false;
  }
}

// Ray vs axis-aligned box, used for hitscan against NPC bodies.
function rayBox(origin, dir, min, max) {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-8) {
      if (origin[i] < min[i] || origin[i] > max[i]) return null;
    } else {
      const inv = 1 / dir[i];
      let t1 = (min[i] - origin[i]) * inv;
      let t2 = (max[i] - origin[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

export class Game {
  constructor(canvas, hud) {
    this.canvas = canvas;
    this.hud = hud;
    this.renderer = new Renderer(canvas);
    this.ragdolls = new RagdollSystem();
    this.keys = new Set();
    this.mouseDown = false;
    this.pointerLocked = false;
    this.lookBlocked = false;
    this.dragLook = false;
    this.dragDistance = 0;
    this.lastMouse = [0, 0];
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.fpsAccum = 0;
    this.dynamicBrushes = [];
    this.debugText = '';
    this.sensitivity = 0.14;
    this.onStatsChanged = null;
    this.fov = 78;
    this.timescale = 1;
    this.bindInput();
    this.console = new GameConsole(this);
    this.net = new NetClient(this);
    this.net.onChat = (from, text) => {
      this.console.print(from ? `${from}: ${text}` : text, from ? 'out' : 'cmd');
      if (this.hud && this.hud.chat) this.hud.chat(from, text);
    };
    this.net.onStatus = (text) => this.console.print(text, 'cmd');
  }

  async load(mapUrl) {
    const doc = await loadMap(mapUrl);
    this.currentMapPath = mapUrl;
    this.loadMapDocument(doc);
  }

  loadMapDocument(doc) {
    this.mapDoc = doc;
    const built = buildMap(doc);
    this.built = built;
    this.collision = built.collision;
    this.dynamicBrushes = [];
    this.collision.setDynamicBrushes(this.dynamicBrushes);
    this.renderer.setMaterials(built.materials);
    this.renderer.setWorldMesh(built.meshData);
    this.renderer.computeLightMatrix(built.env.sunDir, built.bounds);
    this.env = built.env;
    this.ragdolls.clear();

    const startEntity = (built.entities || []).find((e) => e.classname === 'info_player_start');
    let spawn = startEntity ? add(startEntity.origin, [0, 1.0, 0]) : [0, 3, 0];
    spawn = this.resolveSpawn(spawn);
    this.player = new Player({
      spawn,
      yaw: startEntity && startEntity.angles ? startEntity.angles[1] : 0,
      ...(built.player || {}),
    });
    // The player reports locally-simulated damage (NPCs, explosions) so the
    // server's authoritative health stays in step with what this client sees.
    this.player.net = this.net || null;

    this.world = new EntityWorld({
      collision: this.collision,
      ragdolls: this.ragdolls,
      materialIndex: built.materialIndex,
      player: this.player,
      listener: () => this.player.eyePosition,
      registerDynamicBrush: (brush) => this.dynamicBrushes.push(brush),
      findTriggerBrush: (name) => built.triggerBrushes.find((t) => t.name === name),
      game: this,
    });

    for (const data of built.entities) this.world.spawn(data);
    this.mapName = built.name;
  }

  /**
   * A spawn buried in geometry leaves the player stuck with no obvious cause —
   * an easy mistake to make when writing map JSON by hand. Lift the spawn to
   * free space if we can, and say so loudly rather than failing silently.
   */
  resolveSpawn(spawn) {
    const half = [0.35, 0.9, 0.35];
    if (!this.collision.pointInSolid(spawn, half)) {
      this.spawnWarning = '';
      return spawn;
    }
    for (let lift = 0.5; lift <= 12; lift += 0.5) {
      const candidate = [spawn[0], spawn[1] + lift, spawn[2]];
      if (!this.collision.pointInSolid(candidate, half)) {
        this.spawnWarning = `info_player_start is inside solid geometry — lifted ${lift.toFixed(1)}m`;
        console.warn('[fount]', this.spawnWarning, spawn);
        return candidate;
      }
    }
    this.spawnWarning = 'info_player_start is inside solid geometry and could not be freed';
    console.warn('[fount]', this.spawnWarning, spawn);
    return spawn;
  }

  bindInput() {
    const canvas = this.canvas;

    window.addEventListener('keydown', (e) => {
      // Typing in the console (or any text field) must not also drive the game.
      if (this.typingElsewhere(e)) return;
      if (e.code === 'Tab') e.preventDefault();
      // Arrow keys would scroll the page, and they're the one look control
      // that works even where the mouse can't be captured at all.
      if (e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
      unlockAudio();
      if (e.code === 'KeyR' && e.shiftKey) this.restart();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.dragLook = false; });

    canvas.addEventListener('click', () => {
      unlockAudio();
      if (!this.editorMode && document.pointerLockElement !== canvas) this.requestLook();
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      if (this.pointerLocked) this.lookBlocked = false;
    });

    // Pointer lock can be refused for reasons the page cannot see: an embedded
    // frame, a browser policy, a stale user gesture. Left unhandled that is a
    // silent dead mouse, so record it and let the drag fallback take over.
    document.addEventListener('pointerlockerror', () => {
      this.pointerLocked = false;
      this.lookBlocked = true;
      console.warn('[fount] pointer lock was refused — drag-to-look and arrow keys still work.');
    });

    document.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this.applyLook(e.movementX, e.movementY);
        return;
      }
      if (!this.dragLook) return;
      const dx = e.clientX - this.lastMouse[0];
      const dy = e.clientY - this.lastMouse[1];
      this.lastMouse = [e.clientX, e.clientY];
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      this.applyLook(dx, dy);
    });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (this.pointerLocked) {
        this.mouseDown = true;
        return;
      }
      // Without pointer lock, hold-and-drag aims. The shot is deferred to
      // mouseup so a drag doesn't also fire a bullet at whatever you passed.
      this.dragLook = true;
      this.dragDistance = 0;
      this.lastMouse = [e.clientX, e.clientY];
      e.preventDefault();
    });

    window.addEventListener('mouseup', () => {
      if (this.dragLook) {
        this.dragLook = false;
        if (this.dragDistance < 6) this.fire();
      }
      this.mouseDown = false;
    });
  }

  /** True when keystrokes belong to the console or another text field. */
  typingElsewhere(e) {
    if (this.console && this.console.open) return true;
    const el = e.target;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  /** The one place camera angles move, whatever the input route. */
  applyLook(dx, dy) {
    if (!this.player) return;
    this.player.angles[1] -= dx * this.sensitivity;
    this.player.angles[0] = clamp(this.player.angles[0] + dy * this.sensitivity, -89, 89);
  }

  requestLook() {
    const result = this.canvas.requestPointerLock();
    // Newer browsers return a promise; an unhandled rejection here is exactly
    // how this failure used to disappear without a trace.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        this.lookBlocked = true;
        console.warn('[fount] pointer lock was refused — drag-to-look and arrow keys still work.');
      });
    }
  }

  restart() {
    if (this.mapDoc) this.loadMapDocument(this.mapDoc);
  }

  /** Where the player is looking, used by console spawn commands. */
  aimPoint(maxRange = 60) {
    const origin = this.player.eyePosition;
    const end = add(origin, mul(this.player.forward, maxRange));
    const trace = this.collision.traceRay(origin, end);
    const point = trace.hit ? trace.endPos : end;
    // Lift off the surface so a spawned entity isn't born inside the floor.
    return [point[0], point[1] + 0.3, point[2]];
  }

  wishDirection() {
    if (this.player.dead) return [0, 0, 0];
    const forward = anglesToForward([0, this.player.angles[1], 0]);
    const right = anglesToRight(this.player.angles);
    let wish = [0, 0, 0];
    if (this.keys.has('KeyW')) wish = add(wish, forward);
    if (this.keys.has('KeyS')) wish = sub(wish, forward);
    if (this.keys.has('KeyD')) wish = add(wish, right);
    if (this.keys.has('KeyA')) wish = sub(wish, right);
    wish[1] = 0;
    return wish;
  }

  // Hitscan: trace the world first, then see whether any NPC body is closer.
  // Where it lands decides the ragdoll impulse point, so a head hit throws the
  // head and a leg hit drops them.
  fire() {
    const player = this.player;
    if (player.dead || player.ammo <= 0 || player.fireCooldown > 0) return;
    player.fireCooldown = 0.11;
    player.ammo--;
    playSound('shoot');

    const origin = player.eyePosition;
    const dir = player.forward;
    const maxRange = 120;
    const end = add(origin, mul(dir, maxRange));

    if (this.net && this.net.connected) this.net.reportShot(origin, dir);

    const worldTrace = this.collision.traceRay(origin, end);
    let bestDist = worldTrace.hit ? worldTrace.fraction * maxRange : maxRange;
    let hitEntity = null;
    let hitPoint = worldTrace.endPos;

    // Remote players are checked against the same ray as NPCs, so geometry
    // between you and them still blocks the shot.
    if (this.net && this.net.connected) {
      const remote = this.net.pickPlayer(origin, dir, bestDist);
      if (remote) {
        const point = add(origin, mul(dir, remote.t));
        this.net.reportHit(remote.player.id, point.map((n) => +n.toFixed(2)));
        playSoundAt('impact', point, this.player.eyePosition, 40);
        return;
      }
    }

    for (const entity of this.world.entities) {
      if (entity.removed || entity.classname !== 'npc_grunt' || entity.state.dead) continue;
      const ctrl = entity.state.controller;
      const c = ctrl.position;
      const h = ctrl.halfExtents;
      const min = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
      const max = [c[0] + h[0], c[1] + h[1] + 0.35, c[2] + h[2]];
      const t = rayBox(origin, dir, min, max);
      if (t !== null && t < bestDist) {
        bestDist = t;
        hitEntity = entity;
        hitPoint = add(origin, mul(dir, t));
      }
    }

    if (hitEntity) {
      const isHeadshot = hitPoint[1] > hitEntity.state.controller.position[1] + 0.55;
      const damage = isHeadshot ? 100 : 25;
      hitEntity.state.health -= damage;
      this.world.fireOutput(hitEntity, 'OnDamaged', null, String(hitEntity.state.health));

      if (hitEntity.state.health <= 0) {
        killNPC(hitEntity, this.world, {
          impulse: mul(dir, isHeadshot ? 16 : 9),
          hitPoint,
          impulseRadius: isHeadshot ? 0.55 : 1.0,
        });
        this.player.kills++;
      } else {
        playSoundAt('impact', hitPoint, this.player.eyePosition, 30);
        playSoundAt('hurt', hitPoint, this.player.eyePosition, 30);
      }
    } else if (worldTrace.hit) {
      playSoundAt('impact', hitPoint, this.player.eyePosition, 40);
      // Shooting a physics prop shoves it, which makes the world feel reactive.
      for (const entity of this.world.entities) {
        if (entity.removed || !entity.state.body) continue;
        const b = entity.state.body;
        const min = sub(b.position, b.halfExtents);
        const max = add(b.position, b.halfExtents);
        const t = rayBox(origin, dir, min, max);
        if (t !== null && t <= bestDist + 0.5) {
          b.addImpulse(mul(dir, 7));
          break;
        }
      }
    }

    // Bullets nudge bodies too.
    for (const ragdoll of this.ragdolls.ragdolls) {
      if (dist(ragdoll.center, hitPoint) < 1.2) {
        const idx = ragdoll.nearestParticle(hitPoint);
        ragdoll.applyImpulse(mul(dir, 6), ragdoll.positions[idx], 0.7);
      }
    }
  }

  /** Keyboard look. Needs no mouse capture, so it works everywhere. */
  keyboardLook(dt) {
    const turn = 115 * dt;
    if (this.keys.has('ArrowLeft')) this.applyLook(-turn / this.sensitivity, 0);
    if (this.keys.has('ArrowRight')) this.applyLook(turn / this.sensitivity, 0);
    if (this.keys.has('ArrowUp')) this.applyLook(0, -turn / this.sensitivity);
    if (this.keys.has('ArrowDown')) this.applyLook(0, turn / this.sensitivity);
  }

  step(dt) {
    const player = this.player;
    player.prevPosition = [...player.controller.position];
    this.keyboardLook(dt);
    player.fireCooldown = Math.max(0, player.fireCooldown - dt);
    player.damageFlash = Math.max(0, player.damageFlash - dt * 2.2);

    if (player.dead) {
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) {
        // On a server the respawn is the server's to grant: it picks the spawn
        // point and the moment, and replies with a 'respawn' we act on. Coming
        // back to life locally would be a claim the server does not honour.
        if (this.net && this.net.connected) this.net.requestRespawn();
        else player.respawn();
      }
    } else if (player.noclip) {
      // Free flight, ignoring geometry entirely. Space/Shift climb and drop.
      const wish = this.wishDirection();
      const forward = anglesToForward(player.angles);
      const vertical = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ShiftLeft') ? 1 : 0);
      const speed = player.controller.maxSpeed * 2.2;
      const dir = len(wish) > 0 ? norm(wish) : [0, 0, 0];
      // Pitch matters while flying, so W follows where you're actually looking.
      const move = add(mul(dir, speed), mul(forward, len(wish) > 0 ? forward[1] * speed : 0));
      player.controller.position = add(player.controller.position, mul(move, dt));
      player.controller.position[1] += vertical * speed * dt;
      player.controller.velocity = [0, 0, 0];
    } else {
      const wish = this.wishDirection();
      const wantJump = this.keys.has('Space');
      const wasAir = !player.controller.onGround;
      player.controller.update(this.collision, wish, wantJump, dt);

      if (player.controller.justJumped) playSound('jump', 0.6);
      if (player.controller.justLanded && wasAir) playSound('land', 0.5);

      // Footsteps keyed to distance travelled rather than time, so they stay
      // in sync whether walking or sprinting.
      if (player.controller.onGround) {
        const speed = Math.hypot(player.controller.velocity[0], player.controller.velocity[2]);
        player.stepAccum += speed * dt;
        if (player.stepAccum > 2.2) {
          player.stepAccum = 0;
          playSound('step', 0.5);
        }
      }

      if (player.position[1] < -60 && !(this.net && this.net.connected)) {
        // Offline only: on a server, health belongs to the server, which does
        // this check itself. Doing it locally too would mean two authorities
        // disagreeing about who is alive.
        player.takeDamage(1000, null);
      }
    }

    // Keyboard fire. Several bindings because the obvious one (Space) is jump,
    // and because a player whose browser refuses mouse capture still needs a
    // way to shoot. Ctrl is the classic FPS fire key; F and Enter are safe
    // alternatives that no browser shortcut claims on their own.
    const keyboardFire = this.keys.has('KeyF') || this.keys.has('Enter')
      || this.keys.has('ControlLeft') || this.keys.has('ControlRight');
    if (this.mouseDown || keyboardFire) this.fire();

    this.world.update(dt);
    this.ragdolls.update(this.collision, dt);
    if (this.net && this.net.connected) this.net.reportSelf();
  }

  render() {
    const aspect = this.renderer.resize();
    const player = this.player;
    const alpha = this.renderAlpha ?? 1;
    const camera = {
      // View angles are deliberately *not* interpolated: they come straight
      // from input, and blending them would add a frame of aim latency.
      position: player.interpolatedEye(alpha),
      forward: player.forward,
      fov: this.fov ?? 78,
    };

    this.env.pointLights = this.world.collectPointLights();

    this.renderer.beginShadowPass();
    this.renderer.drawWorld(true);
    this.world.draw(this.renderer, true);
    this.ragdolls.draw(this.renderer, true, alpha);
    if (this.net) this.net.draw(this.renderer, true);
    this.renderer.endShadowPass();

    this.renderer.beginFrame(camera, this.env, aspect);
    this.renderer.drawWorld(false);
    this.world.draw(this.renderer, false);
    this.ragdolls.draw(this.renderer, false, alpha);
    if (this.net) this.net.draw(this.renderer, false);
  }

  updateHUD() {
    if (!this.hud) return;
    const p = this.player;
    this.hud.update({
      health: Math.ceil(p.health),
      ammo: p.ammo,
      kills: p.kills,
      ragdolls: this.ragdolls.count,
      fps: Math.round(this.fps),
      dead: p.dead,
      damageFlash: p.damageFlash,
      entities: this.world.entities.length,
      map: this.mapName,
      pointerLocked: this.pointerLocked,
      lookBlocked: this.lookBlocked,
      debug: this.spawnWarning || this.debugText,
    });
  }

  frame(now) {
    // start() is called immediately while load() is still in flight, so the
    // first frames run before there's a world to draw.
    if (!this.world || !this.player) {
      requestAnimationFrame((t) => this.frame(t));
      return;
    }
    if (!this.lastTime) this.lastTime = now;
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // A long stall (tab in background) must not be simulated all at once.
    if (frameTime > 0.25) frameTime = 0.25;

    this.fpsAccum += frameTime;
    this.frameCount++;
    if (this.fpsAccum >= 0.4) {
      this.fps = this.frameCount / this.fpsAccum;
      this.fpsAccum = 0;
      this.frameCount = 0;
    }

    if (!this.paused) {
      this.accumulator += frameTime * (this.timescale ?? 1);
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      // Only reachable if a single frame exceeded the 0.25s clamp's worth of
      // steps, which it cannot — kept as a guard against a spiral of death.
      if (steps === MAX_SUBSTEPS && this.accumulator > FIXED_DT) this.accumulator = 0;
    }

    // Physics runs at a fixed rate but frames land between steps, so drawing
    // raw step output makes objects advance in uneven hops. Rendering the
    // in-between state is what turns that into smooth motion.
    this.renderAlpha = clamp(this.accumulator / FIXED_DT, 0, 1);

    this.render();
    this.updateHUD();
    requestAnimationFrame((t) => this.frame(t));
  }

  start() {
    requestAnimationFrame((t) => this.frame(t));
  }
}

export { defineEntity, pointInBrush };
