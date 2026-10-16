// Helpers for a game's own HTML UI. The engine does not draw a HUD; a game
// gives Game a `hud` object with update(state) and builds whatever DOM it likes
// (see getHudState() and docs/rpg.md). This file is the one UI piece the engine
// does provide: the engine's bitmap font in the DOM, so on-screen text matches
// the damage numbers drawn in the world.
//
// Why a canvas and not a real webfont: a webfont would need a generated TrueType
// binary, which is exactly the opaque artefact the engine exists to avoid, and
// buys little for a handful of pixel-art labels. A canvas of crisp pixels, set
// with image-rendering: pixelated, is the same picture. The catch is that it is
// an image, so it is not selectable and a real <input> still uses a CSS font.

import { defaultFont } from './font.js';

const rgb = (c) => (Array.isArray(c) ? c.map((v) => (v <= 1 ? Math.round(v * 255) : v)) : parseHex(c));

function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Draw text onto a canvas element, sized to fit. options: { font, scale, color,
 * outline, shadow }. Colours are '#rrggbb' or [r, g, b] in 0-1 or 0-255.
 */
export function drawPixelText(canvas, text, options = {}) {
  const font = options.font || defaultFont();
  const out = font.rasterize(text, {
    scale: options.scale || 2,
    color: rgb(options.color || '#ffffff'),
    outline: options.outline ? rgb(options.outline) : null,
    shadow: options.shadow ? rgb(options.shadow) : null,
  });
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.style.imageRendering = 'pixelated';
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
  return canvas;
}

/** A new canvas with the text already drawn: handy for building DOM from code. */
export function pixelText(text, options = {}) {
  return drawPixelText(document.createElement('canvas'), text, options);
}

/**
 * Register <fount-text text="HELLO" scale="2" color="#ffd040" outline="#000">.
 * Attributes are observed, so changing `text` re-renders. Safe to call twice.
 */
export function registerFountText(font = null) {
  if (typeof customElements === 'undefined' || customElements.get('fount-text')) return;
  customElements.define('fount-text', class extends HTMLElement {
    static get observedAttributes() { return ['text', 'scale', 'color', 'outline', 'shadow']; }
    connectedCallback() {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.style.display = 'inline-block';
        this.style.lineHeight = '0';
        this.append(this.canvas);
      }
      this.render();
    }
    attributeChangedCallback() { if (this.canvas) this.render(); }
    render() {
      drawPixelText(this.canvas, this.getAttribute('text') ?? this.textContent ?? '', {
        font: font || undefined,
        scale: +this.getAttribute('scale') || 2,
        color: this.getAttribute('color') || '#ffffff',
        outline: this.getAttribute('outline'),
        shadow: this.getAttribute('shadow'),
      });
    }
  });
}
