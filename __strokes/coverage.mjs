// coverage.mjs — quantitative gate for a pen-stroke set.
//
//   bun coverage.mjs <char|codepoint> [--seed|--fit] [--size 512] [--json]
//
// Rasterises (alpha channel, >=512 px by default):
//   A = the glyph ink silhouette
//   B = the union of all pen strokes drawn at their own `width`, round caps/joins
//   Bi = each pen stroke alone
// and reports
//   (a) ink coverage       = |A n B| / |A|          -- how much of the glyph the pens reveal
//   (b) per-stroke outside = |Bi \ A| / |Bi|        -- how much of a pen spills off the glyph
//
// Targets a fitting agent should hit: ink coverage >= 97%, outside-ink <= ~25% per pen.
import { resolveChar, loadGlyphs, loadStrokes, inkAlphaSVG, pensAlphaSVG, rasterRGBA, alphaMask, parseArgs, log } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['size']);
const target = args._[0];
if (!target) {
  console.error('usage: bun coverage.mjs <char|codepoint> [--seed|--fit] [--size N] [--json]');
  process.exit(2);
}

const entry = resolveChar(target);
const glyph = loadGlyphs().glyphs[entry.char];
if (!glyph) throw new Error(`${entry.char} not in out/glyphs.json — run: bun extract.mjs`);

const which = args.fit ? 'fit' : args.seed ? 'seed' : undefined;
const ls = loadStrokes(entry, which);
const strokes = ls.data.strokes;
const size = Math.max(512, args.size ? Number(args.size) : 512);

const ink = alphaMask(rasterRGBA(inkAlphaSVG(glyph, size), size));
const pen = alphaMask(rasterRGBA(pensAlphaSVG(glyph, strokes, size), size));

let inkPx = 0, penPx = 0, covered = 0, penOutside = 0;
for (let i = 0; i < ink.m.length; i++) {
  const a = ink.m[i], b = pen.m[i];
  if (a) inkPx++;
  if (b) penPx++;
  if (a && b) covered++;
  if (b && !a) penOutside++;
}
const inkCoverage = inkPx ? (100 * covered) / inkPx : 0;
const unionOutside = penPx ? (100 * penOutside) / penPx : 0;

const rows = strokes.map((s) => {
  const one = alphaMask(rasterRGBA(pensAlphaSVG(glyph, [s], size), size));
  let px = 0, out = 0, cov = 0;
  for (let i = 0; i < one.m.length; i++) {
    if (!one.m[i]) continue;
    px++;
    if (ink.m[i]) cov++; else out++;
  }
  return {
    i: s.i,
    refIndices: s.refIndices,
    width: s.width,
    pts: s.points.length,
    penPx: px,
    outsidePct: px ? (100 * out) / px : 0,
    ownInkPct: inkPx ? (100 * cov) / inkPx : 0,
  };
});

const pad = (s, n) => String(s).padStart(n);
const f1 = (n) => n.toFixed(1);

if (args.json) {
  console.log(JSON.stringify({ char: entry.char, codepoint: entry.codepoint, which: ls.which, size, inkPx, penPx, inkCoverage, unionOutside, strokes: rows }, null, 2));
} else {
  log(`\n${entry.char} ${entry.codepoint}   source=${ls.which} (${ls.path})   raster=${size}px   pens=${strokes.length}`);
  log(`ink pixels=${inkPx}  pen-union pixels=${penPx}`);
  log(`(a) INK COVERAGE      ${f1(inkCoverage)}%   ${inkCoverage >= 97 ? 'PASS' : 'FAIL (target >=97%)'}`);
  log(`    pen union outside ink ${f1(unionOutside)}%`);
  log('');
  log('  pen  refIdx      width  pts    penPx   outside%   of-ink%   flag');
  log('  ---  ----------  -----  ---  -------  ---------  --------  ------');
  for (const r of rows)
    log(
      `  ${pad(r.i + 1, 3)}  ${pad('[' + r.refIndices.join(',') + ']', 10)}  ${pad(r.width, 5)}  ${pad(r.pts, 3)}  ` +
        `${pad(r.penPx, 7)}  ${pad(f1(r.outsidePct), 9)}  ${pad(f1(r.ownInkPct), 8)}  ${r.outsidePct > 25 ? 'OVER' : ''}`
    );
  const bad = rows.filter((r) => r.outsidePct > 25).length;
  log(`\n(b) per-pen outside-ink: ${bad}/${rows.length} over the 25% target` + (bad ? ` -> pens ${rows.filter((r) => r.outsidePct > 25).map((r) => r.i + 1).join(', ')}` : ''));
}
