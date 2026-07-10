'use strict';

/**
 * Generates the PWA icons (public/icons/*.png) without any dependencies:
 * a tiny PNG encoder (zlib is built in) plus procedural drawing — dark felt
 * background, a white playing card, a red heart pip.
 * Run: node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Minimal PNG encoder (8-bit RGBA) ───────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing (2× supersampled) ──────────────────────────────────────────────
function drawIcon(size, { padded }) {
  const S = size * 2; // supersample
  const px = new Float64Array(S * S * 4);

  const put = (x, y, r, g, b) => {
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  // Content scale: maskable icons keep everything inside the safe zone.
  const k = padded ? 0.72 : 0.92;
  const cx = S / 2;
  const cy = S / 2;

  // Card geometry (axis-aligned rounded rect).
  const cardW = S * 0.30 * k * 1.9;
  const cardH = S * 0.40 * k * 1.9;
  const rad = cardW * 0.12;

  const inRounded = (x, y, w, h, r) => {
    const dx = Math.abs(x - cx) - (w / 2 - r);
    const dy = Math.abs(y - cy) - (h / 2 - r);
    if (dx <= 0 && Math.abs(y - cy) <= h / 2) return true;
    if (dy <= 0 && Math.abs(x - cx) <= w / 2) return true;
    return dx > 0 && dy > 0 && dx * dx + dy * dy <= r * r;
  };

  // Heart implicit curve: (x²+y²−1)³ − x²·y³ ≤ 0
  const heartR = cardW * 0.36;
  const heartCy = cy - cardH * 0.02;
  const inHeart = (x, y) => {
    const hx = (x - cx) / heartR;
    const hy = -(y - heartCy) / heartR;
    const a = hx * hx + hy * hy - 1;
    return a * a * a - hx * hx * hy * hy * hy <= 0;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // felt background with a soft vignette
      const d = Math.hypot(x - cx, y - cy) / (S * 0.72);
      let r = 22 + (1 - d) * 8;
      let g = 96 + (1 - d) * 14;
      let b = 58 + (1 - d) * 8;
      if (inRounded(x, y, cardW + S * 0.02, cardH + S * 0.02, rad * 1.2)) {
        // card border (dark)
        r = 42; g = 33; b = 24;
      }
      if (inRounded(x, y, cardW, cardH, rad)) {
        // card face
        r = 246; g = 241; b = 222;
      }
      if (inHeart(x, y)) {
        r = 194; g = 32; b = 40;
      }
      put(x, y, r, g, b);
    }
  }

  // Downsample 2× → RGBA buffer.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        const v =
          (px[((2 * y) * S + 2 * x) * 4 + c] +
            px[((2 * y) * S + 2 * x + 1) * 4 + c] +
            px[((2 * y + 1) * S + 2 * x) * 4 + c] +
            px[((2 * y + 1) * S + 2 * x + 1) * 4 + c]) / 4;
        out[(y * size + x) * 4 + c] = Math.round(v);
      }
    }
  }
  return encodePNG(size, size, out);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192, { padded: false }));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512, { padded: false }));
fs.writeFileSync(path.join(outDir, 'maskable-512.png'), drawIcon(512, { padded: true }));
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), drawIcon(180, { padded: false }));
console.log('icons written to public/icons/');
