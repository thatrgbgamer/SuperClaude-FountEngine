// A bitmap font defined as text, the same pixel-grid idea as sprites. The one
// definition feeds three places: floating damage numbers in the world (as
// glyph quads from the sprite atlas), canvases for the HTML UI, and the
// <fount-text> element, so in-world and on-screen text always match.
//
// GL- and DOM-free; rasterize() returns plain RGBA bytes.

// 5x7 glyphs, rows joined with "/". "#" is ink. The built-in font is
// upper-case only: lower-case letters draw as capitals, which is the right look
// for the genre and halves the table. A game that wants real lower-case can
// register its own font in this same format.
const GLYPHS_5X7 = {
  ' ': '...../...../...../...../...../...../.....',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '.###./#...#/....#/..##./....#/#...#/.###.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  'A': '.###./#...#/#...#/#####/#...#/#...#/#...#',
  'B': '####./#...#/#...#/####./#...#/#...#/####.',
  'C': '.###./#...#/#..../#..../#..../#...#/.###.',
  'D': '####./#...#/#...#/#...#/#...#/#...#/####.',
  'E': '#####/#..../#..../####./#..../#..../#####',
  'F': '#####/#..../#..../####./#..../#..../#....',
  'G': '.###./#...#/#..../#.###/#...#/#...#/.####',
  'H': '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  'I': '.###./..#../..#../..#../..#../..#../.###.',
  'J': '..###/...#./...#./...#./...#./#..#./.##..',
  'K': '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  'L': '#..../#..../#..../#..../#..../#..../#####',
  'M': '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  'N': '#...#/#...#/##..#/#.#.#/#..##/#...#/#...#',
  'O': '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  'P': '####./#...#/#...#/####./#..../#..../#....',
  'Q': '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  'R': '####./#...#/#...#/####./#.#../#..#./#...#',
  'S': '.####/#..../#..../.###./....#/....#/####.',
  'T': '#####/..#../..#../..#../..#../..#../..#..',
  'U': '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  'V': '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  'W': '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  'X': '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  'Y': '#...#/#...#/.#.#./..#../..#../..#../..#..',
  'Z': '#####/....#/...#./..#../.#.../#..../#####',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  '.': '...../...../...../...../...../.##../.##..',
  ',': '...../...../...../...../.##../..#../.#...',
  ':': '...../.##../.##../...../.##../.##../.....',
  ';': '...../.##../.##../...../.##../..#../.#...',
  '-': '...../...../...../#####/...../...../.....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.',
  ']': '.###./...#./...#./...#./...#./...#./.###.',
  "'": '..#../..#../.#.../...../...../...../.....',
  '"': '.#.#./.#.#./...../...../...../...../.....',
  '*': '...../#.#.#/.###./#####/.###./#.#.#/.....',
  '=': '...../...../#####/...../#####/...../.....',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  '_': '...../...../...../...../...../...../#####',
  '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  '@': '.###./#...#/#.###/#.#.#/#.##./#..../.###.',
  '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#',
  '$': '..#../.####/#.#../.###./..#.#/####./..#..',
};

export const DEFAULT_FONT_DEF = {
  name: 'fount5x7',
  size: [5, 7],
  advance: 6,
  lineHeight: 9,
  upperCaseFallback: true,
  glyphs: GLYPHS_5X7,
};

export class BitmapFont {
  constructor(def = DEFAULT_FONT_DEF) {
    this.name = def.name;
    this.height = def.size[1];
    this.cellWidth = def.size[0];
    this.advance = def.advance ?? this.cellWidth + 1;
    this.lineHeight = def.lineHeight ?? this.height + 2;
    this.upperCaseFallback = def.upperCaseFallback !== false;
    this.glyphs = new Map();

    for (const [ch, spec] of Object.entries(def.glyphs || {})) {
      const rows = Array.isArray(spec) ? spec : String(spec).split('/');
      if (rows.length !== this.height) {
        throw new Error(`font "${this.name}" glyph "${ch}" has ${rows.length} rows, expected ${this.height}`);
      }
      const w = rows[0].length;
      if (rows.some((r) => r.length !== w)) throw new Error(`font "${this.name}" glyph "${ch}" has rows of different widths`);
      this.glyphs.set(ch, { w, rows });
    }
    this.missing = this.glyphs.get('?') || this.glyphs.get(' ');
  }

  glyph(ch) {
    let g = this.glyphs.get(ch);
    if (!g && this.upperCaseFallback) g = this.glyphs.get(ch.toUpperCase());
    return g || this.missing;
  }

  /** Characters of `text` with their pixel position, laid out on lines. */
  layout(text) {
    const out = [];
    let x = 0, line = 0, width = 0;
    for (const ch of String(text)) {
      if (ch === '\n') { line++; x = 0; continue; }
      const g = this.glyph(ch);
      out.push({ ch, x, y: line * this.lineHeight, glyph: g });
      x += g.w === this.cellWidth ? this.advance : g.w + 1;
      width = Math.max(width, x - 1);
    }
    return { glyphs: out, width: Math.max(width, 0), height: (line + 1) * this.lineHeight - (this.lineHeight - this.height) };
  }

  measure(text, scale = 1) {
    const l = this.layout(text);
    return { width: l.width * scale, height: l.height * scale };
  }

  /**
   * Draw text into an RGBA pixel buffer. `shadow` and `outline` are optional
   * colours; they widen the result by a pixel so the caller can size to fit.
   */
  rasterize(text, options = {}) {
    const scale = Math.max(1, options.scale | 0 || 1);
    const color = options.color || [255, 255, 255];
    const l = this.layout(text);
    const pad = options.outline ? 1 : 0;
    const shadow = options.shadow ? 1 : 0;
    const w = (l.width + pad * 2 + shadow) * scale;
    const h = (l.height + pad * 2 + shadow) * scale;
    const data = new Uint8Array(Math.max(w * h * 4, 4));

    const put = (px, py, rgb) => {
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = px * scale + sx, y = py * scale + sy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = (y * w + x) * 4;
          data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
        }
      }
    };
    const paint = (dx, dy, rgb) => {
      for (const g of l.glyphs) {
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < g.glyph.w; x++) {
            if (g.glyph.rows[y][x] === '#') put(g.x + x + pad + dx, g.y + y + pad + dy, rgb);
          }
        }
      }
    };

    if (options.shadow) paint(1, 1, options.shadow);
    if (options.outline) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) paint(dx, dy, options.outline);
    }
    paint(0, 0, color);
    return { width: w, height: h, data };
  }
}

export function defaultFont() {
  return new BitmapFont(DEFAULT_FONT_DEF);
}
