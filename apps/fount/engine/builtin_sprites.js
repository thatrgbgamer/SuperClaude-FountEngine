// Effects every game ends up wanting, defined as text sprites like any other so
// particle presets and emotes work with no art at all. They are white or
// greyscale on purpose: a particle's colour comes from the tint, so one spark
// sprite serves fire, frost and holy light alike. A game can override any of
// them by registering a sprite with the same name.

const centered = (w, h) => [w / 2, h / 2];

export const BUILTIN_SPRITES = [
  {
    name: 'fx_px',
    size: [1, 1],
    anchor: centered(1, 1),
    ppu: 16,
    palette: { '#': '#ffffff' },
    animations: { idle: { fps: 1, frames: [['#']] } },
  },
  {
    name: 'fx_spark',
    size: [3, 3],
    anchor: centered(3, 3),
    ppu: 16,
    palette: { '#': '#ffffff' },
    animations: { idle: { fps: 10, frames: [['.#.', '###', '.#.'], ['#.#', '.#.', '#.#']] } },
  },
  {
    name: 'fx_glow',
    size: [5, 5],
    anchor: centered(5, 5),
    ppu: 16,
    palette: { '#': '#ffffff', o: '#b8b8b8' },
    animations: {
      idle: {
        fps: 8,
        frames: [
          ['.ooo.', 'o###o', 'o###o', 'o###o', '.ooo.'],
          ['.....', '.###.', '.###.', '.###.', '.....'],
          ['.....', '.....', '..#..', '.....', '.....'],
        ],
      },
    },
  },
  {
    name: 'fx_smoke',
    size: [5, 5],
    anchor: centered(5, 5),
    ppu: 16,
    palette: { '#': '#d0d0d0', o: '#909090' },
    animations: {
      idle: {
        fps: 6,
        frames: [
          ['.....', '.##..', '.###.', '..#..', '.....'],
          ['.###.', '#####', '#####', '.###.', '.....'],
          ['.o.o.', 'o...o', '.....', 'o...o', '.o.o.'],
        ],
      },
    },
  },
  {
    name: 'fx_fire',
    size: [5, 7],
    anchor: [2.5, 6],
    ppu: 16,
    palette: { r: '#d03010', o: '#f08020', y: '#ffd040' },
    animations: {
      idle: {
        fps: 9,
        frames: [
          ['..y..', '.yoy.', '.yoy.', 'yooor', 'orror', '.rrr.', '..r..'],
          ['.y...', '.yo..', '.yoy.', 'yooyr', 'orror', '.rrr.', '..r..'],
          ['..y..', '..yo.', '.yoy.', '.yoor', 'orror', '.rrr.', '..r..'],
        ],
      },
    },
  },
  {
    name: 'fx_orb',
    size: [7, 7],
    anchor: centered(7, 7),
    ppu: 16,
    palette: { '#': '#ffffff', o: '#b0b0b0' },
    animations: {
      idle: {
        fps: 8,
        frames: [
          ['..ooo..', '.o###o.', 'o#####o', 'o#####o', 'o#####o', '.o###o.', '..ooo..'],
          ['...o...', '..o#o..', '.o###o.', 'o#####o', '.o###o.', '..o#o..', '...o...'],
        ],
      },
    },
  },
  {
    name: 'fx_heal',
    size: [5, 5],
    anchor: centered(5, 5),
    ppu: 16,
    palette: { '#': '#ffffff' },
    animations: {
      idle: {
        fps: 6,
        frames: [
          ['..#..', '..#..', '#####', '..#..', '..#..'],
          ['.....', '..#..', '.###.', '..#..', '.....'],
        ],
      },
    },
  },
  {
    // The "!" that pops over a monster when it notices you.
    name: 'fx_exclaim',
    size: [3, 7],
    anchor: [1.5, 7],
    ppu: 16,
    palette: { '#': '#ffd040', k: '#a04010' },
    animations: {
      idle: { fps: 1, frames: [['###', '###', '###', 'k#k', '.k.', '...', '.#.']] },
    },
  },
];
