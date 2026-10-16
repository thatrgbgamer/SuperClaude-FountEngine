import { test, assert, near, finish } from './harness.mjs';
import { TopDownCamera, rayPlaneY, rayBox } from '../engine/camera.js';
import { Input } from '../engine/input.js';
import { add, sub, mul, dot, len } from '../engine/math.js';

// Project a world point to NDC with the same basis the camera uses, so picking
// can be checked by a round trip rather than against numbers copied from itself.
function project(cam, point, aspect) {
  const p = cam.position, f = cam.forward, r = cam.right, u = cam.up;
  const rel = sub(point, p);
  if (cam.ortho) {
    const h = cam.effectiveOrthoHeight / 2;
    return [dot(rel, r) / (h * aspect), dot(rel, u) / h];
  }
  const t = Math.tan((cam.fov * Math.PI) / 360);
  const depth = dot(rel, f);
  return [dot(rel, r) / (depth * t * aspect), dot(rel, u) / (depth * t)];
}

for (const ortho of [false, true]) {
  test(`${ortho ? 'orthographic' : 'perspective'}: picking a point on the ground returns that point`, () => {
    const cam = new TopDownCamera({ ortho, pitch: 60, yaw: 45, distance: 18, orthoHeight: 14 });
    cam.cut([3, 0, -2]);
    const aspect = 16 / 9;
    for (const world of [[3, 0, -2], [6, 0, 1], [-2, 0, -7], [0.5, 0, 4]]) {
      const [nx, ny] = project(cam, world, aspect);
      const ray = cam.ray(nx, ny, aspect);
      const hit = rayPlaneY(ray.origin, ray.dir, 0);
      assert(hit, 'ray should reach the ground');
      near(hit.point[0], world[0], 1e-6, 'x');
      near(hit.point[2], world[2], 1e-6, 'z');
    }
  });
}

test('the centre of the screen looks at the focus point', () => {
  const cam = new TopDownCamera({ pitch: 55, yaw: 120, distance: 15 });
  cam.cut([4, 0, 4]);
  const ray = cam.ray(0, 0, 1.7);
  const toFocus = sub(cam.focus, ray.origin);
  const along = mul(ray.dir, dot(toFocus, ray.dir));
  assert(len(sub(toFocus, along)) < 1e-6, 'centre ray must pass through the focus');
});

test('movement is relative to the camera: W is screen-up, D is screen-right', () => {
  const cam = new TopDownCamera({ yaw: 90 });
  const b = cam.moveBasis();
  near(b.forward[2], -1, 1e-9); near(b.right[0], 1, 1e-9);
  // Rotating the camera a quarter turn rotates the controls with it.
  const cam2 = new TopDownCamera({ yaw: 0 });
  near(cam2.moveBasis().forward[0], 1, 1e-9, 'yaw 0 looks along +X');
});

test('the camera does not move while the target stays inside the deadzone', () => {
  const cam = new TopDownCamera({ deadzone: 1, smooth: 20 });
  cam.cut([0, 0, 0]);
  const before = cam.focus.slice();
  for (let i = 0; i < 60; i++) cam.update(1 / 60, [0.6, 0, 0.3]);
  near(cam.focus[0], before[0], 1e-9); near(cam.focus[2], before[2], 1e-9);
  for (let i = 0; i < 240; i++) cam.update(1 / 60, [10, 0, 0]);
  assert(cam.focus[0] > 8.5 && cam.focus[0] <= 9.0 + 1e-6, `follows to the deadzone edge, at ${cam.focus[0].toFixed(2)}`);
});

test('rotating steps the yaw and eases there along the short way round', () => {
  const cam = new TopDownCamera({ yaw: 350, yawStep: 45 });
  cam.rotate(1);
  assert(cam.targetYaw === 395);
  for (let i = 0; i < 120; i++) cam.update(1 / 60, [0, 0, 0]);
  near(cam.yaw, 395, 1e-2, 'ends on the target, having gone +45 not -315');
  const fixed = new TopDownCamera({ yawStep: 0 });
  fixed.rotate(1);
  assert(fixed.targetYaw === fixed.yaw, 'yawStep 0 locks rotation');
});

test('orthographic position snaps to whole render pixels', () => {
  const cam = new TopDownCamera({ ortho: true, orthoHeight: 13.5, yaw: 30, pitch: 60 }, [480, 270]);
  cam.cut([1.234, 0, 5.678]);
  const step = 13.5 / 270;
  const p = cam.position;
  const cr = dot(p, cam.right) / step, cu = dot(p, cam.up) / step;
  near(cr, Math.round(cr), 1e-6, 'right axis on pixel grid');
  near(cu, Math.round(cu), 1e-6, 'up axis on pixel grid');
});

test('pixelsPerUnit sets the orthographic height from the render height', () => {
  const cam = new TopDownCamera({ ortho: true, pixelsPerUnit: 16 }, [480, 270]);
  near(cam.effectiveOrthoHeight, 270 / 16, 1e-9);
  cam.zoomBy(2);
  near(cam.effectiveOrthoHeight, 270 / 16 / 2, 1e-9);
});

test('rayBox hits a box in front and misses one beside it', () => {
  near(rayBox([0, 0, -5], [0, 0, 1], [-1, -1, -1], [1, 1, 1]), 4, 1e-9);
  assert(rayBox([5, 0, -5], [0, 0, 1], [-1, -1, -1], [1, 1, 1]) === null);
});

test('input: a tap fires once however many steps ask, a hold stays down', () => {
  const input = new Input();
  input.keyDown('Digit1');
  assert(input.pressed('hotbar1') === true && input.pressed('hotbar1') === false, 'latched press is consumed');
  assert(input.isDown('hotbar1'));
  input.keyDown('Digit1'); // key auto-repeat
  assert(input.pressed('hotbar1') === false, 'auto-repeat is not a new press');
  input.keyUp('Digit1');
  assert(!input.isDown('hotbar1'));
});

test('input: rebinding replaces keys, captures the next press, and can be reset', async () => {
  const input = new Input();
  assert(input.isDown('forward') === false);
  input.bind('forward', ['ArrowUp']);
  input.keyDown('KeyW');
  assert(!input.isDown('forward'), 'old key no longer drives it');
  input.keyDown('ArrowUp');
  assert(input.isDown('forward'));
  const waiting = input.rebind('interact');
  input.keyDown('KeyG');
  assert(await waiting === 'KeyG' && input.bindings.interact[0] === 'KeyG');
  const cancelled = input.rebind('interact');
  input.keyDown('Escape');
  assert(await cancelled === null && input.bindings.interact[0] === 'KeyG', 'Escape cancels and keeps the binding');
  assert(input.describe('forward') === 'UP', input.describe('forward'));
  input.reset();
  assert(input.bindings.forward[0] === 'KeyW');
});

test('input: mouse buttons are bindable like keys, and bindings persist', () => {
  const input = new Input();
  input.mouseDown(0);
  assert(input.pressed('primary') && input.isDown('primary'));
  const store = new Map();
  const fake = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null };
  input.bind('interact', ['KeyR']);
  input.save(fake);
  const other = new Input();
  other.load(fake);
  assert(other.bindings.interact[0] === 'KeyR' && other.bindings.forward[0] === 'KeyW');
  other.load({ getItem: () => '{broken' }); // corrupt storage must not throw
});

finish();
