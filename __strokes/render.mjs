// render.mjs — headless SVG -> PNG previews of the glyph + pen strokes.
//
//   bun render.mjs <char|codepoint> [--seed|--fit] [--upto K] [--sheet] [--glyph-only]
//                                   [--size N] [--out path]
//
// Modes:
//   overlay (default) mid-grey glyph silhouette + each pen stroked at its own `width` in
//                     translucent red (round caps/joins) + thin blue median polyline with
//                     point dots + a GREEN dot at each stroke's START + the stroke number.
//   --upto K          overlay, but only pens 1..K.
//   --glyph-only      just the silhouette in its em box (sanity-check placement).
//   --sheet           contact sheet, frame k = glyph masked by pens 1..k, k = 0..N. This is
//                     a browser-free simulation of the progressive reveal; the LAST frame
//                     should show the complete glyph if the pens cover the ink.
//
// Rendering is @resvg/resvg-js (prebuilt native binary, no browser, no network).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { P, resolveChar, loadGlyphs, loadStrokes, overlaySVG, sheetSVG, renderPNG, parseArgs, log } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['upto', 'size', 'out']);
const target = args._[0];
if (!target) {
  console.error('usage: bun render.mjs <char|codepoint> [--seed|--fit] [--upto K] [--sheet] [--glyph-only] [--size N] [--out path]');
  process.exit(2);
}

const entry = resolveChar(target);
const glyph = loadGlyphs().glyphs[entry.char];
if (!glyph) throw new Error(`${entry.char} not in out/glyphs.json — run: bun extract.mjs`);

const which = args.fit ? 'fit' : args.seed ? 'seed' : undefined;
let strokes = [];
let usedWhich = 'none';
if (!args.glyphonly) {
  const ls = loadStrokes(entry, which);
  strokes = ls.data.strokes;
  usedWhich = ls.which;
  if (ls.data.upem !== glyph.upem)
    log(`!! ${entry.char}: stroke file upem=${ls.data.upem} but glyph upem=${glyph.upem} — coordinates will not line up`);
}

const size = args.size ? Number(args.size) : args.sheet ? 1400 : 960;
const upto = args.upto != null && args.upto !== true ? Number(args.upto) : null;

let svg, defaultName;
if (args.sheet) {
  svg = sheetSVG(glyph, strokes, { size });
  defaultName = `out/${entry.file}-${usedWhich}-sheet.png`;
} else if (args.glyphonly) {
  svg = overlaySVG(glyph, [], { size, glyphOnly: true, title: `${entry.char} ${entry.codepoint} glyph only  upem=${glyph.upem} adv=${glyph.advanceWidth}` });
  defaultName = `out/${entry.file}-glyph.png`;
} else {
  svg = overlaySVG(glyph, strokes, {
    size,
    upto,
    title: `${entry.char} ${entry.codepoint}  ${usedWhich}  ${upto != null ? `pens 1..${upto}` : `${strokes.length} pens`}`,
  });
  defaultName = upto != null ? `out/${entry.file}-${usedWhich}-upto${upto}.png` : `out/${entry.file}-${usedWhich}-overlay.png`;
}

const outPath = args.out ? (String(args.out).startsWith('/') ? String(args.out) : P(String(args.out))) : P(defaultName);
mkdirSync(dirname(outPath), { recursive: true });
const png = renderPNG(svg, size);
writeFileSync(outPath, png);
log(
  `${entry.char} ${entry.codepoint} [${args.sheet ? 'sheet' : args.glyphonly ? 'glyph-only' : 'overlay'}] ` +
    `source=${usedWhich} strokes=${strokes.length} -> ${outPath} (${png.length} B)`
);
