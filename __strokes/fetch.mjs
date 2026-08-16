// fetch.mjs — download the two external inputs: the Long Cang webfont and the
// hanzi-writer-data reference stroke JSON. Idempotent; skips files already present
// unless --force. Run: bun fetch.mjs [--force]
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { P, CHARS, log } from './lib.mjs';

const force = process.argv.includes('--force');

const FONT_URLS = [
  'https://raw.githubusercontent.com/google/fonts/main/ofl/longcang/LongCang-Regular.ttf',
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/longcang/LongCang-Regular.ttf',
];

// Fallback: ask Google Fonts CSS for the subsetted woff2. Only used if the raw TTF
// paths break; needs a desktop UA or the API serves a legacy format.
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Long+Cang&text=' +
  encodeURIComponent('杨泓锴');
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function getBuf(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchFont() {
  const dest = P('vendor/LongCang-Regular.ttf');
  if (existsSync(dest) && !force) {
    log(`vendor/LongCang-Regular.ttf exists (${statSync(dest).size} B) — skip`);
    return;
  }
  mkdirSync(P('vendor'), { recursive: true });
  for (const url of FONT_URLS) {
    try {
      const buf = await getBuf(url);
      // sanity: TrueType magic is 0x00010000, or 'true' / 'ttcf' / 'OTTO'
      const tag = buf.readUInt32BE(0);
      if (![0x00010000, 0x74727565, 0x74746366, 0x4f54544f].includes(tag))
        throw new Error(`not a sfnt (magic 0x${tag.toString(16)})`);
      writeFileSync(dest, buf);
      log(`font <- ${url} (${buf.length} B)`);
      return;
    } catch (e) {
      log(`font source failed: ${url} — ${e.message}`);
    }
  }
  // last resort: gstatic woff2 via the CSS API
  const css = (await getBuf(CSS_URL, { 'User-Agent': DESKTOP_UA })).toString('utf8');
  const m = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
  if (!m) throw new Error('no font URL in Google Fonts CSS response:\n' + css.slice(0, 400));
  const buf = await getBuf(m[1], { 'User-Agent': DESKTOP_UA });
  const ext = m[1].endsWith('.woff2') ? 'woff2' : m[1].split('.').pop();
  const alt = P(`vendor/LongCang-subset.${ext}`);
  writeFileSync(alt, buf);
  throw new Error(
    `Only got ${alt} (${buf.length} B, ${ext}). opentype.js cannot read woff2 — ` +
      `decompress it (npm i wawoff2) or swap extract.mjs to fontkit, which reads woff2 natively.`
  );
}

async function fetchData() {
  mkdirSync(P('data'), { recursive: true });
  for (const c of CHARS.chars) {
    const dest = P(c.data);
    if (existsSync(dest) && !force) {
      log(`${c.data} exists — skip`);
      continue;
    }
    const url = `https://cdn.jsdelivr.net/npm/hanzi-writer-data/${encodeURIComponent(c.char)}.json`;
    const buf = await getBuf(url);
    const j = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(j.strokes) || !Array.isArray(j.medians))
      throw new Error(`${c.char}: unexpected schema, keys=${Object.keys(j)}`);
    writeFileSync(dest, buf);
    const flag = j.strokes.length === c.expectedStrokes ? 'ok' : `MISMATCH exp ${c.expectedStrokes}`;
    log(`${c.char} ${c.codepoint} <- hanzi-writer-data: ${j.strokes.length} strokes, ${j.medians.length} medians [${flag}]`);
  }
}

await fetchFont();
await fetchData();
log('fetch done.');
