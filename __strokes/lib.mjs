// lib.mjs — shared helpers: paths, char resolution, geometry, SVG builders, rasterizer.
//
// COORDINATE CONVENTION (everything downstream of extract.mjs lives here):
//   A square em box, viewBox "0 0 <upem> <upem>", y-DOWN, origin top-left.
//   The glyph is horizontally centred in it: dx = (upem - advanceWidth) / 2.
//   The baseline sits at y = ascentUsed (see extract.mjs for how that is chosen).
//   Pen medians are in the SAME box, so an SVG can draw glyph + pens with no extra transform.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const P = (...a) => join(ROOT, ...a);
export const log = (...a) => console.log(...a);

export const CHARS = JSON.parse(readFileSync(P('chars.json'), 'utf8'));

export function readJSON(p) {
  return JSON.parse(readFileSync(p.startsWith('/') ? p : P(p), 'utf8'));
}
export function writeJSON(p, obj) {
  const abs = p.startsWith('/') ? p : P(p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
  return abs;
}

/** Accept '杨', 'u6768', 'U+6768', '6768', '0x6768'. */
export function resolveChar(arg) {
  if (!arg) throw new Error('missing <char|codepoint>');
  const s = String(arg).trim();
  let hit = CHARS.chars.find((c) => c.char === s);
  if (hit) return hit;
  hit = CHARS.chars.find((c) => c.file.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  const hex = s.replace(/^(U\+|0x|0X|u|U)/, '');
  if (/^[0-9a-fA-F]{4,6}$/.test(hex)) {
    const ch = String.fromCodePoint(parseInt(hex, 16));
    hit = CHARS.chars.find((c) => c.char === ch);
    if (hit) return hit;
  }
  throw new Error(
    `unknown char '${arg}'. known: ` + CHARS.chars.map((c) => `${c.char} (${c.file})`).join(', ')
  );
}

/** Minimal argv parser: flags with values (--upto 3 / --upto=3) and booleans. */
export function parseArgs(argv, valueFlags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-/g, '');
    if (eq !== -1) out[key] = a.slice(eq + 1);
    else if (valueFlags.includes(key)) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

// ---------------------------------------------------------------- geometry
export function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Arc-length resample to exactly n points, endpoints preserved, direction preserved. */
export function resample(pts, n) {
  const clean = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) clean.push([p[0], p[1]]);
  }
  if (clean.length === 0) throw new Error('empty polyline');
  if (clean.length === 1) return Array.from({ length: n }, () => [clean[0][0], clean[0][1]]);
  const cum = [0];
  for (let i = 1; i < clean.length; i++)
    cum.push(cum[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]));
  const L = cum[cum.length - 1];
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (L * k) / (n - 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < t) i++;
    const t0 = cum[i - 1], t1 = cum[i];
    const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out.push([
      clean[i - 1][0] + (clean[i][0] - clean[i - 1][0]) * u,
      clean[i - 1][1] + (clean[i][1] - clean[i - 1][1]) * u,
    ]);
  }
  return out;
}

export function bboxOf(points) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of points) {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

export const r2 = (n) => Math.round(n * 100) / 100;

/** Polyline -> SVG path data. */
export function penD(points) {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${r2(x)} ${r2(y)}`).join(' ');
}

// ---------------------------------------------------------------- loading
export function loadGlyphs() {
  const p = P('out/glyphs.json');
  if (!existsSync(p)) throw new Error('out/glyphs.json missing — run: bun extract.mjs');
  return readJSON(p);
}

/**
 * Load a pen-stroke set. which = 'fit' | 'seed' | undefined (auto: fit if present).
 * Returns { data, which, path }.
 */
export function loadStrokes(entry, which) {
  const cand = which ? [which] : ['fit', 'seed'];
  for (const w of cand) {
    const rel = w === 'fit' ? entry.fit : entry.seed;
    if (existsSync(P(rel))) return { data: readJSON(rel), which: w, path: rel };
  }
  throw new Error(
    `no ${which || 'fit/seed'} stroke file for ${entry.char} — run: bun seed.mjs`
  );
}

// ---------------------------------------------------------------- SVG
const BG = '#f6f4ef';
const INK = '#9a9a9a';
const PEN = '#d62828';
const MED = '#1f5fd0';
const START = '#0f9d58';

export function overlaySVG(glyph, strokes, opts = {}) {
  const u = glyph.upem;
  const size = opts.size || 960;
  const upto = opts.upto == null ? strokes.length : Math.max(0, Math.min(strokes.length, opts.upto));
  const shown = strokes.slice(0, upto);
  const thin = u * 0.005;
  const parts = [];
  parts.push(`<rect x="0" y="0" width="${u}" height="${u}" fill="${BG}"/>`);
  // em-box guides: centre cross + inset frame, so a mis-scaled seed is obvious
  parts.push(
    `<g stroke="#d9d4c8" stroke-width="${thin}" fill="none">` +
      `<rect x="0.5" y="0.5" width="${u - 1}" height="${u - 1}"/>` +
      `<line x1="${u / 2}" y1="0" x2="${u / 2}" y2="${u}"/>` +
      `<line x1="0" y1="${u / 2}" x2="${u}" y2="${u / 2}"/></g>`
  );
  if (glyph.baseline != null)
    parts.push(
      `<line x1="0" y1="${r2(glyph.baseline)}" x2="${u}" y2="${r2(glyph.baseline)}" stroke="#e2b7b7" stroke-width="${thin}"/>`
    );
  if (!opts.noGlyph) parts.push(`<path d="${glyph.d}" fill="${INK}"/>`);
  if (!opts.glyphOnly) {
    for (const s of shown)
      parts.push(
        `<path d="${penD(s.points)}" fill="none" stroke="${PEN}" stroke-opacity="0.32" ` +
          `stroke-width="${r2(s.width)}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    for (const s of shown) {
      parts.push(
        `<path d="${penD(s.points)}" fill="none" stroke="${MED}" stroke-width="${r2(thin * 1.4)}" ` +
          `stroke-linecap="round" stroke-linejoin="round"/>`
      );
      for (const [x, y] of s.points)
        parts.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(u * 0.006)}" fill="${MED}"/>`);
      const [sx, sy] = s.points[0];
      parts.push(`<circle cx="${r2(sx)}" cy="${r2(sy)}" r="${r2(u * 0.017)}" fill="${START}"/>`);
      parts.push(
        `<text x="${r2(sx + u * 0.028)}" y="${r2(sy - u * 0.018)}" font-family="Helvetica, Arial, sans-serif" ` +
          `font-size="${r2(u * 0.052)}" font-weight="bold" fill="#111" stroke="${BG}" stroke-width="${r2(u * 0.006)}" ` +
          `paint-order="stroke" >${s.i + 1}</text>`
      );
    }
  }
  const title = opts.title || '';
  if (title)
    parts.push(
      `<text x="${r2(u * 0.02)}" y="${r2(u * 0.045)}" font-family="Helvetica, Arial, sans-serif" ` +
        `font-size="${r2(u * 0.034)}" fill="#666">${escapeXml(title)}</text>`
    );
  return svgWrap(u, size, parts.join('\n'));
}

/** One progressive-reveal frame: glyph ink masked by pens 1..k. k=0 -> blank. */
export function frameSVG(glyph, strokes, k, opts = {}) {
  const u = glyph.upem;
  const size = opts.size || 480;
  return svgWrap(u, size, frameBody(glyph, strokes, k, opts.id || 'f'), opts.bg !== false);
}

function frameBody(glyph, strokes, k, id) {
  const u = glyph.upem;
  const pens = strokes.slice(0, k);
  const mask =
    `<mask id="m${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${u}" height="${u}">` +
    `<rect x="0" y="0" width="${u}" height="${u}" fill="#000"/>` +
    pens
      .map(
        (s) =>
          `<path d="${penD(s.points)}" fill="none" stroke="#fff" stroke-width="${r2(s.width)}" ` +
          `stroke-linecap="round" stroke-linejoin="round"/>`
      )
      .join('') +
    `</mask>`;
  return `${mask}<path d="${glyph.d}" fill="#2b2b2b" mask="url(#m${id})"/>`;
}

export function sheetSVG(glyph, strokes, opts = {}) {
  const u = glyph.upem;
  const n = strokes.length;
  const frames = n + 1; // k = 0..N
  const cols = opts.cols || Math.min(frames, Math.ceil(Math.sqrt(frames)) + 1);
  const rows = Math.ceil(frames / cols);
  const pad = u * 0.04;
  const cellW = u + pad;
  const cellH = u + pad + u * 0.09; // room for the caption strip
  const W = cols * cellW + pad;
  const H = rows * cellH + pad;
  const parts = [`<rect x="0" y="0" width="${r2(W)}" height="${r2(H)}" fill="${BG}"/>`];
  for (let k = 0; k < frames; k++) {
    const cx = pad + (k % cols) * cellW;
    const cy = pad + Math.floor(k / cols) * cellH;
    parts.push(
      `<g transform="translate(${r2(cx)},${r2(cy)})">` +
        `<rect x="0" y="0" width="${u}" height="${u}" fill="#fff" stroke="#ddd7c9" stroke-width="${r2(u * 0.004)}"/>` +
        frameBody(glyph, strokes, k, `s${k}`) +
        `<text x="${r2(u * 0.5)}" y="${r2(u + u * 0.075)}" text-anchor="middle" ` +
        `font-family="Helvetica, Arial, sans-serif" font-size="${r2(u * 0.06)}" fill="#555">` +
        `${k}/${n}</text></g>`
    );
  }
  const px = opts.size || Math.min(1600, cols * 340);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(W)} ${r2(H)}" ` +
    `width="${px}" height="${Math.round((px * H) / W)}">\n${parts.join('\n')}\n</svg>`
  );
}

/** Silhouette-only SVGs used by coverage.mjs: white shapes on transparent. */
export function inkAlphaSVG(glyph, size) {
  return svgWrap(glyph.upem, size, `<path d="${glyph.d}" fill="#fff"/>`, false);
}
export function pensAlphaSVG(glyph, strokes, size) {
  const body = strokes
    .map(
      (s) =>
        `<path d="${penD(s.points)}" fill="none" stroke="#fff" stroke-width="${r2(s.width)}" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('');
  return svgWrap(glyph.upem, size, body, false);
}

function svgWrap(u, size, body, withBg = true) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${u} ${u}" width="${size}" height="${size}">\n` +
    (withBg ? `` : ``) +
    body +
    `\n</svg>`
  );
}

export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ---------------------------------------------------------------- raster
/** Render SVG -> { w, h, data: RGBA Uint8Array }. */
export function rasterRGBA(svg, size) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  });
  const img = r.render();
  const px = img.pixels;
  if (px && px.length >= img.width * img.height * 4)
    return { w: img.width, h: img.height, data: new Uint8Array(px.buffer ? px.buffer.slice(px.byteOffset, px.byteOffset + px.length) : px) };
  return decodePNG(Buffer.from(img.asPng()));
}

export function renderPNG(svg, size) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  });
  return Buffer.from(r.render().asPng());
}

/** Alpha >= 128 -> 1. Returns Uint8Array of 0/1, length w*h. */
export function alphaMask(rgba) {
  const { w, h, data } = rgba;
  const m = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < m.length; i++, p += 4) m[i] = data[p] >= 128 ? 1 : 0;
  return { w, h, m };
}

/** Fallback PNG decoder: 8-bit RGBA, non-interlaced (what resvg emits). */
function decodePNG(buf) {
  let off = 8; // skip signature
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0)
    throw new Error(`unsupported PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { w, h, data: out };
}
