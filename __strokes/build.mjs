// build.mjs — the last step of the pipeline: turn the Long Cang outlines in
// out/glyphs.json and the hand-fitted pen medians in fit/*.json into the inline
// SVG the site animates, and write it into index.html between the two marker
// comments inside the .name-hanzi button.
//
//   node build.mjs [--dry]
//
// Idempotent: everything between the markers is replaced, so re-running after a
// re-fit is the whole update. --dry prints the markup and the timing table
// without touching index.html.
//
// The architecture is Hanzi Writer's: what you see is always the real glyph
// outline, filled with currentColor; the writing is a <mask> whose white pen
// lines are dash-offset in. See __strokes/README.md.
//
// Three things are baked here rather than left to CSS, all because CSS cannot
// measure them:
//   * each pen's true polyline length, as `stroke-dasharray` and `--hz-len` —
//     deliberately not `pathLength`, which older Safari mis-scales;
//   * each pen's slice of the write, as the fractions `--hz-t0` and `--hz-dt`.
//     The fractions are unitless, so retiming the whole name is one token;
//   * how the nib spends that slice, as `--hz-ease` — a CSS `linear()` sampled
//     off the velocity model below, so the pen slows into a corner and throws
//     itself out of a 撇 instead of crossing every stroke at one speed.
//
// Each mask also gets a white rectangle with a window of its own: the pens
// cannot quite reach the edges of the ink they are drawn over, so once a
// character is written its mask opens the rest of the way while the write is
// still running — and taking the mask off at the end stops being something you
// can see.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CHARS, P, loadGlyphs, loadStrokes, polyLength, penD, r2, log,
  resample, inkAlphaSVG, rasterRGBA, alphaMask,
} from './lib.mjs';

const DRY = process.argv.includes('--dry');

// ── geometry ────────────────────────────────────────────────────────────────
// One em box per character, stacked down the column. The gap between boxes is
// the same 0.14em the live text tracked with (--hanzi-tracking in style.css).
const UPEM = 1000;
const TRACKING = 140;

// The column's total height, in em, and the reason it is not simply 3 × 1.14:
// the old live-text box measured 143.75px tall at font-size 42.24px, because
// Chrome rounds a font's ascent and descent to whole pixels before it advances
// vertical text (37 + 5 rather than 37.17 + 5.07). That rounding is what the
// portrait row was centred against, so the SVG inherits the measured figure and
// spends the difference as trailing space under the last character — the glyphs
// keep their honest 0.14em tracking, and the button keeps its old height.
const COLUMN_EM = 143.75 / 42.24;
const COLUMN_H = r2(COLUMN_EM * UPEM);

// ════════════════════════════════════════════════════════════════════════════
// THE KNOBS — the whole feel of the write is these numbers and nothing else.
// Everything below this block is machinery. Each line says what raising the
// number does to the hand.
//
// Lengths are font units (1000 to the em). Speeds are relative: 1 is the pace
// of a straight, unhurried run through the middle of a stroke. Times are ms of
// the nominal write below — the fractions the markup carries are unitless, so
// changing --hanzi-write-duration stretches the beats along with everything
// else; these figures just say what they are worth at the pace shipped today.
// ════════════════════════════════════════════════════════════════════════════

// The nominal write. Only the ms knobs and the printed table are quoted
// against it; the real figure is --hanzi-write-duration in style.css.
const WRITE_MS = 3000;

// ── along a stroke: the two-thirds power law ────────────────────────────────
// Speed falls as curvature rises — v ∝ (κ + κ₀)^(−β), the relation a real hand
// obeys without being asked. Written here as (1 + κ·BEND_R)^(−BETA).
const BETA = 1 / 3;      // ↑ curvature bites harder: corners crawl, straights fly
const BEND_R = 320;      // ↑ radius counted as "a bend": gentle arcs start costing time too
const V_FLOOR = 0.34;    // ↑ raises the slowest speed: flattens the whole profile toward one pace

// ── the ends: what the nib does when it lands and when it leaves ────────────
// Each end is read off the ink: a blunt, full-thickness terminal is a PRESS,
// a terminal that thins to nothing is a TAPER — the needle a 提 or a hook exits
// on. The classifier is a thickness ratio against the stroke's own body.
const TAPER_AT = 0.5;       // ↑ more ends read as tapered: more whips, fewer settled stops
const TIP_LEN = 18;         // ↑ judges an end over a longer stretch: only long tapers still count

const PRESS_IN_V = 0.46;    // ↑ a pressed start lands running rather than settling
const PRESS_IN_LEN = 0.20;  // ↑ the settle lasts further into the stroke
const PRESS_OUT_V = 0.36;   // ↓ a pressed end comes to a heavier, more deliberate stop
const PRESS_OUT_LEN = 0.24; // ↑ that braking starts earlier
const TAPER_IN_V = 1.30;    // ↑ a hairline entry arrives faster — more attack
const TAPER_IN_LEN = 0.14;  // ↑ the fast entry lasts longer before settling to pace
const WHIP_V = 2.20;        // ↑ a tapered exit is thrown harder: the classic 撇 flick
const WHIP_LEN = 0.32;      // ↑ the throw builds over more of the stroke, less of a snap
const ENTRY_SHAPE = 0.6;    // <1 recovers from an entry quickly; ↑ makes the entry linger
const EXIT_SHAPE = 1.8;     // >1 keeps the exit late and sudden; ↓ spreads it over the tail

// ── dots ────────────────────────────────────────────────────────────────────
// Too short to have a middle. One press, one flick off, and a floor so the
// clock cannot make them subliminal.
const DOT_LEN = 150;        // ↑ more strokes are treated as dots rather than lines
const DOT_V = 0.42;         // ↑ dots are flicked off; ↓ they are pressed and held
const DOT_IN_V = 0.55;      // ↑ the dot is stabbed rather than laid down
const DOT_OUT_V = 1.70;     // ↑ it leaves the paper faster
const DOT_ENDS = 0.4;       // ↑ press and flick eat more of the dot, less of it at pace
const DOT_FLOOR_MS = 34;    // ↑ no dot may be quicker than this — the snap stays legible

// ── between strokes: reach, beat, breath ───────────────────────────────────
// Twenty-seven lifts share the write with twenty-eight strokes, so every
// millisecond of floor here is twenty-seven milliseconds off the writing. The
// arithmetic is worth keeping in view when turning BEAT_MS.
const AIR_SPEED = 2.2;      // ↑ the hand travels through air faster: tighter, busier writing
const BEAT_MS = 30;         // ↑ a bigger minimum pause: consecutive short strokes stop machine-gunning
const LIFT_MAX_MS = 140;    // ↑ long reaches are allowed to read as longer pauses
const BREATH_MS = 90;       // ↑ a longer settle before each new character — more of a paragraph break
const LIFT_JITTER = 0.08;   // ↑ lifts vary more around their computed length (deterministic, from the pen's index)

// ── after a character: the settle ──────────────────────────────────────────
// A pen is a fat line down the middle of a stroke and covers 97.7 to 99.4 per
// cent of the ink it is drawn over. The rest arrives when the mask is dropped,
// and all of it arriving in one frame is a flash. So each mask opens the rest of
// the way on its own once its character is finished: by the time anything drops
// the mask there is nothing left for it to hold back.
const SETTLE_MS = 150;      // ↑ the last of a character's ink arrives more slowly; ↓ nearer a step

// ── how much of the curve the browser is told ──────────────────────────────
const STOP_EVERY = 48;      // ↑ fewer linear() stops per pen: smaller markup, coarser easing
const STOPS_MIN = 10;       // floor and cap on that count — dots need few, long folds need many
const STOPS_MAX = 24;

// ── the measuring instruments (method, not feel) ───────────────────────────
const SAMPLE_STEP = 4;      // font units between velocity samples along a pen
const CURVE_WIN = 45;       // font units: the chord curvature is measured across
const RASTER = UPEM;        // px the glyph is rasterised at for thickness — 1 px = 1 font unit

// ════════════════════════════════════════════════════════════════════════════

const glyphs = loadGlyphs().glyphs;

const chars = CHARS.chars.map((entry, k) => {
  const glyph = glyphs[entry.char];
  if (!glyph) throw new Error(`${entry.char} missing from out/glyphs.json — run: bun extract.mjs`);
  if (glyph.upem !== UPEM) throw new Error(`${entry.char}: upem ${glyph.upem}, expected ${UPEM}`);
  const { data, which } = loadStrokes(entry, 'fit');
  return { entry, glyph, k, y: k * (UPEM + TRACKING), strokes: data.strokes, which };
});

// ── ink thickness ───────────────────────────────────────────────────────────
// A Euclidean distance transform of the glyph's own silhouette. Twice the
// distance to the nearest background pixel is the local thickness of the ink,
// which is how the ends get classified: the head of a 撇 is a pressed wedge and
// measures nearly the full body, its tail is a needle and measures almost
// nothing. Same rasteriser coverage.mjs gates the fit with.
function thicknessMap(glyph) {
  const { w, h, m } = alphaMask(rasterRGBA(inkAlphaSVG(glyph, RASTER), RASTER));
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = m[i] ? INF : 0;

  const n = Math.max(w, h);
  const src = new Float64Array(n), dst = new Float64Array(n);
  const vtx = new Int32Array(n), zed = new Float64Array(n + 1);
  // Felzenszwalb & Huttenlocher: the lower envelope of n parabolas, in O(n).
  const dt1d = (len) => {
    let k = 0;
    vtx[0] = 0; zed[0] = -Infinity; zed[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (src[q] + q * q - (src[vtx[k]] + vtx[k] * vtx[k])) / (2 * q - 2 * vtx[k]);
      while (s <= zed[k]) {
        k--;
        s = (src[q] + q * q - (src[vtx[k]] + vtx[k] * vtx[k])) / (2 * q - 2 * vtx[k]);
      }
      k++; vtx[k] = q; zed[k] = s; zed[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (zed[k + 1] < q) k++;
      dst[q] = (q - vtx[k]) * (q - vtx[k]) + src[vtx[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) src[y] = f[y * w + x];
    dt1d(h);
    for (let y = 0; y < h; y++) f[y * w + x] = dst[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) src[x] = f[y * w + x];
    dt1d(w);
    for (let x = 0; x < w; x++) f[y * w + x] = dst[x];
  }
  const scale = RASTER / UPEM;
  return (px, py) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(px * scale)));
    const y = Math.min(h - 1, Math.max(0, Math.round(py * scale)));
    return (2 * Math.sqrt(f[y * w + x])) / scale; // font units
  };
}

// ── the velocity model ──────────────────────────────────────────────────────
/** Curvature of the circle through three points (Menger); 0 if degenerate. */
function menger(a, b, c) {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  if (ab < 1e-9 || bc < 1e-9 || ca < 1e-9) return 0;
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return (2 * Math.abs(cross)) / (ab * bc * ca);
}

/** Box average over ±r samples, ends clamped. */
function smooth(arr, r) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let j = i - r; j <= i + r; j++) {
      s += arr[Math.min(arr.length - 1, Math.max(0, j))];
      n++;
    }
    out[i] = s / n;
  }
  return out;
}

/**
 * How thick the ink is at one end of a pen: the mean thickness over the last
 * TIP_LEN of travel. A mean rather than a single reading at the terminal,
 * because one pixel at the very tip is one pixel, and a median that stops a
 * hair short of the ink would report a needle where there is a blunt end. What
 * separates the two cases is not the tip itself but how fast the ink recovers
 * behind it — a press is back to full body within a few units, a taper is not.
 */
function endThickness(samples, L, thickness, fromStart) {
  const ds = L / (samples.length - 1);
  const span = Math.min(samples.length - 1, Math.max(1, Math.round(TIP_LEN / ds)));
  let sum = 0;
  for (let j = 0; j <= span; j++) {
    const p = fromStart ? samples[j] : samples[samples.length - 1 - j];
    sum += thickness(p[0], p[1]);
  }
  return sum / (span + 1);
}

/**
 * Everything the timing needs to know about one pen: where it is slow, how long
 * it therefore takes, and the progress curve the browser should follow.
 */
function profilePen(pen, thickness) {
  const L = pen.length;
  const n = Math.max(8, Math.min(600, Math.round(L / SAMPLE_STEP) + 1));
  const S = resample(pen.points, n);
  const ds = L / (n - 1);
  const isDot = L < DOT_LEN;

  // Ends, read off the ink. The body reference is the median thickness over the
  // middle of the stroke — a median rather than a max because a pen that runs
  // through a junction picks up its neighbour's ink there.
  const body = (() => {
    const mid = [];
    for (let i = Math.round(n * 0.2); i <= Math.round(n * 0.8); i++) mid.push(thickness(S[i][0], S[i][1]));
    mid.sort((a, b) => a - b);
    return mid[Math.floor(mid.length / 2)] || 1;
  })();
  const thIn = endThickness(S, L, thickness, true);
  const thOut = endThickness(S, L, thickness, false);
  const rIn = thIn / body, rOut = thOut / body;
  const startPressed = rIn >= TAPER_AT;
  const endPressed = rOut >= TAPER_AT;

  // Curvature, measured across a chord rather than between neighbours — a
  // hand-fitted polyline is angular, and the corner a person sees is the turn
  // taken over a finger's width of paper, not the angle at one vertex.
  const w = Math.max(1, Math.round(CURVE_WIN / ds));
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++)
    raw[i] = menger(S[Math.max(0, i - w)], S[i], S[Math.min(n - 1, i + w)]);
  const kap = smooth(raw, Math.max(1, Math.round(w / 2)));

  const inV = isDot ? DOT_IN_V : startPressed ? PRESS_IN_V : TAPER_IN_V;
  const inLen = isDot ? DOT_ENDS : startPressed ? PRESS_IN_LEN : TAPER_IN_LEN;
  const outV = isDot ? DOT_OUT_V : endPressed ? PRESS_OUT_V : WHIP_V;
  const outLen = isDot ? DOT_ENDS : endPressed ? PRESS_OUT_LEN : WHIP_LEN;

  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    // A dot has no middle worth a power law; everything else is curvature-led.
    let s = isDot ? DOT_V : Math.max(V_FLOOR, Math.pow(1 + kap[i] * BEND_R, -BETA));
    if (u < inLen) s *= inV + (1 - inV) * Math.pow(u / inLen, ENTRY_SHAPE);
    if (u > 1 - outLen) s *= 1 + (outV - 1) * Math.pow((u - (1 - outLen)) / outLen, EXIT_SHAPE);
    v[i] = s;
  }

  // t(s) = ∫ ds/v, trapezoid on 1/v.
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + (ds * (1 / v[i - 1] + 1 / v[i])) / 2;
  const T = t[n - 1];

  // Invert onto a uniform time grid: what fraction of the stroke is drawn by
  // each fraction of its slice. That is exactly what CSS linear() wants.
  const stops = Math.min(STOPS_MAX, Math.max(STOPS_MIN, Math.round(L / STOP_EVERY)));
  const p = [0];
  let j = 1;
  for (let q = 1; q < stops; q++) {
    const tq = (T * q) / stops;
    while (j < n - 1 && t[j] < tq) j++;
    const t0 = t[j - 1], t1 = t[j];
    const f = t1 > t0 ? (tq - t0) / (t1 - t0) : 0;
    p.push((ds * (j - 1 + f)) / L);
  }
  p.push(1);

  let vmin = Infinity, vmax = 0;
  for (const x of v) { if (x < vmin) vmin = x; if (x > vmax) vmax = x; }
  return {
    ticks: T,                 // font units of time at speed 1
    vmean: L / T, vmin, vmax,
    ends: (startPressed ? 'P' : 'T') + (endPressed ? 'P' : 'T'),
    rIn, rOut, isDot,
    ease: p,
  };
}

/** Deterministic 0..1 from an integer — the only variation in the build. */
function hash01(i) {
  let x = Math.imul(i + 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 15;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

// ── one flat list of pens, in writing order ─────────────────────────────────
const pens = [];
let prev = null;
for (const char of chars) {
  const thickness = thicknessMap(char.glyph);
  for (const s of char.strokes) {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    const start = [first[0], first[1] + char.y];
    const end = [last[0], last[1] + char.y];
    const reach = prev ? Math.hypot(start[0] - prev[0], start[1] - prev[1]) : 0;
    const pen = {
      char: char.entry.char,
      file: char.entry.file,
      k: char.k,
      i: s.i,
      width: s.width,
      points: s.points,
      // Rounded up, so a dash can never fall a rounding error short of the line.
      length: Math.ceil(polyLength(s.points) * 100) / 100,
      reach,
      firstOfChar: s === char.strokes[0],
    };
    Object.assign(pen, profilePen(pen, thickness));
    pens.push(pen);
    prev = end;
  }
}

// ── the clock ───────────────────────────────────────────────────────────────
// Two currencies have to be reconciled. Ink and air are measured in font units
// of travel, and scale with the write; the beat, the breath and the dot's floor
// are stated in milliseconds, because they are limits of perception and do not
// care how far the nib went. So the rate is solved for rather than assumed:
// guess a ms-per-unit, spend it, see what the write costs, correct, repeat. The
// costs only ever rise with the rate, so the rate is found by halving the
// interval it must lie in — monotone, so this is exact, and it does not care
// how much of the write the fixed millisecond floors have already claimed.
const spend = (r) => {
  let total = 0;
  for (const [n, p] of pens.entries()) {
    p.inkMs = p.isDot ? Math.max(DOT_FLOOR_MS, p.ticks * r) : p.ticks * r;
    if (n === 0) p.liftMs = 0;
    else {
      const reachMs = Math.min(LIFT_MAX_MS, Math.max(BEAT_MS, (p.reach / AIR_SPEED) * r));
      const breath = p.firstOfChar ? BREATH_MS : 0;
      p.liftMs = (reachMs + breath) * (1 + LIFT_JITTER * (2 * hash01(n) - 1));
    }
    total += p.inkMs + p.liftMs;
  }
  return total;
};
let lo = 0, hi = WRITE_MS / pens.reduce((s, p) => s + p.ticks + p.reach / AIR_SPEED, 0);
for (let grow = 0; grow < 40 && spend(hi) < WRITE_MS; grow++) hi *= 2;
if (spend(hi) < WRITE_MS) throw new Error('no rate spends the whole write — check the knobs');
for (let pass = 0; pass < 200; pass++) {
  const mid = (lo + hi) / 2;
  if (spend(mid) < WRITE_MS) lo = mid; else hi = mid;
}
const rate = (lo + hi) / 2;
const total = spend(rate);
if (Math.abs(total - WRITE_MS) > 1e-6)
  throw new Error(`the clock did not settle: ${total.toFixed(6)}ms against ${WRITE_MS}ms`);

let clock = 0;
for (const p of pens) {
  clock += p.liftMs;
  p.t0 = clock / WRITE_MS;
  p.dt = p.inkMs / WRITE_MS;
  clock += p.inkMs;
}
// Round for the markup, then hand the last pen whatever is left: it is the pen
// that ends the write, and the end of the write has to be exactly 1.
const f4 = (n) => Number(n.toFixed(4));
for (const p of pens) {
  p.t0 = f4(p.t0);
  p.dt = f4(p.dt);
}
const last = pens[pens.length - 1];
last.dt = f4(1 - last.t0);

// ── the settle ──────────────────────────────────────────────────────────────
// One window per character, in the same unitless fractions the pens carry, for
// the opening that closes the gap between the pens and the ink. It wants to
// start as the character's last stroke lands and run SETTLE_MS, so the weight
// arrives during the lift and the breath into the next character — where there
// is other motion to look at.
//
// The end of the write is a wall, and the last character's window has to be
// pushed back against it: it ends at exactly 1, the moment the mask comes off,
// or the strip has something left to reveal. Pushing it back sends it over
// strokes that have not been written yet, and a mask that opens over an
// unwritten stroke shows it — a grey bar sitting there waiting for the nib,
// which is worse than the flash this is here to remove. So it may go back as far
// as the moment the nib lands on that last stroke and no further; that leaves a
// shorter window against the wall, which is the right way to spend the
// difference.
const SETTLE_DT = SETTLE_MS / WRITE_MS;
for (const char of chars) {
  const mine = pens.filter((p) => p.k === char.k);
  const lastPen = mine[mine.length - 1];
  const t0 = Math.min(lastPen.t0 + lastPen.dt, Math.max(1 - SETTLE_DT, lastPen.t0));
  char.settle = { t0: f4(t0), dt: f4(Math.min(SETTLE_DT, 1 - t0)) };
}

// ── markup ──────────────────────────────────────────────────────────────────
// stroke-linecap/linejoin round and one polyline per pen: the same geometry
// render.mjs drew the approved contact sheets with, so the browser reproduces
// the coverage those sheets were signed off on.
const pad = (n) => ' '.repeat(n);
const num = (n) => String(Number(n.toFixed(4)));

// linear() with bare values spaces its stops evenly across the animation, which
// is exactly the grid the curve was inverted onto — so only the progress values
// are emitted, and the input percentages cost nothing.
function easeCSS(p) {
  const out = [];
  let prevV = 0;
  for (const v of p) {
    const q = Math.min(1, Math.max(prevV, Number(v.toFixed(3))));
    out.push(String(q));
    prevV = q;
  }
  out[0] = '0';
  out[out.length - 1] = '1';
  return `linear(${out.join(', ')})`;
}

function penMarkup(p, indent) {
  // The last pen of the last character carries a class of its own: the
  // stylesheet gives it its own keyframe name, so the one animation that means
  // "the name is written" can be told from the twenty-seven that don't.
  const cls = p === pens[pens.length - 1] ? 'hz-pen hz-last' : 'hz-pen';
  return (
    `${pad(indent)}<path class="${cls}" d="${penD(p.points)}" fill="none" stroke="#fff" ` +
    `stroke-width="${r2(p.width)}" stroke-linecap="round" stroke-linejoin="round" ` +
    `stroke-dasharray="${p.length}" ` +
    `style="--hz-len: ${p.length}px; --hz-t0: ${num(p.t0)}; --hz-dt: ${num(p.dt)}; ` +
    `--hz-ease: ${easeCSS(p.ease)}"/>`
  );
}

function charMarkup(char, indent) {
  const id = `hz-m-${char.k}`;
  const mine = pens.filter((p) => p.k === char.k);
  const lines = [
    `${pad(indent)}<g transform="translate(0 ${char.y})">`,
    // maskUnits userSpaceOnUse: the region is this character's em box, in the
    // group's own coordinates. Left to default it would be a percentage of the
    // outline's bounding box, which is not the same rectangle.
    `${pad(indent + 4)}<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${UPEM}" height="${UPEM}">`,
    `${pad(indent + 8)}<rect x="0" y="0" width="${UPEM}" height="${UPEM}" fill="#000"/>`,
    ...mine.map((p) => penMarkup(p, indent + 8)),
    // What the mask converges to once the character is written: white over the
    // whole em box, held transparent for the length of the write and faded up in
    // its own window. Only ink can show through a mask, so opening it this far
    // shows nothing the character does not already contain — and it is the one
    // shape that leaves the outline's own soft edge alone. A white copy of the
    // glyph was the obvious thing to put here and it is measurably wrong: its
    // edge is antialiased too, so it multiplies every contour by a second copy
    // of itself and the name still gains weight when the mask comes off.
    `${pad(indent + 8)}<rect class="hz-fill" x="0" y="0" width="${UPEM}" height="${UPEM}" fill="#fff" ` +
      `style="--hz-t0: ${num(char.settle.t0)}; --hz-dt: ${num(char.settle.dt)}"/>`,
    `${pad(indent + 4)}</mask>`,
    `${pad(indent + 4)}<path fill="currentColor" d="${char.glyph.d}" mask="url(#${id})"/>`,
    `${pad(indent)}</g>`,
  ];
  return lines.join('\n');
}

const INDENT = 20; // the depth of the button's children in index.html
const svg = [
  `${pad(INDENT)}<svg class="hanzi-strokes" viewBox="0 0 ${UPEM} ${COLUMN_H}" style="--hz-aspect: ${COLUMN_EM.toFixed(5)}" aria-hidden="true" focusable="false">`,
  ...chars.map((char) => charMarkup(char, INDENT + 4)),
  `${pad(INDENT)}</svg>`,
].join('\n');

// ── injection ───────────────────────────────────────────────────────────────
const BEGIN = '<!-- hanzi-strokes:begin generated by __strokes/build.mjs -->';
const END = '<!-- hanzi-strokes:end -->';
const htmlPath = P('../index.html');

if (!DRY) {
  const html = readFileSync(htmlPath, 'utf8');
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  if (a === -1 || b === -1 || b < a)
    throw new Error(
      `index.html has no ${BEGIN} … ${END} pair. Put both inside the .name-hanzi button, ` +
        `after the visually-hidden span, and re-run.`
    );
  const next = html.slice(0, a + BEGIN.length) + '\n' + svg + '\n' + pad(INDENT) + html.slice(b);
  if (next !== html) writeFileSync(htmlPath, next);
  log(`${next === html ? 'unchanged' : 'wrote'} ${htmlPath} (+${svg.length} B of SVG)`);
} else {
  log(svg);
}

// ── the table ───────────────────────────────────────────────────────────────
const easeBytes = pens.reduce((s, p) => s + easeCSS(p.ease).length, 0);
log('');
log(`column  viewBox 0 0 ${UPEM} ${COLUMN_H}   (${COLUMN_EM.toFixed(5)}em tall, em boxes at y = k × ${UPEM + TRACKING})`);
log(
  `timing  v ∝ (1 + κ·${BEND_R})^-${BETA.toFixed(3)} floored at ${V_FLOOR}; ends read off the ink at ` +
    `${TAPER_AT} of body thickness; air ${AIR_SPEED}× ink, beat ${BEAT_MS}ms, breath ${BREATH_MS}ms`
);
const inkMs = pens.reduce((s, p) => s + p.inkMs, 0);
log(`        ${(1 / rate).toFixed(2)} font units of straight-run travel per ms of a ${WRITE_MS}ms write`);
log(
  `        ${Math.round(inkMs)}ms in ink (${((100 * inkMs) / WRITE_MS).toFixed(1)}%), ` +
    `${Math.round(WRITE_MS - inkMs)}ms in air (${((100 * (WRITE_MS - inkMs)) / WRITE_MS).toFixed(1)}%) over 27 lifts`
);
log(`        easing: ${pens.reduce((s, p) => s + p.ease.length, 0)} linear() stops over 28 pens, ${easeBytes} B`);
log('');
log(' #   char stroke   length     lift      ink   ends   in%  out%     v̄    vmin   vmax      t0      dt        start        end');
for (const [n, p] of pens.entries()) {
  const row = [
    String(n + 1).padStart(2),
    p.char.padStart(4),
    String(p.i + 1).padStart(5),
    p.length.toFixed(1).padStart(9),
    `${Math.round(p.liftMs)}ms`.padStart(9),
    `${Math.round(p.inkMs)}ms`.padStart(9),
    (p.isDot ? '·' + p.ends : ' ' + p.ends).padStart(6),
    p.rIn.toFixed(2).padStart(5),
    p.rOut.toFixed(2).padStart(5),
    p.vmean.toFixed(2).padStart(6),
    p.vmin.toFixed(2).padStart(6),
    p.vmax.toFixed(2).padStart(6),
    num(p.t0).padStart(7),
    num(p.dt).padStart(7),
    `${Math.round(p.t0 * WRITE_MS)}ms`.padStart(11),
    `${Math.round((p.t0 + p.dt) * WRITE_MS)}ms`.padStart(11),
  ];
  log(row.join(' '));
}
log('');
log('ends: P pressed (blunt, full-thickness terminal), T tapered (thins to a needle); · = dot');
log('');
for (const char of chars) {
  const mine = pens.filter((p) => p.k === char.k);
  const t0 = mine[0].t0;
  const t1 = mine[mine.length - 1].t0 + mine[mine.length - 1].dt;
  const s = char.settle;
  log(
    `${char.entry.char}  ${String(mine.length).padStart(2)} pens  ` +
      `${(t0 * 100).toFixed(1).padStart(5)}% → ${(t1 * 100).toFixed(1).padStart(5)}%  ` +
      `(${Math.round(t0 * WRITE_MS)}–${Math.round(t1 * WRITE_MS)}ms)  ` +
      `settle ${Math.round(s.t0 * WRITE_MS)}–${Math.round((s.t0 + s.dt) * WRITE_MS)}ms`
  );
}
