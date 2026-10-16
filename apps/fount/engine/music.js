// Music as text, in the same spirit as sounds and sprites: a tracker-style
// sequencer whose songs are JSON. Notes are synthesised with the browser's
// oscillators, so a game ships a soundtrack with no audio files.
//
//   "music": {
//     "songs": {
//       "town": {
//         "bpm": 96, "stepsPerBeat": 4, "loop": true,
//         "channels": [
//           { "wave": "triangle", "volume": 0.35,
//             "pattern": ["C3","-","-","-","G2","-","-","-","A2","-","-","-","F2","-","-","-"] },
//           { "wave": "square", "volume": 0.18, "duty": 0.25,
//             "patterns": { "a": ["E4",".","G4",".","C5","-",".","."], "b": ["D4",".","F4",".","B4","-",".","."] },
//             "order": ["a","a","b","a"] }
//         ]
//       }
//     }
//   }
//
// A pattern step is a note ("C4", "F#3", "Bb2") which sounds and holds, "-" to keep holding it, "." for a rest.
// A channel is either one flat `pattern` or named `patterns` strung together by `order`. Channels of different
// lengths loop independently, so a short bass line can underlie a long melody.
//
//   game.music.play('town')       game.music.play('battle', { fade: 1.5 })       game.music.stop({ fade: 2 })
//
// The Sequencer below is pure scheduling (no audio, no clock of its own): feed it the current time and it
// says which notes start in the next stretch. That is what the tests exercise; MusicPlayer wires it to Web Audio.

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" -> 440. Accepts sharps (#) and flats (b). Returns null for anything that is not a note. */
export function noteFrequency(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(name));
  if (!m) return null;
  let n = NOTE_INDEX[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  n += (parseInt(m[3], 10) + 1) * 12;               // MIDI number
  return 440 * Math.pow(2, (n - 69) / 12);
}

function flatten(channel) {
  if (Array.isArray(channel.pattern)) return channel.pattern;
  const out = [];
  const patterns = channel.patterns || {};
  for (const name of channel.order || Object.keys(patterns)) {
    if (!patterns[name]) throw new Error(`music: channel has no pattern "${name}"`);
    out.push(...patterns[name]);
  }
  return out;
}

/** Check a song and return the problems found (an empty list means it is fine). */
export function validateSong(song) {
  const problems = [];
  if (!(song.bpm > 0)) problems.push('"bpm" must be a positive number');
  if (!Array.isArray(song.channels) || !song.channels.length) problems.push('a song needs "channels"');
  (song.channels || []).forEach((ch, i) => {
    let steps;
    try { steps = flatten(ch); } catch (err) { problems.push(`channel ${i}: ${err.message}`); return; }
    if (!steps.length) problems.push(`channel ${i}: no steps`);
    steps.forEach((s, k) => {
      if (s !== '-' && s !== '.' && noteFrequency(s) === null) problems.push(`channel ${i} step ${k}: "${s}" is not a note, "-" or "."`);
    });
  });
  return problems;
}

export class Sequencer {
  constructor(song) {
    const problems = validateSong(song);
    if (problems.length) throw new Error(`Bad song:\n  ${problems.join('\n  ')}`);
    this.song = song;
    this.stepSeconds = 60 / song.bpm / (song.stepsPerBeat || 4);
    this.channels = song.channels.map((c) => ({ steps: flatten(c), wave: c.wave || 'square', volume: c.volume ?? 0.25, duty: c.duty ?? 0.5, next: 0, held: null }));
    this.loop = song.loop !== false;
    this.startedAt = 0;
    this.length = Math.max(...this.channels.map((c) => c.steps.length));
    this.done = false;
  }

  start(time) { this.startedAt = time; for (const c of this.channels) { c.next = 0; } this.done = false; }

  /**
   * Every note that starts before `until` (an absolute time, in seconds) and has not been handed out yet:
   * [{ at, freq, duration, wave, volume, duty, channel }]. A note lasts until the next note or rest on its channel.
   */
  collect(until) {
    const out = [];
    this.channels.forEach((c, ci) => {
      const n = c.steps.length;
      for (;;) {
        const at = this.startedAt + c.next * this.stepSeconds;
        if (at >= until) break;
        if (!this.loop && c.next >= n) break;
        const step = c.steps[c.next % n];
        if (step !== '-' && step !== '.') {
          // A note lasts through the "-" steps that follow it (wrapping around if the pattern loops).
          let held = 1;
          for (let k = 1; k < n && c.steps[(c.next + k) % n] === '-' && (this.loop || c.next + k < n); k++) held++;
          out.push({ at, freq: noteFrequency(step), duration: held * this.stepSeconds, wave: c.wave, volume: c.volume, duty: c.duty, channel: ci });
        }
        c.next++;
      }
    });
    if (!this.loop && this.channels.every((c) => c.next >= c.steps.length)) this.done = true;
    return out;
  }
}

/**
 * Plays songs through Web Audio. `tone(note)` is how a note is actually sounded (audio.js provides it); tests pass their own.
 * The scheduler looks ahead a quarter of a second, so a busy main thread does not make the music stutter.
 */
export class MusicPlayer {
  constructor({ songs = {}, tone, now, setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (id) => clearInterval(id) } = {}) {
    this.songs = songs;
    this.tone = tone;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.current = null;
    this.timer = null;
    this.volume = 1;
    this.lookahead = 0.25;
  }

  define(name, song) { this.songs[name] = song; }
  get playing() { return this.current ? this.current.name : null; }

  play(name, options = {}) {
    if (this.current && this.current.name === name && !options.restart) return true;
    const song = this.songs[name];
    if (!song) return false;
    const seq = new Sequencer(song);
    const t = this.now();
    seq.start(t + 0.05);
    // A fade-in is a volume ramp over the first seconds; the old song fades out over the same time.
    const fade = options.fade ?? 0;
    if (this.current && fade > 0) this.current.fadeOut = { from: t, seconds: fade };
    else this.current = null;
    this.old = this.current;
    this.current = { name, seq, fadeIn: fade > 0 ? { from: t, seconds: fade } : null, fadeOut: null };
    this.ensureTimer();
    this.pump();
    return true;
  }

  stop(options = {}) {
    if (!this.current) return;
    if ((options.fade ?? 0) > 0) this.current.fadeOut = { from: this.now(), seconds: options.fade };
    else { this.current = null; this.old = null; this.clearTimer(this.timer); this.timer = null; }
  }

  ensureTimer() { if (!this.timer) this.timer = this.setTimer(() => this.pump(), 50); }

  level(track, t) {
    let v = this.volume;
    if (track.fadeIn) v *= Math.min(1, (t - track.fadeIn.from) / track.fadeIn.seconds);
    if (track.fadeOut) v *= Math.max(0, 1 - (t - track.fadeOut.from) / track.fadeOut.seconds);
    return Math.max(0, v);
  }

  pump() {
    const t = this.now();
    for (const key of ['old', 'current']) {
      const track = this[key];
      if (!track) continue;
      for (const note of track.seq.collect(t + this.lookahead)) {
        const v = this.level(track, note.at);
        if (v > 0) this.tone({ ...note, volume: note.volume * v });
      }
      if (track.fadeOut && t - track.fadeOut.from >= track.fadeOut.seconds) {
        if (key === 'old') this.old = null; else { this.current = null; }
      }
      if (track.seq.done) { if (key === 'current') this.current = null; else this.old = null; }
    }
    if (!this.current && !this.old) { this.clearTimer(this.timer); this.timer = null; }
  }
}
