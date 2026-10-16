// One clock for the whole world: day and night, seasons and tides, all derived
// from a single number, the world time in seconds. Online that number comes
// from the server in every snapshot, so every player in an instance sees the
// same hour, the same season and the same water level, with nothing else to
// synchronise. Offline it is just the game's own running time.
//
// Configure in the game config:
//   "clock": {
//     "dayLength": 600,                  seconds from dawn to dawn
//     "startHour": 8,                    the hour at world time 0
//     "seasons": ["spring", "summer", "autumn", "winter"],
//     "seasonLength": 3,                 days per season
//     "tidePeriod": 240                  seconds from high tide to high tide
//   }
//
//   const c = game.clock.sample();
//   c.hour 0..24   c.dayFraction 0..1   c.daylight 0..1 (0 at midnight, 1 at noon)   c.isNight
//   c.day (whole days since 0)   c.season 'summer'   c.seasonIndex   c.seasonProgress 0..1
//   c.tide -1..1 (1 = high)
//
// game.clock.lighting(env) tints an environment for the hour; a game that wants its own look
// listens for the 'hour-changed' / 'season-changed' / 'day-changed' events instead.

const DEFAULTS = { dayLength: 600, startHour: 8, seasons: ['spring', 'summer', 'autumn', 'winter'], seasonLength: 3, tidePeriod: 240 };

const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

export class WorldClock {
  /** `source` is a function returning the world time in seconds. */
  constructor(config = {}, source = () => 0) {
    this.config = { ...DEFAULTS, ...config };
    this.source = source;
    this.last = null;
    this.listeners = [];
  }

  configure(config) { this.config = { ...DEFAULTS, ...(config || {}) }; this.last = null; }

  /** Everything derivable from a world time (seconds). Pure: the same time always gives the same answer. */
  sample(t = this.source()) {
    const c = this.config;
    const days = t / c.dayLength + c.startHour / 24;
    const day = Math.floor(days);
    const dayFraction = days - day;
    const hour = dayFraction * 24;
    // Noon is brightest and midnight darkest, with a soft dawn and dusk: a cosine stretched so the sun is up a little over half the day.
    const daylight = Math.min(1, Math.max(0, 0.5 + 0.7 * Math.cos((dayFraction - 0.5) * Math.PI * 2)));
    const seasonDays = Math.max(1, c.seasonLength);
    const seasonCount = Math.max(1, c.seasons.length);
    const seasonFloat = (day / seasonDays) % seasonCount;
    const seasonIndex = Math.floor(seasonFloat);
    return {
      time: t, day, hour, dayFraction, daylight, isNight: daylight < 0.25,
      season: c.seasons[seasonIndex] ?? null, seasonIndex, seasonProgress: seasonFloat - seasonIndex,
      year: Math.floor(day / (seasonDays * seasonCount)),
      tide: Math.cos((t / c.tidePeriod) * Math.PI * 2),
    };
  }

  /** Call once a frame: raises hour-changed, day-changed and season-changed when they tick over. */
  update(emit) {
    const s = this.sample();
    const prev = this.last;
    this.last = s;
    if (!prev || !emit) return s;
    if (Math.floor(s.hour) !== Math.floor(prev.hour)) emit('hour-changed', s);
    if (s.day !== prev.day) emit('day-changed', s);
    if (s.season !== prev.season) emit('season-changed', s);
    return s;
  }

  /**
   * An environment for the current hour: the sun swings overhead by day, and sun colour, ambient and sky
   * move between night and day values. Returns a new object; `base` supplies anything it does not change.
   */
  lighting(base = {}, s = this.sample()) {
    const day = {
      sunColor: base.sunColor || [1.0, 0.96, 0.88], ambient: base.ambient || [0.32, 0.34, 0.4], sky: base.skyColor || [0.45, 0.55, 0.7],
    };
    const night = { sunColor: [0.18, 0.2, 0.38], ambient: [0.1, 0.11, 0.2], sky: [0.04, 0.05, 0.12] };
    const d = s.daylight;
    const angle = s.dayFraction * Math.PI * 2;
    return {
      ...base,
      sunColor: mix3(night.sunColor, day.sunColor, d),
      ambient: mix3(night.ambient, day.ambient, d),
      skyColor: mix3(night.sky, day.sky, d),
      sunDir: [Math.sin(angle) * 0.5, -Math.max(0.25, Math.abs(Math.cos(angle - Math.PI))), -0.35],
    };
  }
}
