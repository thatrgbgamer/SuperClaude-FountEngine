// Collision against convex brushes, using the swept-AABB-vs-convex-hull trace
// that Quake and Source use. The trick is Minkowski expansion: offsetting each
// brush plane by the box's support along that plane's normal turns "swept box
// vs hull" into "ray vs slightly bigger hull", which handles slopes and
// arbitrary convex shapes with no special cases.

import { dot, sub, add, mul, norm, len, lenSq, clamp } from './math.js';

const EPS = 0.001;

export function makeTrace() {
  // startDepth is how far a start-solid box has to move along `normal` to
  // get back out; movers use it to escape geometry they've been pushed into.
  return { fraction: 1, normal: [0, 1, 0], hit: false, startSolid: false, startDepth: Infinity, entity: null, endPos: [0, 0, 0] };
}

function boxesOverlap(aMin, aMax, bMin, bMax) {
  return aMin[0] <= bMax[0] && aMax[0] >= bMin[0] &&
         aMin[1] <= bMax[1] && aMax[1] >= bMin[1] &&
         aMin[2] <= bMax[2] && aMax[2] >= bMin[2];
}

function clipBoxToBrush(brush, start, end, halfExtents, trace) {
  let enterFrac = -1;
  let leaveFrac = 1;
  let clipNormal = null;
  let startsOut = false;
  // The least-penetrated plane is the shortest way back out if we start solid.
  let exitNormal = null;
  let exitDepth = Infinity;

  for (const plane of brush.planes) {
    const n = plane.n;
    // Expand the plane outward by the box's extent along this normal.
    const offset = Math.abs(n[0]) * halfExtents[0] + Math.abs(n[1]) * halfExtents[1] + Math.abs(n[2]) * halfExtents[2];
    const planeDist = plane.d + offset;

    const d1 = dot(n, start) - planeDist;
    const d2 = dot(n, end) - planeDist;

    if (d1 > 0) startsOut = true;
    else if (-d1 < exitDepth) { exitDepth = -d1; exitNormal = n; }

    // Never crosses into the brush: in front of this face for the whole move,
    // or moving away from it. A move that *ends* inside the epsilon band still
    // counts as a contact — otherwise a box resting against a wall could creep
    // through the band in sub-epsilon steps and end up inside the geometry.
    if (d1 > 0 && (d2 >= EPS || d2 >= d1)) return false;
    if (d1 <= 0 && d2 <= 0) continue;    // stays inside this plane's halfspace

    if (d1 > d2) {
      // Already within EPS of the face: treat it as touching at fraction 0
      // rather than a negative fraction, which the > -1 test below would drop.
      let f = (d1 - EPS) / (d1 - d2);
      if (f < 0) f = 0;
      if (f > enterFrac) { enterFrac = f; clipNormal = n; }
    } else {
      let f = (d1 + EPS) / (d1 - d2);
      if (f > 1) f = 1;
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startsOut) {
    trace.startSolid = true;
    trace.fraction = 0;
    trace.hit = true;
    if (exitDepth < trace.startDepth) {
      trace.startDepth = exitDepth;
      trace.normal = exitNormal;
    }
    return true;
  }

  if (enterFrac > -1 && enterFrac < leaveFrac && enterFrac < trace.fraction) {
    trace.fraction = Math.max(enterFrac, 0);
    trace.normal = clipNormal;
    trace.hit = true;
    return true;
  }
  return false;
}

export class CollisionWorld {
  constructor() {
    this.brushes = [];
    this.bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  }

  addBrush(planes, min, max, flags = {}) {
    this.brushes.push({ planes, min, max, ...flags });
  }

  // Brush entities (doors, platforms) move at runtime, so they're traced
  // separately from the baked static set.
  setDynamicBrushes(list) {
    this.dynamicBrushes = list;
  }

  computeBounds() {
    if (!this.brushes.length) return;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const b of this.brushes) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], b.min[i]);
        max[i] = Math.max(max[i], b.max[i]);
      }
    }
    this.bounds = { min, max };
  }

  traceBox(start, end, halfExtents, filter = null) {
    const trace = makeTrace();

    const sweepMin = [
      Math.min(start[0], end[0]) - halfExtents[0] - 1,
      Math.min(start[1], end[1]) - halfExtents[1] - 1,
      Math.min(start[2], end[2]) - halfExtents[2] - 1,
    ];
    const sweepMax = [
      Math.max(start[0], end[0]) + halfExtents[0] + 1,
      Math.max(start[1], end[1]) + halfExtents[1] + 1,
      Math.max(start[2], end[2]) + halfExtents[2] + 1,
    ];

    for (const brush of this.brushes) {
      if (brush.nonSolid) continue;
      if (filter && filter(brush) === false) continue;
      if (!boxesOverlap(sweepMin, sweepMax, brush.min, brush.max)) continue;
      clipBoxToBrush(brush, start, end, halfExtents, trace);
    }

    if (this.dynamicBrushes) {
      for (const brush of this.dynamicBrushes) {
        if (brush.nonSolid) continue;
        if (filter && filter(brush) === false) continue;
        if (!boxesOverlap(sweepMin, sweepMax, brush.min, brush.max)) continue;
        const before = trace.fraction;
        if (clipBoxToBrush(brush, start, end, halfExtents, trace) && trace.fraction < before) {
          trace.entity = brush.entity || null;
        }
      }
    }

    trace.endPos = [
      start[0] + (end[0] - start[0]) * trace.fraction,
      start[1] + (end[1] - start[1]) * trace.fraction,
      start[2] + (end[2] - start[2]) * trace.fraction,
    ];
    return trace;
  }

  traceRay(start, end, filter = null) {
    return this.traceBox(start, end, [0, 0, 0], filter);
  }

  pointInSolid(point, halfExtents = [0, 0, 0]) {
    const trace = this.traceBox(point, point, halfExtents);
    return trace.startSolid;
  }
}

// Removes the component of velocity heading into a surface. `overclip` slightly
// over-corrects so the mover doesn't creep back into the plane next frame.
export function clipVelocity(velocity, normal, overclip = 1.001) {
  let backoff = dot(velocity, normal);
  backoff *= backoff < 0 ? overclip : 1 / overclip;
  return sub(velocity, mul(normal, backoff));
}

// Move-and-slide: on contact, project the remaining motion along the surface
// and keep going, so running into a wall at an angle slides instead of stopping.
export function slideMove(world, position, velocity, halfExtents, dt, maxIterations = 4) {
  let pos = position;
  let vel = velocity;
  let remaining = dt;
  const planes = [];
  let hitNormal = null;
  let blocked = false;

  for (let i = 0; i < maxIterations && remaining > 1e-6; i++) {
    const end = add(pos, mul(vel, remaining));
    const trace = world.traceBox(pos, end, halfExtents);

    if (trace.startSolid) {
      // Inside geometry: push back out through the nearest face and clip the
      // velocity against it, then carry on with the move. Nudging blindly
      // upward here is what let a player wedged against a wall climb it.
      const depth = Number.isFinite(trace.startDepth) ? trace.startDepth : 0;
      pos = add(pos, mul(trace.normal, depth + EPS));
      vel = clipVelocity(vel, trace.normal);
      blocked = true;
      hitNormal = trace.normal;
      continue;
    }

    pos = trace.endPos;
    if (!trace.hit) { remaining = 0; break; }

    blocked = true;
    hitNormal = trace.normal;
    remaining *= 1 - trace.fraction;

    // Re-clipping against a plane we already hit leads to jitter in corners.
    let duplicate = false;
    for (const p of planes) if (dot(p, trace.normal) > 0.99) duplicate = true;
    if (!duplicate) planes.push(trace.normal);

    vel = clipVelocity(vel, trace.normal);

    // With two contact planes, slide along their shared edge (inside corners).
    if (planes.length >= 2) {
      const crease = norm([
        planes[0][1] * planes[1][2] - planes[0][2] * planes[1][1],
        planes[0][2] * planes[1][0] - planes[0][0] * planes[1][2],
        planes[0][0] * planes[1][1] - planes[0][1] * planes[1][0],
      ]);
      if (lenSq(crease) > 1e-6) vel = mul(crease, dot(vel, crease));
    }
  }

  return { position: pos, velocity: vel, blocked, normal: hitNormal };
}

const GROUND_NORMAL_Y = 0.7; // ~45 degrees: steeper than this counts as a wall

export class CharacterController {
  constructor(options = {}) {
    this.halfExtents = options.halfExtents || [0.35, 0.9, 0.35];
    this.position = options.position || [0, 2, 0];
    this.velocity = [0, 0, 0];
    this.onGround = false;
    this.groundNormal = [0, 1, 0];
    this.stepHeight = options.stepHeight ?? 0.55;

    this.maxSpeed = options.maxSpeed ?? 7.0;
    this.acceleration = options.acceleration ?? 12;
    this.airAcceleration = options.airAcceleration ?? 2.2;
    this.airControlSpeed = options.airControlSpeed ?? 1.6;
    this.friction = options.friction ?? 7;
    this.gravity = options.gravity ?? 22;
    this.jumpSpeed = options.jumpSpeed ?? 7.3;
    this.justLanded = false;
    this.justJumped = false;
  }

  // Probe for walkable ground and settle onto it. A mover that was already on
  // the ground probes a full step down, so walking off a stair tread follows
  // the stairs instead of hopping off each one; anything airborne only gets
  // the short probe, so it can't be sucked onto a floor it hasn't reached.
  checkGround(world) {
    const wasOnGround = this.onGround;
    const probe = wasOnGround ? this.stepHeight : 0.08;
    const probeDown = () => world.traceBox(this.position,
      [this.position[0], this.position[1] - probe, this.position[2]], this.halfExtents);

    let trace = probeDown();
    if (trace.startSolid && Number.isFinite(trace.startDepth)) {
      // Something moved into us since last step — a platform rising underfoot,
      // a door closing on us. Step out through the nearest face and look again,
      // so a rider on a lift stays grounded instead of "falling" every frame.
      this.position = add(this.position, mul(trace.normal, trace.startDepth + EPS));
      this.velocity = clipVelocity(this.velocity, trace.normal);
      trace = probeDown();
    }

    // A trace that is still start-solid reports the shortest way out of
    // geometry, which is not the same thing as standing on it. Moving up and
    // away from the surface faster than a nudge (a jump) also isn't grounded.
    const walkable = trace.hit && !trace.startSolid && trace.normal[1] >= GROUND_NORMAL_Y;
    const leaving = dot(this.velocity, trace.normal) > 0.5;
    this.onGround = walkable && !leaving;

    if (this.onGround) {
      this.groundNormal = trace.normal;
      this.position = trace.endPos;
    }
    this.justLanded = this.onGround && !wasOnGround;
  }

  // Quake-style acceleration: only adds speed along wishDir up to wishSpeed.
  // Capping the air variant at a low wishSpeed is what preserves air-strafe
  // momentum instead of clamping it, giving the movement its Source feel.
  accelerate(wishDir, wishSpeed, accel, dt) {
    const current = dot(this.velocity, wishDir);
    const addSpeed = wishSpeed - current;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
    this.velocity = add(this.velocity, mul(wishDir, accelSpeed));
  }

  applyFriction(dt) {
    const speed = Math.hypot(this.velocity[0], this.velocity[2]);
    if (speed < 0.05) {
      this.velocity[0] = 0;
      this.velocity[2] = 0;
      return;
    }
    const drop = Math.max(speed, 2.0) * this.friction * dt;
    const scale = Math.max(speed - drop, 0) / speed;
    this.velocity[0] *= scale;
    this.velocity[2] *= scale;
  }

  update(world, wishDir, wantJump, dt) {
    this.justJumped = false;
    this.checkGround(world);

    const hasInput = lenSq(wishDir) > 1e-6;
    const dir = hasInput ? norm(wishDir) : [0, 0, 0];

    if (this.onGround) {
      this.applyFriction(dt);
      if (hasInput) this.accelerate(dir, this.maxSpeed, this.acceleration, dt);
      if (this.velocity[1] < 0) this.velocity[1] = 0;
      if (wantJump) {
        this.velocity[1] = this.jumpSpeed;
        this.onGround = false;
        this.justJumped = true;
      }
    } else {
      if (hasInput) this.accelerate(dir, this.airControlSpeed, this.airAcceleration, dt);
      this.velocity[1] -= this.gravity * dt;
      if (this.velocity[1] < -60) this.velocity[1] = -60;
    }

    const startPos = this.position;
    const startVel = this.velocity;
    const flat = slideMove(world, startPos, this.velocity, this.halfExtents, dt);

    // Stair handling: retry the same motion lifted by stepHeight, then drop
    // back down. Whichever attempt travelled further horizontally wins.
    if (flat.blocked && this.onGround) {
      const up = [startPos[0], startPos[1] + this.stepHeight, startPos[2]];
      const upTrace = world.traceBox(startPos, up, this.halfExtents);
      if (!upTrace.startSolid) {
        const stepped = slideMove(world, upTrace.endPos, startVel, this.halfExtents, dt);
        const downTarget = [stepped.position[0], stepped.position[1] - this.stepHeight - 0.02, stepped.position[2]];
        const downTrace = world.traceBox(stepped.position, downTarget, this.halfExtents);
        const landed = downTrace.endPos;

        const flatDist = Math.hypot(flat.position[0] - startPos[0], flat.position[2] - startPos[2]);
        const stepDist = Math.hypot(landed[0] - startPos[0], landed[2] - startPos[2]);
        if (stepDist > flatDist + 0.001 && (!downTrace.hit || downTrace.normal[1] >= GROUND_NORMAL_Y)) {
          this.position = landed;
          this.velocity = stepped.velocity;
          this.velocity[1] = Math.min(this.velocity[1], 0);
          return;
        }
      }
    }

    this.position = flat.position;
    this.velocity = flat.velocity;
  }
}

// Simple axis-aligned rigid body for crates and debris. Full rotational rigid
// body dynamics would be overkill here — ragdolls carry the visual interest,
// and boxes that tumble convincingly need orientation we don't otherwise track.
export class RigidBody {
  constructor(options = {}) {
    this.position = options.position || [0, 1, 0];
    this.velocity = options.velocity || [0, 0, 0];
    this.halfExtents = options.halfExtents || [0.3, 0.3, 0.3];
    this.restitution = options.restitution ?? 0.25;
    this.friction = options.friction ?? 4;
    this.gravity = options.gravity ?? 22;
    this.asleep = false;
    this.spin = options.spin || [0, 0, 0];
    this.angle = [0, 0, 0];
  }

  addImpulse(impulse) {
    this.velocity = add(this.velocity, impulse);
    this.spin = [this.spin[0] + impulse[2] * 0.5, this.spin[1] + impulse[0] * 0.3, this.spin[2] - impulse[0] * 0.5];
    this.asleep = false;
  }

  update(world, dt) {
    if (this.asleep) return;
    this.velocity[1] -= this.gravity * dt;

    const result = slideMove(world, this.position, this.velocity, this.halfExtents, dt);
    this.position = result.position;

    if (result.blocked && result.normal) {
      this.velocity = result.velocity;
      if (result.normal[1] > GROUND_NORMAL_Y) {
        const speed = Math.hypot(this.velocity[0], this.velocity[2]);
        const drop = speed * this.friction * dt;
        const scale = speed > 0 ? Math.max(speed - drop, 0) / speed : 0;
        this.velocity[0] *= scale;
        this.velocity[2] *= scale;
        this.spin = mul(this.spin, Math.max(0, 1 - dt * 4));
        if (Math.abs(this.velocity[1]) < 0.6 && speed < 0.25) {
          this.velocity = [0, 0, 0];
          this.spin = [0, 0, 0];
          this.asleep = true;
        }
      }
    } else {
      this.velocity = result.velocity;
    }

    this.angle = [
      this.angle[0] + this.spin[0] * dt * 60,
      this.angle[1] + this.spin[1] * dt * 60,
      this.angle[2] + this.spin[2] * dt * 60,
    ];
  }
}

export { GROUND_NORMAL_Y };
