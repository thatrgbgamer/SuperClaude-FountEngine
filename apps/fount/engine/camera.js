// The top-down / three-quarter follow camera, and the maths for picking
// through it. Pure: no GL, no DOM, so it is tested in Node and the ray code is
// the same whatever draws the frame.
//
// Conventions match the rest of the engine: yaw is in degrees and 0 looks along
// +X, so screen-up on the ground is [cos yaw, 0, -sin yaw] and screen-right is
// [sin yaw, 0, cos yaw]. Pitch is the angle the camera looks down at the ground.

import { add, sub, mul, dot, norm, cross, clamp } from './math.js';

const DEG = Math.PI / 180;

export const CAMERA_DEFAULTS = {
  pitch: 58,
  yaw: 45,
  distance: 18,          // perspective: metres back from the focus point
  fov: 38,               // perspective vertical field of view, degrees
  ortho: false,          // orthographic keeps every ground pixel the same size
  orthoHeight: 14,       // orthographic: world metres visible top to bottom
  pixelsPerUnit: null,   // orthographic: set this instead and orthoHeight follows the render height
  zoom: 1,
  minZoom: 0.5,
  maxZoom: 3,
  yawStep: 45,           // degrees per rotate step; 0 disables rotation
  rotateSmooth: 12,      // how quickly yaw eases to its target
  smooth: 9,             // how quickly the camera catches up with its target
  deadzone: 0.6,         // metres the target may wander before the camera follows
  focusHeight: 0.9,      // aim this far above the target's feet
  spriteTilt: 0,         // 0 keeps sprites upright, 1 turns them to face the view plane
  snap: true,            // orthographic: quantise to render pixels so the world does not crawl
};

export class TopDownCamera {
  constructor(config = {}, resolution = null) {
    this.focus = null;
    this.configure(config, resolution);
    this.yaw = this.targetYaw;
  }

  /** (Re)apply settings. `resolution` is the render size, used for pixel snapping. */
  configure(config = {}, resolution = null) {
    const c = { ...CAMERA_DEFAULTS, ...config };
    Object.assign(this, {
      pitch: clamp(c.pitch, 5, 89), distance: c.distance, fov: c.fov, ortho: !!c.ortho,
      zoom: c.zoom, minZoom: c.minZoom, maxZoom: c.maxZoom, yawStep: c.yawStep,
      rotateSmooth: c.rotateSmooth, smooth: c.smooth, deadzone: c.deadzone,
      focusHeight: c.focusHeight, spriteTilt: c.spriteTilt, snap: c.snap,
    });
    this.targetYaw = c.yaw;
    this.resolution = resolution;
    this.orthoBase = c.pixelsPerUnit && resolution ? resolution[1] / c.pixelsPerUnit : c.orthoHeight;
    this.orthoNear = 0.1;
  }

  get effectiveOrthoHeight() { return this.orthoBase / this.zoom; }

  /** Rotate the view by one step (+1 clockwise, -1 counter-clockwise). */
  rotate(direction) {
    if (!this.yawStep) return;
    this.targetYaw += direction * this.yawStep;
  }

  setYaw(yaw, instant = false) {
    this.targetYaw = yaw;
    if (instant) this.yaw = yaw;
  }

  zoomBy(factor) {
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
  }

  /** Snap straight onto a position, with no easing: used on spawn and map change. */
  cut(target) {
    this.focus = [target[0], target[1] + this.focusHeight, target[2]];
    this.yaw = this.targetYaw;
  }

  update(dt, target) {
    const desired = [target[0], target[1] + this.focusHeight, target[2]];
    if (!this.focus) this.focus = desired.slice();

    // Yaw eases along the shortest arc.
    let dy = this.targetYaw - this.yaw;
    dy = ((dy + 540) % 360) - 180;
    this.yaw += this.rotateSmooth > 0 ? dy * (1 - Math.exp(-this.rotateSmooth * dt)) : dy;
    if (Math.abs(this.targetYaw - this.yaw) < 1e-3) this.yaw = this.targetYaw;

    // Deadzone: only chase once the target leaves a small circle around the focus.
    const f = this.focus;
    const dx = desired[0] - f[0], dz = desired[2] - f[2];
    const d = Math.hypot(dx, dz);
    let gx = f[0], gz = f[2];
    if (d > this.deadzone) {
      const k = (d - this.deadzone) / d;
      gx = f[0] + dx * k;
      gz = f[2] + dz * k;
    }
    const a = this.smooth > 0 ? 1 - Math.exp(-this.smooth * dt) : 1;
    f[0] += (gx - f[0]) * a;
    f[2] += (gz - f[2]) * a;
    f[1] += (desired[1] - f[1]) * (1 - Math.exp(-4 * dt));
  }

  /** The unit vector the camera looks along, pitched down. */
  get forward() {
    const y = this.yaw * DEG, p = this.pitch * DEG;
    return [Math.cos(y) * Math.cos(p), -Math.sin(p), -Math.sin(y) * Math.cos(p)];
  }

  get right() {
    const y = this.yaw * DEG;
    return [Math.sin(y), 0, Math.cos(y)];
  }

  get up() {
    return norm(cross(this.right, this.forward));
  }

  /** Ground-plane axes for camera-relative movement: W goes screen-up, D screen-right. */
  moveBasis() {
    const y = this.yaw * DEG;
    return { forward: [Math.cos(y), 0, -Math.sin(y)], right: [Math.sin(y), 0, Math.cos(y)] };
  }

  get position() {
    const f = this.forward;
    const dist = this.ortho ? Math.max(this.distance, 40) : this.distance / this.zoom;
    let pos = sub(this.focus || [0, 0, 0], mul(f, dist));
    if (this.ortho && this.snap && this.resolution) {
      // One render pixel in world units on the view plane. Moving the camera
      // only in whole pixels keeps every ground texel locked to the pixel grid.
      const s = this.effectiveOrthoHeight / this.resolution[1];
      const r = this.right, u = this.up;
      const cr = dot(pos, r), cu = dot(pos, u);
      pos = add(pos, add(mul(r, Math.round(cr / s) * s - cr), mul(u, Math.round(cu / s) * s - cu)));
    }
    return pos;
  }

  /** Everything the renderer's beginFrame() needs. */
  state() {
    return {
      position: this.position,
      forward: this.forward,
      up: [0, 1, 0],
      fov: this.fov,
      ortho: this.ortho ? { height: this.effectiveOrthoHeight } : null,
      spriteTilt: this.spriteTilt,
      yaw: this.yaw,
      near: this.ortho ? this.orthoNear : 0.1,
    };
  }

  /**
   * A world-space ray through a point on screen. (ndcX, ndcY) are in [-1, 1],
   * +Y up, relative to the rendered image; `aspect` is that image's width over height.
   */
  ray(ndcX, ndcY, aspect) {
    const position = this.position;
    const f = this.forward, r = this.right, u = this.up;
    if (this.ortho) {
      const h = this.effectiveOrthoHeight / 2, w = h * aspect;
      return { origin: add(position, add(mul(r, ndcX * w), mul(u, ndcY * h))), dir: f };
    }
    const t = Math.tan((this.fov * DEG) / 2);
    return { origin: position, dir: norm(add(f, add(mul(r, ndcX * t * aspect), mul(u, ndcY * t)))) };
  }
}

/** Where a ray crosses the horizontal plane y = height, or null if it never does. */
export function rayPlaneY(origin, dir, height) {
  if (Math.abs(dir[1]) < 1e-6) return null;
  const t = (height - origin[1]) / dir[1];
  if (t < 0) return null;
  return { t, point: add(origin, mul(dir, t)) };
}

/** Ray against an axis-aligned box; distance along the ray or null. */
export function rayBox(origin, dir, min, max) {
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
