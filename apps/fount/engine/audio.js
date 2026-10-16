// All sound is synthesised at runtime from numbers in JSON. No .wav files,
// which is what lets Claude author a complete game as text — and keeps the
// repo free of binary assets nobody can diff or review.

let ctx = null;
let master = null;
let noiseBuffer = null;
let enabled = true;
const warnedSounds = new Set();

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { enabled = false; return null; }
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  const frames = ctx.sampleRate * 2;
  noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

// Browsers suspend audio until a user gesture; call this from a click/keydown.
export function unlockAudio() {
  const c = ensureContext();
  if (c && c.state === 'suspended') c.resume();
}

export function setMasterVolume(v) {
  ensureContext();
  if (master) master.gain.value = v;
}

function noiseSource(duration, filterType, freq, q = 1) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = freq;
  filter.Q.value = q;
  src.connect(filter);
  return { src, out: filter, duration };
}

function envGain(attack, decay, peak = 1) {
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function playTone({ freq = 440, endFreq = null, type = 'sine', attack = 0.005, decay = 0.2, gain = 0.5 }) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t + attack + decay);
  const g = envGain(attack, decay, gain);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + attack + decay + 0.02);
}

function playNoise({ freq = 1000, filter = 'lowpass', q = 1, attack = 0.002, decay = 0.15, gain = 0.5, sweepTo = null }) {
  const t = ctx.currentTime;
  const { src, out } = noiseSource(attack + decay, filter, freq, q);
  if (sweepTo !== null) out.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 20), t + attack + decay);
  const g = envGain(attack, decay, gain);
  out.connect(g).connect(master);
  src.start(t);
  src.stop(t + attack + decay + 0.02);
}

// Named presets keep map/entity JSON readable: "sound": "shoot" beats a wall
// of synthesis parameters in every entity that fires a weapon.
const PRESETS = {
  shoot() {
    playNoise({ freq: 2200, filter: 'bandpass', q: 0.8, attack: 0.001, decay: 0.09, gain: 0.55, sweepTo: 400 });
    playTone({ freq: 180, endFreq: 50, type: 'square', attack: 0.001, decay: 0.08, gain: 0.35 });
  },
  shotgun() {
    playNoise({ freq: 1400, filter: 'bandpass', q: 0.5, attack: 0.001, decay: 0.22, gain: 0.7, sweepTo: 180 });
    playTone({ freq: 110, endFreq: 35, type: 'square', attack: 0.002, decay: 0.18, gain: 0.4 });
  },
  impact() {
    playNoise({ freq: 3200, filter: 'highpass', q: 1, attack: 0.001, decay: 0.05, gain: 0.3, sweepTo: 900 });
  },
  hurt() {
    playTone({ freq: 320, endFreq: 140, type: 'sawtooth', attack: 0.005, decay: 0.22, gain: 0.4 });
  },
  die() {
    playTone({ freq: 260, endFreq: 60, type: 'sawtooth', attack: 0.01, decay: 0.55, gain: 0.45 });
    playNoise({ freq: 700, filter: 'lowpass', attack: 0.01, decay: 0.5, gain: 0.3, sweepTo: 120 });
  },
  step() {
    playNoise({ freq: 520, filter: 'lowpass', attack: 0.002, decay: 0.06, gain: 0.14, sweepTo: 200 });
  },
  land() {
    playNoise({ freq: 380, filter: 'lowpass', attack: 0.002, decay: 0.12, gain: 0.3, sweepTo: 110 });
  },
  jump() {
    playTone({ freq: 300, endFreq: 460, type: 'sine', attack: 0.004, decay: 0.09, gain: 0.18 });
  },
  explosion() {
    playNoise({ freq: 900, filter: 'lowpass', attack: 0.005, decay: 0.9, gain: 0.9, sweepTo: 60 });
    playTone({ freq: 90, endFreq: 28, type: 'square', attack: 0.005, decay: 0.7, gain: 0.5 });
  },
  pickup() {
    playTone({ freq: 620, endFreq: 980, type: 'triangle', attack: 0.004, decay: 0.14, gain: 0.3 });
  },
  door() {
    playNoise({ freq: 260, filter: 'lowpass', q: 2, attack: 0.05, decay: 0.7, gain: 0.22, sweepTo: 130 });
  },
  button() {
    playTone({ freq: 880, endFreq: 660, type: 'square', attack: 0.002, decay: 0.07, gain: 0.2 });
  },
  ragdoll() {
    playNoise({ freq: 420, filter: 'lowpass', attack: 0.002, decay: 0.13, gain: 0.28, sweepTo: 120 });
  },

  // --- RPG set: melee, magic, UI and monsters -------------------------------
  swing() {
    playNoise({ freq: 900, filter: 'bandpass', q: 1.2, attack: 0.01, decay: 0.12, gain: 0.3, sweepTo: 2600 });
  },
  hit() {
    playNoise({ freq: 1500, filter: 'bandpass', q: 0.9, attack: 0.001, decay: 0.07, gain: 0.5, sweepTo: 300 });
    playTone({ freq: 140, endFreq: 60, type: 'square', attack: 0.001, decay: 0.07, gain: 0.3 });
  },
  crit() {
    playNoise({ freq: 2600, filter: 'bandpass', q: 0.8, attack: 0.001, decay: 0.1, gain: 0.55, sweepTo: 400 });
    playTone({ freq: 220, endFreq: 70, type: 'square', attack: 0.001, decay: 0.12, gain: 0.35 });
    playTone({ freq: 880, endFreq: 1320, type: 'triangle', attack: 0.002, decay: 0.09, gain: 0.18 });
  },
  cast() {
    playTone({ freq: 330, endFreq: 760, type: 'triangle', attack: 0.02, decay: 0.28, gain: 0.25 });
    playNoise({ freq: 2200, filter: 'highpass', attack: 0.02, decay: 0.2, gain: 0.08, sweepTo: 5000 });
  },
  heal() {
    playTone({ freq: 523, type: 'sine', attack: 0.01, decay: 0.16, gain: 0.22 });
    setTimeout(() => ctx && playTone({ freq: 784, type: 'sine', attack: 0.01, decay: 0.22, gain: 0.22 }), 90);
  },
  portal() {
    playNoise({ freq: 300, filter: 'bandpass', q: 3, attack: 0.15, decay: 0.7, gain: 0.3, sweepTo: 2400 });
    playTone({ freq: 180, endFreq: 640, type: 'sine', attack: 0.15, decay: 0.6, gain: 0.22 });
  },
  click() {
    playTone({ freq: 1100, endFreq: 800, type: 'square', attack: 0.001, decay: 0.03, gain: 0.14 });
  },
  enemyhurt() {
    playTone({ freq: 210, endFreq: 95, type: 'sawtooth', attack: 0.004, decay: 0.16, gain: 0.32 });
  },
  enemydie() {
    playTone({ freq: 190, endFreq: 40, type: 'sawtooth', attack: 0.01, decay: 0.45, gain: 0.38 });
    playNoise({ freq: 500, filter: 'lowpass', attack: 0.01, decay: 0.35, gain: 0.22, sweepTo: 90 });
  },
  error() {
    playTone({ freq: 160, endFreq: 120, type: 'square', attack: 0.002, decay: 0.12, gain: 0.2 });
  },
  levelup() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => ctx && playTone({ freq: f, type: 'triangle', attack: 0.005, decay: 0.2, gain: 0.25 }), i * 85));
  },
};

export function playSound(name, volumeScale = 1) {
  if (!enabled) return;
  const c = ensureContext();
  if (!c || c.state !== 'running') return;
  const preset = PRESETS[name];
  if (!preset) {
    // A typo'd sound name should be loud once, not silent forever.
    if (!warnedSounds.has(name)) { warnedSounds.add(name); console.warn(`[fount] no sound preset "${name}" (have: ${Object.keys(PRESETS).join(', ')})`); }
    return;
  }
  const prev = master.gain.value;
  master.gain.value = prev * volumeScale;
  try { preset(); } finally { master.gain.value = prev; }
}

// Falls off with distance so a distant gunshot doesn't sound point-blank.
export function playSoundAt(name, soundPos, listenerPos, maxDist = 40) {
  const dx = soundPos[0] - listenerPos[0];
  const dy = soundPos[1] - listenerPos[1];
  const dz = soundPos[2] - listenerPos[2];
  const d = Math.hypot(dx, dy, dz);
  if (d > maxDist) return;
  playSound(name, Math.max(0, 1 - d / maxDist) ** 1.5);
}

export const soundNames = Object.keys(PRESETS);
