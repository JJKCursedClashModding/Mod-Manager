/**
 * Generates renderer/assets/icon.png (256), favicon.png (64) and icon.ico
 * from the same "claw slash" concept as logo.svg — no external deps,
 * pure Node (zlib) so it runs anywhere `npm` does.
 *
 * Design: near-black rounded tile, faint cursed-energy purple glow,
 * three crimson claw slashes (dark underlay + gradient slash on top).
 * Original artwork in the spirit of JJK — no copyrighted assets.
 *
 * Usage: node scripts/generate-icons.cjs
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "renderer", "assets");

// Slashes in 64-space (mirrors logo.svg cubics), width = base px at 64.
const SLASHES = [
  { p0: [13, 49], c1: [22, 38], c2: [32, 26], p3: [43, 12], w: 7.0 },
  { p0: [22, 53], c1: [31, 43], c2: [40, 32], p3: [51, 19], w: 5.6 },
  { p0: [31, 56], c1: [38, 47], c2: [45, 38], p3: [52, 30], w: 4.4 },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function cubic(p0, c1, c2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
  ];
}

// Distance from (px,py) to a slash + the curve param t of the closest point.
function slashDist(s, px, py) {
  let best = Infinity;
  let bestT = 0;
  const N = 72;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = cubic(s.p0, s.c1, s.c2, s.p3, t);
    const d = Math.hypot(px - x, py - y);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  return { d: best, t: bestT };
}

// Crimson gradient along the slash: bright top → deep red tip.
function slashColor(t) {
  const bright = [255, 90, 104];
  const mid = [210, 31, 51];
  const deep = [125, 12, 29];
  if (t < 0.55) {
    const k = t / 0.55;
    return [lerp(bright[0], mid[0], k), lerp(bright[1], mid[1], k), lerp(bright[2], mid[2], k)];
  }
  const k = (t - 0.55) / 0.45;
  return [lerp(mid[0], deep[0], k), lerp(mid[1], deep[1], k), lerp(mid[2], deep[2], k)];
}

function renderIcon(size) {
  const k = size / 64; // scale from design space
  const data = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const cornerR = 15 * k;
  const rimW = Math.max(1.2, 2 * k);

  const top = [29, 19, 34];
  const mid = [18, 13, 24];
  const bottom = [10, 10, 18];
  const rimCol = [255, 59, 77];
  const underCol = [74, 6, 15];
  const glowCol = [157, 60, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / k;
      const py = (y + 0.5) / k;

      // Rounded-rect tile mask (SDF, negative inside).
      const qx = Math.abs(x + 0.5 - c) - (c - 2 * k - cornerR);
      const qy = Math.abs(y + 0.5 - c) - (c - 2 * k - cornerR);
      const ax = Math.max(qx, 0);
      const ay = Math.max(qy, 0);
      const sd = (Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - cornerR) / k;
      if (sd > 1) continue; // transparent outside tile
      const tileAlpha = clamp01((1 - sd) / 1.2);

      // Dark vertical gradient base.
      const t = (y + 0.5) / size;
      let r = t < 0.6 ? lerp(top[0], mid[0], t / 0.6) : lerp(mid[0], bottom[0], (t - 0.6) / 0.4);
      let g = t < 0.6 ? lerp(top[1], mid[1], t / 0.6) : lerp(mid[1], bottom[1], (t - 0.6) / 0.4);
      let b = t < 0.6 ? lerp(top[2], mid[2], t / 0.6) : lerp(mid[2], bottom[2], (t - 0.6) / 0.4);

      // Cursed-energy purple glow around (32, 35).
      const gd = Math.hypot(px - 32, py - 35) / 24;
      const ga = clamp01(1 - gd) * clamp01(1 - gd) * 0.32;
      r = lerp(r, glowCol[0], ga);
      g = lerp(g, glowCol[1], ga);
      b = lerp(b, glowCol[2], ga);

      // Slashes back-to-front (later = on top, matching SVG paint order).
      for (const s of SLASHES) {
        const w = s.w * (1 - 0.45 * 0); // base width; taper applied per-t below
        void w;
        const { d, t: ct } = slashDist(s, px, py);
        const wt = (s.w * (1 - 0.5 * ct)) / 2; // tapered half-width, thinner at tip
        // Dark underlay (slightly wider, offset down like the SVG).
        const ud = slashDist(s, px, py - 1.5).d;
        const uHalf = wt + 1.25;
        const ua = clamp01((uHalf + 0.75 - ud) / 1.5) * 0.9;
        r = lerp(r, underCol[0], ua);
        g = lerp(g, underCol[1], ua);
        b = lerp(b, underCol[2], ua);
        // Crimson slash body.
        const sa = clamp01((wt + 0.75 - d) / 1.5);
        if (sa > 0) {
          const [cr, cg, cb] = slashColor(ct);
          r = lerp(r, cr, sa);
          g = lerp(g, cg, sa);
          b = lerp(b, cb, sa);
        } else {
          // Soft red aura just outside the slash.
          const aura = clamp01((wt + 3 - d) / 3) * 0.3;
          r = lerp(r, 210, aura * 0.5);
          g = lerp(g, 40, aura * 0.5);
          b = lerp(b, 55, aura * 0.5);
        }
      }

      // Crimson rim following the tile edge.
      const rimA = clamp01(1 - Math.abs(sd + rimW / 2 / k) / (rimW / 2 / k + 1)) * 0.5;
      r = lerp(r, rimCol[0], rimA);
      g = lerp(g, rimCol[1], rimA);
      b = lerp(b, rimCol[2], rimA);

      const i = (y * size + x) * 4;
      data[i] = Math.round(r);
      data[i + 1] = Math.round(g);
      data[i + 2] = Math.round(b);
      data[i + 3] = Math.round(255 * tileAlpha);
    }
  }
  return data;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let kk = 0; kk < 8; kk++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0);
  return Buffer.concat([len, typeBuf, payload, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png256.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png256]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png256 = encodePng(256, renderIcon(256));
  const png64 = encodePng(64, renderIcon(64));
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), png256);
  fs.writeFileSync(path.join(OUT_DIR, "favicon.png"), png64);
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), encodeIco(png256));
  for (const f of ["icon.png", "favicon.png", "icon.ico"]) {
    const s = fs.statSync(path.join(OUT_DIR, f));
    console.log(`wrote renderer/assets/${f} (${s.size} bytes)`);
  }
}

if (require.main === module) main();
module.exports = { renderIcon, encodePng, encodeIco };
