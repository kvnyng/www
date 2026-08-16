// seed.mjs — hanzi-writer-data medians -> font-unit pen medians, bbox-aligned.
//
// hanzi-writer's coordinate system: x,y in [0,1024]-ish, y is Y-UP with the visual top
// at y=900 — their SVGs wrap the glyph in `transform="scale(1,-1) translate(0,-900)"`.
// So a data point (x,y) draws at (x, 900 - y) inside a 1024-unit Y-DOWN box.
//
// Two-stage mapping:
//   1. BASE: (x, 900-y) * (upem/1024)  -> our em box (see lib.mjs for the convention).
//   2. REFINE: a per-character affine with separate x/y scale + translate that maps the
//      median cloud's bbox onto the Long Cang ink bbox INSET by half a pen width (the
//      centreline of a round-capped pen sits half a width inside the ink edge).
//
// Long Cang is a cursive/handwriting face: its strokes are ligated, slanted, and often
// do not land where a printed-kai skeleton says they should. Stage 2 is therefore only a
// BALLPARK SEED. Expect to hand-fit fit/*.json afterwards; coverage.mjs is the gate.
//
// Run: bun seed.mjs [--width 0.07] [--force] [--minpts 10] [--maxpts 30]
import { existsSync } from 'node:fs';
import { P, CHARS, readJSON, writeJSON, loadGlyphs, resample, polyLength, bboxOf, log, r2, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['width', 'minpts', 'maxpts']);
const WIDTH_FRAC = args.width ? Number(args.width) : 0.07; // pen width as a fraction of upem
const MINP = args.minpts ? Number(args.minpts) : 10;
const MAXP = args.maxpts ? Number(args.maxpts) : 30;

const HW_EM = 1024; // hanzi-writer nominal em
const HW_TOP = 900; // hanzi-writer y-up origin offset

const G = loadGlyphs();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

for (const c of CHARS.chars) {
  const glyph = G.glyphs[c.char];
  if (!glyph) {
    log(`!! ${c.char}: not in out/glyphs.json — skipping`);
    continue;
  }
  const upem = glyph.upem;
  const ref = readJSON(c.data);
  const nStrokes = ref.medians.length;
  if (nStrokes !== c.expectedStrokes)
    log(`!! ${c.char}: ${nStrokes} medians but manifest expects ${c.expectedStrokes} — FLAGGED`);
  if (ref.strokes.length !== ref.medians.length)
    log(`!! ${c.char}: strokes(${ref.strokes.length}) != medians(${ref.medians.length}) — FLAGGED`);

  const width = upem * WIDTH_FRAC;

  // --- stage 1: base map into the em box
  const s = upem / HW_EM;
  const base = ref.medians.map((m) => m.map(([x, y]) => [x * s, (HW_TOP - y) * s]));

  // --- stage 2: affine refine onto the inset ink bbox
  const cloud = bboxOf(base.flat());
  const half = width / 2;
  const ink = glyph.ink;
  let tx1 = ink.x1 + half, tx2 = ink.x2 - half, ty1 = ink.y1 + half, ty2 = ink.y2 - half;
  if (tx2 - tx1 <= upem * 0.02) { tx1 = ink.x1; tx2 = ink.x2; } // ink too thin to inset
  if (ty2 - ty1 <= upem * 0.02) { ty1 = ink.y1; ty2 = ink.y2; }
  const sx = cloud.w > 1e-6 ? (tx2 - tx1) / cloud.w : 1;
  const sy = cloud.h > 1e-6 ? (ty2 - ty1) / cloud.h : 1;
  const ox = tx1 - cloud.x1 * sx;
  const oy = ty1 - cloud.y1 * sy;
  const xf = ([x, y]) => [x * sx + ox, y * sy + oy];

  const strokes = base.map((pts, i) => {
    const mapped = pts.map(xf);
    const L = polyLength(mapped);
    const n = clamp(Math.round(L / (upem * 0.045)) + 2, MINP, MAXP);
    return {
      i,
      refIndices: [i], // canonical hanzi-writer stroke indices this pen covers
      width: r2(width),
      points: resample(mapped, n).map(([x, y]) => [r2(x), r2(y)]),
    };
  });

  const doc = {
    char: c.char,
    upem,
    codepoint: c.codepoint,
    source: 'seed.mjs (hanzi-writer-data medians, bbox-aligned to Long Cang ink)',
    generated: new Date().toISOString(),
    widthFrac: WIDTH_FRAC,
    transform: { stage1Scale: r2(s), hwTop: HW_TOP, sx: r2(sx), sy: r2(sy), ox: r2(ox), oy: r2(oy) },
    inkBBox: ink,
    strokes,
  };

  const seedPath = writeJSON(c.seed, doc);
  log(
    `${c.char} ${c.codepoint}: ${strokes.length} strokes, width=${r2(width)} (${WIDTH_FRAC * 100}% upem), ` +
      `pts=[${strokes.map((x) => x.points.length).join(',')}]`
  );
  log(`   cloud=[${r2(cloud.x1)},${r2(cloud.y1)}..${r2(cloud.x2)},${r2(cloud.y2)}] -> ink inset ` +
      `[${r2(tx1)},${r2(ty1)}..${r2(tx2)},${r2(ty2)}]  sx=${r2(sx)} sy=${r2(sy)} ox=${r2(ox)} oy=${r2(oy)}`);
  log(`   -> ${seedPath}`);

  const fitAbs = P(c.fit);
  if (existsSync(fitAbs) && !args.force) {
    log(`   fit/${c.file}.json exists — NOT overwritten (hand-fitting is preserved; use --force to reset)`);
  } else {
    writeJSON(c.fit, doc);
    log(`   -> ${fitAbs} (working copy)`);
  }
}
log('seed done.');
