// Draws the app's icons into public/. The mark is a magnifying glass whose blue lens shows a skull,
// like seeing what lies beneath the surface.
// - Home-screen icons: a white glass on a dark square (phones need a filled background).
// - logo.png (header home button) and favicon.png: a black glass on a transparent background.
// No dependencies. Run with `node scripts/make-icons.mjs` after changing the design.

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const DARK = [29, 32, 39];
const BLUE = [47, 111, 228];
const WHITE = [255, 255, 255];
const BLACK = [17, 17, 17];

// Shapes in a unit square (0–1), y pointing down.
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r;

/** Within `r` of the line segment from (ax, ay) to (bx, by): a bar with round ends. */
function capsule(x, y, ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= r;
}

function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && Math.hypot(x - cx, y - cy) <= r;
}

function triangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const side = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = side(ax, ay, bx, by), d2 = side(bx, by, cx, cy), d3 = side(cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// The glass: lens centred at (LX, LY), handle toward the bottom right.
const LX = 0.42, LY = 0.42, R_OUT = 0.3;
const HANDLE_FROM = 0.64, HANDLE_TO = 0.84;

function inSkull(x, y) {
  const head = circle(x, y, LX, LY - 0.035, 0.135) || roundRect(x, y, LX - 0.085, LY + 0.02, LX + 0.085, LY + 0.135, 0.035);
  if (!head) return false;
  const eyes = circle(x, y, LX - 0.055, LY, 0.04) || circle(x, y, LX + 0.055, LY, 0.04);
  const nose = triangle(x, y, [LX - 0.022, LY + 0.075], [LX + 0.022, LY + 0.075], [LX, LY + 0.04]);
  // Gaps between the teeth, along the bottom of the jaw.
  const teeth = y > LY + 0.1 && [-0.04, 0, 0.04].some((dx) => Math.abs(x - (LX + dx)) < 0.009);
  return !(eyes || nose || teeth);
}

/**
 * The mark as a colour function over the unit square; null means transparent.
 * `stroke` is the width of the rim and handle.
 */
function mark({ glass, background, stroke = 0.065 }) {
  return (x, y) => {
    if (inSkull(x, y)) return WHITE;
    if (circle(x, y, LX, LY, R_OUT - stroke)) return BLUE;
    if (circle(x, y, LX, LY, R_OUT)) return glass;
    if (capsule(x, y, HANDLE_FROM, HANDLE_FROM, HANDLE_TO, HANDLE_TO, stroke)) return glass;
    return background;
  };
}

/** The part of the unit square the glass covers, with a small margin, for the cropped logo. */
function tightBox(stroke) {
  const lo = LX - R_OUT - 0.01;
  const hi = HANDLE_TO + stroke + 0.01;
  return { x0: lo, y0: lo, size: hi - lo };
}

/**
 * Render `design` into a PNG of `size` px. `pad` shrinks the whole square toward the centre
 * (maskable icons); `box` crops to a region instead.
 */
function render(design, size, { pad = 1, box = null } = {}) {
  const SS = 4; // supersampling for smooth edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (px + (sx + 0.5) / SS) / size;
          const fy = (py + (sy + 0.5) / SS) / size;
          const u = box ? box.x0 + fx * box.size : 0.5 + (fx - 0.5) / pad;
          const v = box ? box.y0 + fy * box.size : 0.5 + (fy - 0.5) / pad;
          const c = design(u, v);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = hits ? Math.round(r / hits) : 0;
      raw[o + 1] = hits ? Math.round(g / hits) : 0;
      raw[o + 2] = hits ? Math.round(b / hits) : 0;
      raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return png(size, size, raw);
}

function png(w, h, raw) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const homeScreen = mark({ glass: WHITE, background: DARK });
const logo = mark({ glass: BLACK, background: null });
// Thicker rim and handle so the favicon still reads at 16 px.
const FAVICON_STROKE = 0.085;
const favicon = mark({ glass: BLACK, background: null, stroke: FAVICON_STROKE });

const out = new URL('../public/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), render(homeScreen, 192));
writeFileSync(new URL('icon-512.png', out), render(homeScreen, 512));
// Maskable: Android may crop to a circle of 40% radius, so the artwork is shrunk to fit inside it.
writeFileSync(new URL('icon-maskable-512.png', out), render(homeScreen, 512, { pad: 0.68 }));
writeFileSync(new URL('apple-touch-icon.png', out), render(homeScreen, 180));
writeFileSync(new URL('logo.png', out), render(logo, 144, { box: tightBox(0.065) }));
writeFileSync(new URL('favicon.png', out), render(favicon, 64, { box: tightBox(FAVICON_STROKE) }));
console.log('Icons written to public/');
