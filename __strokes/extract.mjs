// extract.mjs — Long Cang TTF -> out/glyphs.json
//
// Produces, per character, an SVG path `d` in FONT UNITS, y-down, positioned inside a
// square em box (0..upem on both axes) the way a browser lays out full-width CJK:
//   x offset dx = (upem - advanceWidth) / 2      (horizontal centring in the em box)
//   baseline at y = ascentUsed                    (vertical placement)
//
// Choosing ascentUsed: we want ascent - descent === upem exactly, so the box is square
// and the glyph is not vertically squashed relative to its design. Preference order:
//   1. OS/2 sTypoAscender/sTypoDescender if their span == upem
//   2. hhea ascender/descender if their span == upem
//   3. otherwise NORMALISE: keep the ascent:descent ratio but rescale the span to upem,
//      i.e. ascentUsed = upem * asc / (asc - desc). The outline is NOT scaled — only the
//      baseline's position within the square box is derived from the ratio.
//
// Run: bun extract.mjs [--font path]
import { existsSync, readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { P, CHARS, writeJSON, log, r2, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['font']);
const FONT = args.font ? (args.font.startsWith('/') ? args.font : P(args.font)) : P('vendor/LongCang-Regular.ttf');
if (!existsSync(FONT)) throw new Error(`font not found: ${FONT} — run: bun fetch.mjs`);

// opentype.js >=1.3.5 stubs out loadSync(); parse() takes a Buffer/ArrayBuffer.
const font = opentype.parse(readFileSync(FONT));
const upem = font.unitsPerEm;
const hhea = font.tables.hhea || {};
const os2 = font.tables.os2 || {};

// opentype.js >=1.3.5 nests names per platform (names.windows/macintosh/unicode);
// older builds put them flat on names. Accept either shape.
function nameOf(key) {
  const n = font.names || {};
  for (const rec of [n, n.windows, n.macintosh, n.unicode]) {
    const v = rec && rec[key];
    if (v && (v.en || Object.values(v)[0])) return v.en || Object.values(v)[0];
  }
  return null;
}

function pickVertical() {
  const cands = [
    { source: 'OS/2 sTypoAscender/sTypoDescender', asc: os2.sTypoAscender, desc: os2.sTypoDescender },
    { source: 'hhea ascender/descender', asc: hhea.ascender, desc: hhea.descender },
    { source: 'OS/2 usWinAscent/usWinDescent', asc: os2.usWinAscent, desc: os2.usWinDescent != null ? -os2.usWinDescent : undefined },
  ].filter((c) => Number.isFinite(c.asc) && Number.isFinite(c.desc) && c.asc - c.desc > 0);
  if (!cands.length) throw new Error('no usable vertical metrics in font');
  for (const c of cands)
    if (Math.abs(c.asc - c.desc - upem) <= 1)
      return { ...c, span: c.asc - c.desc, ascentUsed: c.asc, normalized: false };
  const c = cands[0];
  const span = c.asc - c.desc;
  return { ...c, span, ascentUsed: Math.round((upem * c.asc) / span), normalized: true };
}

const V = pickVertical();
log(`font: ${nameOf('fontFamily') || '?'} ${nameOf('fontSubfamily') || ''}`);
log(`upem=${upem}  numGlyphs=${font.numGlyphs}`);
log(`hhea asc/desc = ${hhea.ascender}/${hhea.descender} (span ${hhea.ascender - hhea.descender})`);
log(`OS/2 sTypo asc/desc = ${os2.sTypoAscender}/${os2.sTypoDescender} (span ${os2.sTypoAscender - os2.sTypoDescender})`);
log(`OS/2 win asc/desc = ${os2.usWinAscent}/${os2.usWinDescent}`);
log(`vertical metric chosen: ${V.source} -> ascentUsed=${V.ascentUsed} (span ${V.span}${V.normalized ? ', NORMALISED to upem' : ''})`);

const out = {
  generated: new Date().toISOString(),
  font: {
    file: 'vendor/LongCang-Regular.ttf',
    family: nameOf('fontFamily'),
    upem,
    numGlyphs: font.numGlyphs,
    hheaAscender: hhea.ascender,
    hheaDescender: hhea.descender,
    sTypoAscender: os2.sTypoAscender,
    sTypoDescender: os2.sTypoDescender,
    usWinAscent: os2.usWinAscent,
    usWinDescent: os2.usWinDescent,
    metricSource: V.source,
    ascentUsed: V.ascentUsed,
    descentUsed: V.ascentUsed - upem,
    normalized: V.normalized,
  },
  glyphs: {},
};

let missing = 0;
for (const c of CHARS.chars) {
  const glyph = font.charToGlyph(c.char);
  if (!glyph || glyph.index === 0) {
    log(`!! ${c.char} ${c.codepoint}: NO GLYPH (.notdef) in this font`);
    missing++;
    continue;
  }
  const advanceWidth = glyph.advanceWidth;
  const dx = (upem - advanceWidth) / 2;
  // fontSize = upem -> scale 1; opentype flips y for screen coords and puts the
  // baseline at the y argument, which is exactly the em-box placement we want.
  const path = glyph.getPath(dx, V.ascentUsed, upem);
  const d = path.toPathData(2);
  const bb = path.getBoundingBox();
  const ink = { x1: r2(bb.x1), y1: r2(bb.y1), x2: r2(bb.x2), y2: r2(bb.y2), w: r2(bb.x2 - bb.x1), h: r2(bb.y2 - bb.y1) };
  out.glyphs[c.char] = {
    char: c.char,
    codepoint: c.codepoint,
    file: c.file,
    gid: glyph.index,
    upem,
    advanceWidth,
    dx: r2(dx),
    ascent: V.ascentUsed,
    descent: V.ascentUsed - upem,
    baseline: V.ascentUsed,
    metricSource: V.source,
    ink,
    d,
  };
  const oob =
    ink.x1 < -1 || ink.y1 < -1 || ink.x2 > upem + 1 || ink.y2 > upem + 1 ? '  <-- INK OUTSIDE EM BOX' : '';
  log(
    `${c.char} ${c.codepoint} gid=${glyph.index} adv=${advanceWidth} dx=${r2(dx)} ` +
      `ink=[${ink.x1},${ink.y1} .. ${ink.x2},${ink.y2}] ${ink.w}x${ink.h} dLen=${d.length}${oob}`
  );
}
if (missing) throw new Error(`${missing} character(s) have no glyph in this font`);

const p = writeJSON('out/glyphs.json', out);
log(`wrote ${p}`);
