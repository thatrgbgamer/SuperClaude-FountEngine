// WebGL2 renderer. No libraries — everything from raw GL calls, so the app
// runs from a plain static file server with nothing to install.

import { m4identity, m4mul, m4perspective, m4ortho, m4lookAt, m4basisFromDir, norm, sub, add, mul, len } from './math.js';
import { buildTextureArray, MAX_MATERIALS } from './textures.js';
import { SpriteLibrary, parseColor } from './sprites.js';
import { BUILTIN_SPRITES } from './builtin_sprites.js';
import { defaultFont } from './font.js';

export const FLOATS_PER_VERT = 12; // pos3 + normal3 + uv2 + layer1 + tint3
const SPRITE_FLOATS = 13;     // origin3 + offset2 + uv2 + colour4 + flash1 + tilt1

// 1024 costs a quarter of 2048's shadow-pass fill rate and is visually almost
// indistinguishable at these map sizes. The shadow pass was the single most
// expensive thing per frame, and frame cost is what makes motion feel rough.
const SHADOW_SIZE = 1024;

const VERT_SRC = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
in float aLayer;
in vec3 aTint;

uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat4 uLightVP;

out vec3 vNormal;
out vec2 vUV;
flat out float vLayer;
out vec3 vTint;
out vec3 vWorld;
out vec4 vLightPos;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  vLayer = aLayer;
  vTint = aTint;
  vLightPos = uLightVP * world;
  gl_Position = uProj * uView * world;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;

in vec3 vNormal;
in vec2 vUV;
flat in float vLayer;
in vec3 vTint;
in vec3 vWorld;
in vec4 vLightPos;

uniform sampler2DArray uTex;
uniform sampler2DShadow uShadow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform int uPointCount;
uniform vec3 uPointPos[16];
uniform vec3 uPointColor[16];
uniform float uPointRadius[16];
uniform float uEmissive;
uniform float uTime;
uniform float uHardShadow;
uniform float uMatCount;
uniform vec3 uMatInfo[${MAX_MATERIALS}];   // per material: frames, fps, emissive
uniform vec2 uMatScroll[${MAX_MATERIALS}]; // per material: uv units per second
uniform vec4 uFocus;       // xyz: the point to keep visible (the player); w: radius of the cut-away, 0 = off
uniform vec3 uViewDir;     // from the focus toward the camera

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0;
}

out vec4 fragColor;

float sampleShadow(vec3 N) {
  vec3 proj = vLightPos.xyz / vLightPos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float bias = max(0.0025 * (1.0 - dot(N, -uSunDir)), 0.0009);
  // Hard-edged shadows: one tap, no PCF softening (the shadow map is NEAREST
  // filtered when this is on, so the comparison itself is not blended either).
  if (uHardShadow > 0.5) return texture(uShadow, vec3(proj.xy, proj.z - bias));
  float sum = 0.0;
  vec2 texel = vec2(1.0 / ${SHADOW_SIZE}.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      sum += texture(uShadow, vec3(proj.xy + vec2(float(x), float(y)) * texel, proj.z - bias));
    }
  }
  return sum / 9.0;
}

void main() {
  // Animated materials: the vertex carries the material, the clock picks the frame.
  vec3 info = uMatInfo[clamp(int(vLayer + 0.5), 0, ${MAX_MATERIALS - 1})];
  float frame = info.x > 1.5 ? mod(floor(uTime * info.y), info.x) : 0.0;
  vec2 uv = vUV + uMatScroll[clamp(int(vLayer + 0.5), 0, ${MAX_MATERIALS - 1})] * uTime;
  vec3 albedo = texture(uTex, vec3(uv, vLayer + frame * uMatCount)).rgb * vTint;
  vec3 N = normalize(vNormal);

  // Cut-away: surfaces between the camera and the focus fade out in a dither, so a wall never hides the player.
  // Anything at or below the focus's own height (the floor) stays.
  if (uFocus.w > 0.0 && vWorld.y > uFocus.y + 0.35) {
    vec3 rel = vWorld - uFocus.xyz;
    float along = dot(rel, uViewDir);
    if (along > 0.0) {
      float perp = length(rel - uViewDir * along);
      float cut = smoothstep(uFocus.w, uFocus.w * 0.45, perp);
      if (cut > bayer4(gl_FragCoord.xy)) discard;
    }
  }

  if (uEmissive > 0.5) {
    fragColor = vec4(albedo, 1.0);
    return;
  }

  vec3 color;
  if (info.z > 0.5) {
    color = albedo;   // a glowing material (lava, runes) ignores the lighting
  } else {
    float ndl = max(dot(N, -uSunDir), 0.0);
    float shadow = sampleShadow(N);
    vec3 light = uAmbient + uSunColor * ndl * shadow;

    for (int i = 0; i < 16; i++) {
      if (i >= uPointCount) break;
      vec3 delta = uPointPos[i] - vWorld;
      float d = length(delta);
      if (d > uPointRadius[i]) continue;
      float atten = 1.0 - d / uPointRadius[i];
      atten *= atten;
      light += uPointColor[i] * atten * max(dot(N, delta / max(d, 0.001)), 0.0);
    }
    color = albedo * light;
  }

  float viewDist = length(vWorld - uCamPos);
  float fog = 1.0 - exp(-viewDist * uFogDensity);
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  fragColor = vec4(color, 1.0);
}`;

const SHADOW_VERT_SRC = `#version 300 es
in vec3 aPos;
uniform mat4 uLightVP;
uniform mat4 uModel;
void main() { gl_Position = uLightVP * uModel * vec4(aPos, 1.0); }`;

const SHADOW_FRAG_SRC = `#version 300 es
precision highp float;
void main() {}`;


// ---------------------------------------------------------------------------
// Pixel-art pipeline shaders: sprites, ground blobs, the palette/dither post
// pass, and the fade overlay.
// ---------------------------------------------------------------------------

// Ordered (Bayer) dither threshold in [0,1) for an integer pixel position.
// bits=1,2,3 give 2x2, 4x4 and 8x8 matrices.
const BAYER_GLSL = `
float bayer(ivec2 q, int bits) {
  int xy = q.x ^ q.y;
  int v = 0;
  for (int i = 0; i < 3; i++) {
    if (i >= bits) break;
    int shift = 2 * (bits - 1 - i);
    v += (((xy >> i) & 1) << (shift + 1)) + (((q.y >> i) & 1) << shift);
  }
  return (float(v) + 0.5) / float(1 << (2 * bits));
}`;

const SPRITE_VERT_SRC = `#version 300 es
in vec3 aOrigin;
in vec2 aOffset;
in vec2 aUV;
in vec4 aColor;
in float aFlash;
in float aTilt;

uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uLightVP;
uniform vec3 uRight;
uniform vec3 uCamUp;
uniform vec2 uRes;
uniform float uSnap;

out vec2 vUV;
out vec4 vColor;
out float vFlash;
out vec3 vOrigin;
out vec4 vLightPos;

void main() {
  // Cylindrical billboard: the quad always faces the camera but keeps its feet
  // on the ground. aTilt leans it back toward the camera's own up so a
  // top-down view does not squash standing characters.
  // aTilt < -0.5 lays the quad flat on the ground, aligned to the world: a decal.
  bool lay = aTilt < -0.5;
  vec3 up = lay ? vec3(0.0, 0.0, -1.0) : normalize(mix(vec3(0.0, 1.0, 0.0), uCamUp, aTilt));
  vec3 right = lay ? vec3(1.0, 0.0, 0.0) : uRight;
  vec3 world = aOrigin + right * aOffset.x + up * aOffset.y;
  vec4 clip = uProj * uView * vec4(world, 1.0);

  if (uSnap > 0.5) {
    // Snap the sprite's anchor to a whole render pixel, so a character
    // sliding across the screen does not shimmer its texels.
    vec4 oc = uProj * uView * vec4(aOrigin, 1.0);
    vec2 px = (oc.xy / oc.w * 0.5 + 0.5) * uRes;
    clip.xy += ((floor(px + 0.5) - px) / uRes * 2.0) * clip.w;
  }

  vUV = aUV;
  vColor = aColor;
  vFlash = aFlash;
  vOrigin = aOrigin;
  vLightPos = uLightVP * vec4(aOrigin + vec3(0.0, 0.25, 0.0), 1.0);
  gl_Position = clip;
}`;

const SPRITE_FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2DShadow;

in vec2 vUV;
in vec4 vColor;
in float vFlash;
in vec3 vOrigin;
in vec4 vLightPos;

uniform sampler2D uAtlas;
uniform sampler2DShadow uShadow;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uSpriteMinLight;
uniform int uPointCount;
uniform vec3 uPointPos[16];
uniform vec3 uPointColor[16];
uniform float uPointRadius[16];

out vec4 fragColor;
${BAYER_GLSL}

void main() {
  vec4 tex = texture(uAtlas, vUV);
  // Alpha is a cut-out, never a blend: no sorting, and it stays palette-pure.
  if (tex.a < 0.5) discard;
  // Fading is dithered the same way: a half-faded sprite is a stipple.
  if (vColor.a < 0.999 && vColor.a <= bayer(ivec2(gl_FragCoord.xy), 2)) discard;

  vec3 proj = vLightPos.xyz / vLightPos.w * 0.5 + 0.5;
  float shadow = 1.0;
  if (proj.z <= 1.0 && proj.x >= 0.0 && proj.x <= 1.0 && proj.y >= 0.0 && proj.y <= 1.0) {
    shadow = texture(uShadow, vec3(proj.xy, proj.z - 0.002));
  }

  vec3 light = uAmbient + uSunColor * 0.6 * shadow;
  for (int i = 0; i < 16; i++) {
    if (i >= uPointCount) break;
    float d = length(uPointPos[i] - vOrigin);
    if (d > uPointRadius[i]) continue;
    float atten = 1.0 - d / uPointRadius[i];
    light += uPointColor[i] * atten * atten * 0.8;
  }
  light = max(light, vec3(uSpriteMinLight));

  vec3 color = tex.rgb * vColor.rgb * light;
  float fog = 1.0 - exp(-length(vOrigin - uCamPos) * uFogDensity);
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
  color = mix(color, vec3(1.0), vFlash);   // hit flash ignores light and fog
  fragColor = vec4(color, 1.0);
}`;

const BLOB_VERT_SRC = `#version 300 es
in vec3 aPos;
in vec2 aLocal;
in float aAlpha;
uniform mat4 uProj;
uniform mat4 uView;
out vec2 vLocal;
out float vAlpha;
void main() {
  vLocal = aLocal;
  vAlpha = aAlpha;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const BLOB_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vAlpha;
uniform vec3 uShadowColor;
out vec4 fragColor;
${BAYER_GLSL}
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  // A dithered disc: strong in the middle, half as strong at the rim, and each
  // level a stipple rather than a blend, so it stays on-palette.
  float a = vAlpha * (r < 0.55 ? 1.0 : 0.5);
  if (a <= bayer(ivec2(gl_FragCoord.xy), 2)) discard;
  fragColor = vec4(uShadowColor, 1.0);   // multiplied over the ground by the blend mode
}`;

const FULLSCREEN_VERT_SRC = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const POST_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform vec2 uRes;
uniform int uPaletteCount;
uniform vec3 uPalette[64];
uniform float uSpread;
uniform float uLevels;
uniform int uBayerBits;
out vec4 fragColor;
${BAYER_GLSL}

void main() {
  vec3 c = texture(uScene, vUV).rgb;
  // The pattern is anchored to render pixels, not screen pixels, so it does
  // not crawl when the window is resized.
  float t = bayer(ivec2(floor(vUV * uRes)), uBayerBits) - 0.5;

  if (uPaletteCount > 0) {
    vec3 target = c + t * uSpread;
    vec3 best = uPalette[0];
    float bestD = 1e9;
    for (int i = 0; i < 64; i++) {
      if (i >= uPaletteCount) break;
      vec3 d = target - uPalette[i];
      float dd = dot(d, d);
      if (dd < bestD) { bestD = dd; best = uPalette[i]; }
    }
    c = best;
  } else if (uLevels > 1.5) {
    float n = uLevels - 1.0;
    c = floor(clamp(c + t * uSpread / n, 0.0, 1.0) * n + 0.5) / n;
  }
  fragColor = vec4(c, 1.0);
}`;

const FADE_FRAG_SRC = `#version 300 es
precision highp float;
uniform vec4 uFade;
out vec4 fragColor;
void main() { fragColor = uFade; }`;

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

function link(gl, vertSrc, fragSrc, attribs = ['aPos', 'aNormal', 'aUV', 'aLayer', 'aTint']) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  attribs.forEach((name, i) => gl.bindAttribLocation(prog, i, name));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

export class MeshBuilder {
  constructor() { this.verts = []; }

  get vertexCount() { return this.verts.length / FLOATS_PER_VERT; }

  pushVert(p, n, uv, layer, tint) {
    this.verts.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], layer, tint[0], tint[1], tint[2]);
  }

  // Triangulates a convex polygon as a fan and projects UVs onto the dominant
  // axis plane, which keeps texture scale consistent across arbitrary brushes.
  pushPolygon(points, normal, layer, tint = [1, 1, 1], uvScale = 0.5) {
    if (points.length < 3) return;
    const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
    let uAxis, vAxis;
    if (ay >= ax && ay >= az) { uAxis = 0; vAxis = 2; }
    else if (ax >= az) { uAxis = 2; vAxis = 1; }
    else { uAxis = 0; vAxis = 1; }

    for (let i = 1; i < points.length - 1; i++) {
      for (const p of [points[0], points[i], points[i + 1]]) {
        this.pushVert(p, normal, [p[uAxis] * uvScale, p[vAxis] * uvScale], layer, tint);
      }
    }
  }

  pushBox(min, max, layer, tint = [1, 1, 1], uvScale = 0.5) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const faces = [
      { n: [0, 1, 0], pts: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
      { n: [0, -1, 0], pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
      { n: [0, 0, 1], pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
      { n: [0, 0, -1], pts: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
      { n: [1, 0, 0], pts: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
      { n: [-1, 0, 0], pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    ];
    for (const f of faces) this.pushPolygon(f.pts, f.n, layer, tint, uvScale);
  }

  toFloat32Array() { return new Float32Array(this.verts); }
}

// A unit box centred at the origin, reused for every dynamic object and scaled
// per-draw — avoids rebuilding geometry for props and ragdoll bones each frame.
function buildUnitBox() {
  const b = new MeshBuilder();
  b.pushBox([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 0, [1, 1, 1], 1);
  return b.toFloat32Array();
}

function buildUnitSphere(segments = 12, rings = 8) {
  const b = new MeshBuilder();
  for (let r = 0; r < rings; r++) {
    const phi0 = (r / rings) * Math.PI, phi1 = ((r + 1) / rings) * Math.PI;
    for (let s = 0; s < segments; s++) {
      const th0 = (s / segments) * Math.PI * 2, th1 = ((s + 1) / segments) * Math.PI * 2;
      const p = (phi, th) => [Math.sin(phi) * Math.cos(th) * 0.5, Math.cos(phi) * 0.5, Math.sin(phi) * Math.sin(th) * 0.5];
      const quad = [p(phi0, th0), p(phi1, th0), p(phi1, th1), p(phi0, th1)];
      const n = norm(quad[0]);
      b.pushPolygon(quad, n, 0, [1, 1, 1], 1);
    }
  }
  return b.toFloat32Array();
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is required and not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;

    this.program = link(gl, VERT_SRC, FRAG_SRC);
    this.shadowProgram = link(gl, SHADOW_VERT_SRC, SHADOW_FRAG_SRC);

    this.uniforms = {};
    for (const name of ['uProj', 'uView', 'uModel', 'uLightVP', 'uTex', 'uShadow', 'uSunDir',
      'uSunColor', 'uAmbient', 'uCamPos', 'uFogColor', 'uFogDensity', 'uPointCount',
      'uPointPos', 'uPointColor', 'uPointRadius', 'uEmissive',
      'uTime', 'uHardShadow', 'uMatCount', 'uMatInfo', 'uMatScroll', 'uFocus', 'uViewDir']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    this.setupPixelPipeline();
    this.shadowUniforms = {
      uLightVP: gl.getUniformLocation(this.shadowProgram, 'uLightVP'),
      uModel: gl.getUniformLocation(this.shadowProgram, 'uModel'),
    };

    this.worldVAO = this.createVAO(new Float32Array(0));
    this.worldCount = 0;
    this.unitBox = this.createVAO(buildUnitBox());
    this.unitBoxCount = buildUnitBox().length / FLOATS_PER_VERT;
    this.unitSphere = this.createVAO(buildUnitSphere());
    this.unitSphereCount = buildUnitSphere().length / FLOATS_PER_VERT;

    this.dynamicBuffer = gl.createBuffer();
    this.dynamicVAO = this.createVAOFromBuffer(this.dynamicBuffer);

    this.setupShadowMap();

    this.texture = null;
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.lightVP = new Float32Array(16);
    this.model = m4identity(new Float32Array(16));
    this.scratch = new Float32Array(16);
    this.scratch2 = new Float32Array(16);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  createVAOFromBuffer(buffer) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);
    return vao;
  }

  createVAO(data) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const vao = this.createVAOFromBuffer(buffer);
    vao.buffer = buffer;
    return vao;
  }

  setupShadowMap() {
    const gl = this.gl;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    this.shadowFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setMaterials(materials) {
    if (this.texture) this.gl.deleteTexture(this.texture);
    if (materials.length > MAX_MATERIALS) {
      console.warn(`[fount] ${materials.length} materials: only the first ${MAX_MATERIALS} can animate or glow.`);
    }
    const built = buildTextureArray(this.gl, materials, this.texOptions);
    this.texture = built.texture;
    this.matCount = built.count;
    this.matInfo = built.info;
    this.matScroll = built.scroll;
    this.materials = materials;
  }

  setWorldMesh(float32) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.worldVAO.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, float32, gl.STATIC_DRAW);
    this.worldCount = float32.length / FLOATS_PER_VERT;
  }

  /**
   * Reading clientWidth forces a layout flush, so it runs only when the
   * element actually resized rather than on every single frame.
   */
  resize() {
    const canvas = this.canvas;
    if (this._sizeDirty !== false) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      this._aspect = canvas.width / Math.max(canvas.height, 1);
      this.viewportRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      if (this.pixel) {
        // The low-res frame is blown up by a whole number where it fits, so
        // every render pixel is the same size on screen; "fit" allows any scale.
        const [rw, rh] = this.pixel.resolution;
        let scale = Math.min(canvas.width / rw, canvas.height / rh);
        if (this.pixel.upscale !== 'fit' && scale >= 1) scale = Math.floor(scale);
        const vw = Math.max(1, Math.round(rw * scale)), vh = Math.max(1, Math.round(rh * scale));
        this.viewportRect = { x: Math.floor((canvas.width - vw) / 2), y: Math.floor((canvas.height - vh) / 2), w: vw, h: vh };
        this._aspect = rw / rh;
      }
      this._sizeDirty = false;

      if (!this._resizeHooked) {
        this._resizeHooked = true;
        const markDirty = () => { this._sizeDirty = true; };
        window.addEventListener('resize', markDirty);
        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(markDirty).observe(canvas);
        }
      }
    }
    return this._aspect;
  }

  computeLightMatrix(sunDir, bounds) {
    const center = mul(add(bounds.min, bounds.max), 0.5);
    const radius = Math.max(len(sub(bounds.max, bounds.min)) * 0.5, 10);
    const eye = sub(center, mul(norm(sunDir), radius * 2));
    m4lookAt(eye, center, [0, 1, 0], this.scratch);
    m4ortho(-radius, radius, -radius, radius, 0.1, radius * 4, this.scratch2);
    m4mul(this.scratch2, this.scratch, this.lightVP);
  }

  beginShadowPass() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.shadowProgram);
    gl.uniformMatrix4fv(this.shadowUniforms.uLightVP, false, this.lightVP);
    gl.cullFace(gl.FRONT); // front-face culling pushes peter-panning off surfaces
  }

  endShadowPass() {
    this.gl.cullFace(this.gl.BACK);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  beginFrame(camera, env, aspect) {
    const gl = this.gl;
    if (this.pixel) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO);
      gl.viewport(0, 0, this.pixel.resolution[0], this.pixel.resolution[1]);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    const sky = env.skyColor || [0.45, 0.55, 0.7];
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (camera.ortho) {
      // Orthographic: every ground texel is the same size on screen, which is
      // what keeps chunky pixel textures uniform instead of swimming with depth.
      const oh = camera.ortho.height, ow = oh * aspect;
      m4ortho(-ow / 2, ow / 2, -oh / 2, oh / 2, camera.near ?? 0.1, camera.far ?? 500, this.proj);
    } else {
      m4perspective(camera.fov || 75, aspect, camera.near ?? 0.05, camera.far ?? 500, this.proj);
    }
    m4lookAt(camera.position, add(camera.position, camera.forward), camera.up || [0, 1, 0], this.view);

    // Sprites billboard along the camera's own right and up.
    this.camRight = [this.view[0], this.view[4], this.view[8]];
    this.camUp = [this.view[1], this.view[5], this.view[9]];
    this.camPos = camera.position;
    this.spriteTilt = camera.spriteTilt ?? 0;
    this._env = env;
    this._worldSprites.count = 0;
    this._overlaySprites.count = 0;
    this._blobs.length = 0;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uProj, false, this.proj);
    gl.uniformMatrix4fv(this.uniforms.uView, false, this.view);
    gl.uniformMatrix4fv(this.uniforms.uLightVP, false, this.lightVP);
    gl.uniform3fv(this.uniforms.uSunDir, norm(env.sunDir || [-0.4, -0.8, -0.3]));
    gl.uniform3fv(this.uniforms.uSunColor, env.sunColor || [1.0, 0.96, 0.88]);
    gl.uniform3fv(this.uniforms.uAmbient, env.ambient || [0.32, 0.34, 0.4]);
    gl.uniform3fv(this.uniforms.uCamPos, camera.position);
    gl.uniform3fv(this.uniforms.uFogColor, env.fogColor || sky);
    gl.uniform1f(this.uniforms.uFogDensity, env.fogDensity ?? 0.012);
    gl.uniform1f(this.uniforms.uEmissive, 0);
    gl.uniform1f(this.uniforms.uTime, this.time || 0);
    gl.uniform1f(this.uniforms.uHardShadow, this.hardShadows ? 1 : 0);
    gl.uniform1f(this.uniforms.uMatCount, this.matCount || 1);
    if (this.matInfo) gl.uniform3fv(this.uniforms.uMatInfo, this.matInfo);
    if (this.matScroll) gl.uniform2fv(this.uniforms.uMatScroll, this.matScroll);
    const f = this.focus;
    gl.uniform4f(this.uniforms.uFocus, f ? f.pos[0] : 0, f ? f.pos[1] : 0, f ? f.pos[2] : 0, f ? f.radius : 0);
    const fd = camera.forward;
    gl.uniform3f(this.uniforms.uViewDir, -fd[0], -fd[1], -fd[2]);
    this.camPos = camera.position;

    const lights = (env.pointLights || []).slice(0, 16);
    this._lights = lights;
    gl.uniform1i(this.uniforms.uPointCount, lights.length);
    if (lights.length) {
      const pos = new Float32Array(lights.length * 3);
      const col = new Float32Array(lights.length * 3);
      const rad = new Float32Array(lights.length);
      lights.forEach((l, i) => {
        pos.set(l.position, i * 3);
        col.set(l.color, i * 3);
        rad[i] = l.radius;
      });
      gl.uniform3fv(this.uniforms.uPointPos, pos);
      gl.uniform3fv(this.uniforms.uPointColor, col);
      gl.uniform1fv(this.uniforms.uPointRadius, rad);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.uniform1i(this.uniforms.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.uniforms.uShadow, 1);
  }

  drawWorld(shadowPass = false) {
    const gl = this.gl;
    if (!this.worldCount) return;
    const loc = shadowPass ? this.shadowUniforms.uModel : this.uniforms.uModel;
    gl.uniformMatrix4fv(loc, false, m4identity(this.model));
    gl.bindVertexArray(this.worldVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.worldCount);
  }

  // Draws the unit box scaled/rotated into place. `basis` is an optional
  // rotation matrix (ragdoll bones use one built from the segment direction).
  drawBox(center, halfExtents, layer, tint = [1, 1, 1], basis = null, shadowPass = false) {
    const gl = this.gl;
    const m = this.model;
    if (basis) {
      m.set(basis);
      m[0] *= halfExtents[0] * 2; m[1] *= halfExtents[0] * 2; m[2] *= halfExtents[0] * 2;
      m[4] *= halfExtents[1] * 2; m[5] *= halfExtents[1] * 2; m[6] *= halfExtents[1] * 2;
      m[8] *= halfExtents[2] * 2; m[9] *= halfExtents[2] * 2; m[10] *= halfExtents[2] * 2;
    } else {
      m4identity(m);
      m[0] = halfExtents[0] * 2; m[5] = halfExtents[1] * 2; m[10] = halfExtents[2] * 2;
    }
    m[12] = center[0]; m[13] = center[1]; m[14] = center[2];

    if (shadowPass) {
      gl.uniformMatrix4fv(this.shadowUniforms.uModel, false, m);
    } else {
      gl.uniformMatrix4fv(this.uniforms.uModel, false, m);
      gl.vertexAttrib1f(3, layer);
      gl.vertexAttrib3f(4, tint[0], tint[1], tint[2]);
    }
    gl.bindVertexArray(this.unitBox);
    gl.disableVertexAttribArray(3);
    gl.disableVertexAttribArray(4);
    gl.vertexAttrib1f(3, layer);
    gl.vertexAttrib3f(4, tint[0], tint[1], tint[2]);
    gl.drawArrays(gl.TRIANGLES, 0, this.unitBoxCount);
    gl.enableVertexAttribArray(3);
    gl.enableVertexAttribArray(4);
  }

  drawSphere(center, radius, layer, tint = [1, 1, 1], shadowPass = false) {
    const gl = this.gl;
    const m = m4identity(this.model);
    m[0] = m[5] = m[10] = radius * 2;
    m[12] = center[0]; m[13] = center[1]; m[14] = center[2];
    if (shadowPass) {
      gl.uniformMatrix4fv(this.shadowUniforms.uModel, false, m);
    } else {
      gl.uniformMatrix4fv(this.uniforms.uModel, false, m);
    }
    gl.bindVertexArray(this.unitSphere);
    gl.disableVertexAttribArray(3);
    gl.disableVertexAttribArray(4);
    gl.vertexAttrib1f(3, layer);
    gl.vertexAttrib3f(4, tint[0], tint[1], tint[2]);
    gl.drawArrays(gl.TRIANGLES, 0, this.unitSphereCount);
    gl.enableVertexAttribArray(3);
    gl.enableVertexAttribArray(4);
  }

  // Orients a box along the segment a->b. Ragdoll limbs draw with this.
  drawSegment(a, b, thickness, layer, tint, shadowPass = false) {
    const delta = sub(b, a);
    const length = len(delta);
    // A NaN endpoint fails every `<` comparison, so an unguarded segment would
    // sail through a length check and rasterise as a screen-filling triangle.
    // Skipping the limb is always better than blotting out the whole view.
    if (!(length > 1e-5) || !Number.isFinite(length)) return;
    const center = mul(add(a, b), 0.5);
    const basis = m4basisFromDir(delta, this.scratch);
    this.drawBox(center, [thickness, length * 0.5, thickness], layer, tint, basis, shadowPass);
  }

  setEmissive(on) {
    this.gl.uniform1f(this.uniforms.uEmissive, on ? 1 : 0);
  }

  // ---------------------------------------------------------------------
  // Pixel-art pipeline
  // ---------------------------------------------------------------------

  setupPixelPipeline() {
    const gl = this.gl;
    this.pixel = null;
    this.hardShadows = false;
    this.texOptions = {};
    this.time = 0;
    this.viewportRect = { x: 0, y: 0, w: 1, h: 1 };
    this.spriteTilt = 0;
    this.spriteMinLight = 0.35;
    this.shadowColor = [0.45, 0.45, 0.55];
    this.fade = { alpha: 0, color: [0, 0, 0] };

    this.spriteProgram = link(gl, SPRITE_VERT_SRC, SPRITE_FRAG_SRC,
      ['aOrigin', 'aOffset', 'aUV', 'aColor', 'aFlash', 'aTilt']);
    this.spriteU = {};
    for (const n of ['uProj', 'uView', 'uLightVP', 'uRight', 'uCamUp', 'uRes', 'uSnap', 'uAtlas', 'uShadow',
      'uSunColor', 'uAmbient', 'uCamPos', 'uFogColor', 'uFogDensity', 'uSpriteMinLight',
      'uPointCount', 'uPointPos', 'uPointColor', 'uPointRadius']) {
      this.spriteU[n] = gl.getUniformLocation(this.spriteProgram, n);
    }
    this.blobProgram = link(gl, BLOB_VERT_SRC, BLOB_FRAG_SRC, ['aPos', 'aLocal', 'aAlpha']);
    this.blobU = {};
    for (const n of ['uProj', 'uView', 'uShadowColor']) this.blobU[n] = gl.getUniformLocation(this.blobProgram, n);
    this.postProgram = link(gl, FULLSCREEN_VERT_SRC, POST_FRAG_SRC, []);
    this.postU = {};
    for (const n of ['uScene', 'uRes', 'uPaletteCount', 'uPalette', 'uSpread', 'uLevels', 'uBayerBits']) {
      this.postU[n] = gl.getUniformLocation(this.postProgram, n);
    }
    this.fadeProgram = link(gl, FULLSCREEN_VERT_SRC, FADE_FRAG_SRC, []);
    this.fadeU = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') };
    this.emptyVAO = gl.createVertexArray();

    // Sprites and blobs are streamed into dynamic buffers once per frame.
    this.spriteBuffer = gl.createBuffer();
    this.spriteVAO = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuffer);
    const stride = SPRITE_FLOATS * 4;
    [[0, 3, 0], [1, 2, 12], [2, 2, 20], [3, 4, 28], [4, 1, 44], [5, 1, 48]].forEach(([loc, n, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off);
    });
    this.blobBuffer = gl.createBuffer();
    this.blobVAO = gl.createVertexArray();
    gl.bindVertexArray(this.blobVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.blobBuffer);
    [[0, 3, 0], [1, 2, 12], [2, 1, 20]].forEach(([loc, n, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 24, off);
    });
    gl.bindVertexArray(null);

    this._worldSprites = { data: new Float32Array(SPRITE_FLOATS * 6 * 512), count: 0 };
    this._overlaySprites = { data: new Float32Array(SPRITE_FLOATS * 6 * 256), count: 0 };
    this._blobs = [];

    // Built-in effects and the default font are always available.
    this.sprites = new SpriteLibrary();
    this.sprites.registerAll(BUILTIN_SPRITES);
    this.font = defaultFont();
    this.sprites.registerFont(this.font);
    this.atlasTexture = null;
    this.atlasVersion = -1;
  }

  /**
   * Apply a map's (or game's) "render" block. Passing null restores the
   * classic full-resolution, smooth-filtered renderer, so a game can mix
   * pixel-art maps with ordinary ones.
   */
  configure(cfg) {
    const gl = this.gl;
    cfg = cfg || {};
    this.renderCfg = cfg;

    const res = Array.isArray(cfg.resolution) && cfg.resolution[0] > 0 && cfg.resolution[1] > 0
      ? [cfg.resolution[0] | 0, cfg.resolution[1] | 0] : null;

    if (this.sceneFBO) {
      gl.deleteFramebuffer(this.sceneFBO);
      gl.deleteTexture(this.sceneTex);
      gl.deleteRenderbuffer(this.sceneDepth);
      this.sceneFBO = null;
    }
    this.pixel = null;
    if (res) {
      this.sceneTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res[0], res[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sceneDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, res[0], res[1]);
      this.sceneFBO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.sceneDepth);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error(`[fount] could not create a ${res[0]}x${res[1]} render target (status ${status}); falling back to full resolution`);
      } else {
        this.pixel = { resolution: res, upscale: cfg.upscale || 'integer', snap: cfg.pixelSnap !== false };
      }
    }

    // Palette: a list of colours the final frame is snapped to.
    this.paletteCount = 0;
    this.paletteData = new Float32Array(64 * 3);
    if (Array.isArray(cfg.palette) && cfg.palette.length) {
      if (cfg.palette.length > 64) console.warn(`[fount] palette has ${cfg.palette.length} colours; only the first 64 are used.`);
      cfg.palette.slice(0, 64).forEach((c, i) => {
        const [r, g, b] = parseColor(c);
        this.paletteData.set([r / 255, g / 255, b / 255], i * 3);
        this.paletteCount = i + 1;
      });
    }
    // Dither: false/0 off, a number is its strength, or { strength, size: 2|4|8 }.
    const d = cfg.dither;
    const hasQuantiser = this.paletteCount > 0 || cfg.levels > 1;
    const strength = d === false ? 0 : typeof d === 'number' ? d : (d && d.strength !== undefined ? d.strength : (hasQuantiser ? 0.5 : 0));
    const size = (d && typeof d === 'object' && d.size) || 4;
    this.dither = { strength, bits: Math.max(1, Math.min(3, Math.round(Math.log2(size)))) };
    this.levels = cfg.levels > 1 ? cfg.levels : 0;

    this.hardShadows = cfg.hardShadows ?? !!res;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    const sf = this.hardShadows ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sf);

    this.texOptions = {
      textureSize: cfg.textureSize,
      filter: cfg.filter || (res ? 'nearest' : 'linear'),
    };
    this.spriteMinLight = cfg.spriteMinLight ?? 0.35;
    if (cfg.shadowColor) this.shadowColor = cfg.shadowColor;
    this._sizeDirty = true;
  }

  setTime(seconds) { this.time = seconds; }

  /**
   * Keep a point visible through walls: scenery between the camera and `pos` is dithered away within
   * `radius` metres of the sight line. Pass null to turn it off. Floors at the point's own height stay.
   */
  setFocus(pos, radius = 2.2) { this.focus = pos ? { pos: [pos[0], pos[1], pos[2]], radius } : null; }

  setFade(alpha, color = [0, 0, 0]) { this.fade = { alpha, color }; }

  /** Cursor position in normalised device coordinates of the rendered image, or null in the letterbox bars. */
  clientToNdc(clientX, clientY) {
    const canvas = this.canvas;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const px = (clientX - r.left) * (canvas.width / r.width);
    const py = canvas.height - (clientY - r.top) * (canvas.height / r.height);
    const v = this.viewportRect;
    const x = ((px - v.x) / v.w) * 2 - 1;
    const y = ((py - v.y) / v.h) * 2 - 1;
    return { x, y, inside: Math.abs(x) <= 1 && Math.abs(y) <= 1 };
  }

  // ------------------------------------------------------------ sprites

  _spriteBatch(overlay) { return overlay ? this._overlaySprites : this._worldSprites; }

  _pushSpriteQuad(batch, ox, oy, oz, l, r, t, b, uv, flip, color, flash, tilt) {
    const need = (batch.count + 6) * SPRITE_FLOATS;
    if (need > batch.data.length) {
      const bigger = new Float32Array(Math.max(need, batch.data.length * 2));
      bigger.set(batch.data);
      batch.data = bigger;
    }
    const u0 = flip ? uv[2] : uv[0], u1 = flip ? uv[0] : uv[2];
    const v0 = uv[1], v1 = uv[3];
    const corners = [[l, t, u0, v0], [r, t, u1, v0], [r, b, u1, v1], [l, t, u0, v0], [r, b, u1, v1], [l, b, u0, v1]];
    const d = batch.data;
    let i = batch.count * SPRITE_FLOATS;
    for (const c of corners) {
      d[i++] = ox; d[i++] = oy; d[i++] = oz;
      d[i++] = c[0]; d[i++] = c[1];
      d[i++] = c[2]; d[i++] = c[3];
      d[i++] = color[0]; d[i++] = color[1]; d[i++] = color[2]; d[i++] = color[3];
      d[i++] = flash; d[i++] = tilt;
    }
    batch.count += 6;
  }

  /**
   * Queue one sprite frame, anchored at `pos` (the anchor is the point on the
   * sprite that sits there, normally the feet). Nothing is drawn until
   * endFrame(), when everything queued goes out in one call.
   * options: { sprite, scale, flip, tint, alpha, flash, tilt, overlay }
   */
  drawSpriteFrame(frameId, pos, options = {}) {
    const lib = this.sprites;
    const frame = lib.frames[frameId];
    if (!frame) return;
    const uv = lib.atlas().uv[frameId];
    const sprite = options.sprite;
    const ppu = sprite ? sprite.ppu : 16;
    const [ax, ay] = sprite ? sprite.anchor : [frame.w / 2, frame.h];
    const unit = (options.scale ?? 1) / ppu;
    const flip = !!options.flip;
    // A flipped frame keeps its anchor on the same world point.
    const l = -(flip ? frame.w - ax : ax) * unit;
    const r = l + frame.w * unit;
    const t = ay * unit;
    const b = t - frame.h * unit;
    const tint = options.tint || [1, 1, 1];
    this._pushSpriteQuad(this._spriteBatch(options.overlay), pos[0], pos[1], pos[2], l, r, t, b, uv, flip,
      [tint[0], tint[1], tint[2], options.alpha ?? 1], options.flash || 0, options.tilt ?? this.spriteTilt);
  }

  /**
   * Draw a named sprite by animation and frame number, for behaviours that do
   * their own animation. `extra` takes { dir, flash, alpha, overlay, tilt }.
   */
  drawSprite(name, anim, frame, pos, scale = 1, tint = null, shadowPass = false, extra = {}) {
    if (shadowPass) return; // sprites do not cast into the shadow map; use drawBlobShadow
    const sprite = this.sprites.get(name);
    if (!sprite) { this.sprites.warnOnce(`draw:${name}`, `drawSprite: no sprite named "${name}"`); return; }
    const a = sprite.anims[anim];
    if (!a) { this.sprites.warnOnce(`draw:${name}/${anim}`, `drawSprite: sprite "${name}" has no animation "${anim}"`); return; }
    const dir = extra.dir && a.ids[extra.dir] ? extra.dir : a.dirNames[0];
    const ids = a.ids[dir];
    this.drawSpriteFrame(ids[((frame % ids.length) + ids.length) % ids.length], pos, {
      sprite, scale, flip: a.flip[dir], tint: tint || undefined,
      alpha: extra.alpha, flash: extra.flash, tilt: extra.tilt, overlay: extra.overlay,
    });
  }

  /**
   * Bitmap-font text standing in the world. Faces the camera fully and, by
   * default, draws over geometry so a number is never hidden by a wall.
   * options: { scale, color, alpha, align: 'center'|'left'|'right', outline, shadow, overlay, font }
   */
  drawText(text, pos, options = {}) {
    const entry = this.sprites.fonts.get(options.font || this.font.name);
    if (!entry) return;
    const font = entry.font;
    const layout = font.layout(text);
    if (!layout.glyphs.length) return;
    const unit = (options.scale ?? 1) / (options.ppu ?? 16);
    const color = options.color || [1, 1, 1];
    const alpha = options.alpha ?? 1;
    const overlay = options.overlay !== false;
    const batch = this._spriteBatch(overlay);
    const align = options.align || 'center';
    const x0 = (align === 'left' ? 0 : align === 'right' ? -layout.width : -layout.width / 2) * unit;
    const atlas = this.sprites.atlas();
    const flash = options.flash || 0;

    const emit = (dx, dy, rgb) => {
      for (const g of layout.glyphs) {
        const id = entry.glyphs.get(g.ch) ?? entry.glyphs.get(g.ch.toUpperCase()) ?? entry.glyphs.get('?');
        if (id === undefined) continue;
        const l = x0 + (g.x + dx) * unit;
        const top = (layout.height - g.y + dy) * unit;
        this._pushSpriteQuad(batch, pos[0], pos[1], pos[2], l, l + g.glyph.w * unit, top, top - font.height * unit,
          atlas.uv[id], false, [rgb[0], rgb[1], rgb[2], alpha], flash, 1);
      }
    };
    // Under-layers first. The sprite pass uses LEQUAL, so the later (main)
    // layer wins the depth tie and lands on top of its own outline.
    if (options.outline) {
      const oc = Array.isArray(options.outline) ? options.outline : [0, 0, 0];
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) emit(dx, dy, oc);
    }
    if (options.shadow) emit(1, -1, Array.isArray(options.shadow) ? options.shadow : [0, 0, 0]);
    emit(0, 0, color);
  }

  /** A dithered dark disc on the ground under something. */
  drawBlobShadow(pos, radius, alpha = 0.7) {
    const y = pos[1] + 0.03;
    const x0 = pos[0] - radius, x1 = pos[0] + radius, z0 = pos[2] - radius, z1 = pos[2] + radius;
    const q = [[x0, z0, -1, -1], [x1, z0, 1, -1], [x1, z1, 1, 1], [x0, z0, -1, -1], [x1, z1, 1, 1], [x0, z1, -1, 1]];
    for (const c of q) this._blobs.push(c[0], y, c[1], c[2], c[3], alpha);
  }

  /**
   * A box with its texture tiled by world size, not stretched across each face
   * like drawBox. Moving brush entities (lava slabs, platforms) use this.
   */
  drawBrushBox(min, max, layer, tint = [1, 1, 1], uvScale = 0.5, shadowPass = false) {
    const gl = this.gl;
    if (!this._brushMesh) this._brushMesh = new MeshBuilder();
    const mb = this._brushMesh;
    mb.verts.length = 0;
    mb.pushBox(min, max, layer, tint, uvScale);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mb.verts), gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(shadowPass ? this.shadowUniforms.uModel : this.uniforms.uModel, false, m4identity(this.model));
    gl.bindVertexArray(this.dynamicVAO);
    gl.drawArrays(gl.TRIANGLES, 0, mb.vertexCount);
  }

  _uploadAtlas() {
    const gl = this.gl;
    const lib = this.sprites;
    if (this.atlasTexture && this.atlasVersion === lib.version) return;
    const atlas = lib.atlas();
    if (!this.atlasTexture) this.atlasTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasVersion = lib.version;
  }

  _flushBlobs() {
    if (!this._blobs.length) return;
    const gl = this.gl;
    gl.useProgram(this.blobProgram);
    gl.uniformMatrix4fv(this.blobU.uProj, false, this.proj);
    gl.uniformMatrix4fv(this.blobU.uView, false, this.view);
    gl.uniform3fv(this.blobU.uShadowColor, this.shadowColor);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.blobBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this._blobs), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.blobVAO);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);    // multiply over whatever ground is there
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -2);
    gl.drawArrays(gl.TRIANGLES, 0, this._blobs.length / 6);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  _flushSprites(batch, overlay) {
    if (!batch.count) return;
    const gl = this.gl;
    const u = this.spriteU;
    const env = this._env || {};
    gl.useProgram(this.spriteProgram);
    gl.uniformMatrix4fv(u.uProj, false, this.proj);
    gl.uniformMatrix4fv(u.uView, false, this.view);
    gl.uniformMatrix4fv(u.uLightVP, false, this.lightVP);
    gl.uniform3fv(u.uRight, this.camRight);
    gl.uniform3fv(u.uCamUp, this.camUp);
    const res = this.pixel ? this.pixel.resolution : [this.canvas.width, this.canvas.height];
    gl.uniform2f(u.uRes, res[0], res[1]);
    gl.uniform1f(u.uSnap, this.pixel && this.pixel.snap ? 1 : 0);
    gl.uniform3fv(u.uSunColor, env.sunColor || [1.0, 0.96, 0.88]);
    gl.uniform3fv(u.uAmbient, env.ambient || [0.32, 0.34, 0.4]);
    gl.uniform3fv(u.uCamPos, this.camPos);
    gl.uniform3fv(u.uFogColor, env.fogColor || env.skyColor || [0.45, 0.55, 0.7]);
    gl.uniform1f(u.uFogDensity, env.fogDensity ?? 0.012);
    gl.uniform1f(u.uSpriteMinLight, this.spriteMinLight);
    const lights = this._lights || [];
    gl.uniform1i(u.uPointCount, lights.length);
    if (lights.length) {
      const pos = new Float32Array(lights.length * 3), col = new Float32Array(lights.length * 3), rad = new Float32Array(lights.length);
      lights.forEach((l, i) => { pos.set(l.position, i * 3); col.set(l.color, i * 3); rad[i] = l.radius; });
      gl.uniform3fv(u.uPointPos, pos);
      gl.uniform3fv(u.uPointColor, col);
      gl.uniform1fv(u.uPointRadius, rad);
    }
    gl.uniform1i(u.uAtlas, 2);
    gl.uniform1i(u.uShadow, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    this._uploadAtlas();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.count * SPRITE_FLOATS), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.spriteVAO);
    gl.disable(gl.CULL_FACE);
    // LEQUAL so the last-queued of two coplanar sprites (text over its own outline) wins.
    gl.depthFunc(gl.LEQUAL);
    if (overlay) gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    if (overlay) gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    batch.count = 0;
  }

  /**
   * Finish the frame: draw everything queued (ground blobs, sprites, overlay
   * text), then, if this map renders at low resolution, blow the frame up to the
   * canvas through the palette and dither pass. Call once, after all drawing.
   */
  endFrame() {
    const gl = this.gl;
    this._flushBlobs();
    this._flushSprites(this._worldSprites, false);
    this._flushSprites(this._overlaySprites, true);

    gl.bindVertexArray(null);
    if (this.pixel) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const v = this.viewportRect;
      gl.viewport(v.x, v.y, v.w, v.h);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.postProgram);
      const p = this.postU;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.uniform1i(p.uScene, 0);
      gl.uniform2f(p.uRes, this.pixel.resolution[0], this.pixel.resolution[1]);
      gl.uniform1i(p.uPaletteCount, this.paletteCount);
      gl.uniform3fv(p.uPalette, this.paletteData);
      // Palette steps are far coarser than level steps, so strength means
      // "about one palette step" here and "one level step" in levels mode.
      gl.uniform1f(p.uSpread, this.paletteCount ? this.dither.strength * 0.35 : this.dither.strength);
      gl.uniform1f(p.uLevels, this.levels);
      gl.uniform1i(p.uBayerBits, this.dither.bits);
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    if (this.fade.alpha > 0.001) {
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.fadeProgram);
      const c = this.fade.color;
      gl.uniform4f(this.fadeU.uFade, c[0], c[1], c[2], Math.min(1, this.fade.alpha));
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
    }
  }
}
