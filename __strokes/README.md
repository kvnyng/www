# `__strokes/` — stroke-animation data pipeline for 杨泓锴

Intermediates only. **Nothing here is loaded by the site at runtime** — no script, style
or asset in this folder is fetched by a page. One script does *write* to a site file:
`build.mjs` regenerates the inline SVG inside `index.html`, between its two
`hanzi-strokes:` marker comments, and nothing else in that file or any other. The `__`
prefix marks scratch/derived work (cf. `__masktest.html`). This folder carries its own
`package.json` so its dependencies never leak into the root project.

The data end product is `fit/u*.json` — hand-fittable **pen medians** in font units — plus
`out/glyphs.json`, the Long Cang glyph outlines they are fitted to. `build.mjs` is what
turns the pair into the thing the page animates.

## The technique

Same trick Hanzi Writer uses. The visible artwork is always the *real* glyph outline; the
animation comes from an SVG `<mask>`. Each stroke is a thick, round-capped "pen" line
running along the stroke's **centreline (median)**. Revealing pens 1..k in canonical
stroke order, and animating each pen's `stroke-dashoffset` from full length to zero, makes
the glyph appear to be written. So the data we need per character is: an outline path, and
an ordered list of medians with a pen width fat enough to cover the ink.

Long Cang is a *cursive* face. Its strokes are slanted, ligated, and frequently sweep
outside where a printed-kai skeleton would put them, so machine-seeded medians are a
starting point, not an answer. `coverage.mjs` is the objective gate.

## Coordinate conventions

Get these wrong and you get the classic y-flip. Everything downstream of `extract.mjs`
uses **one** system:

> A square em box, `viewBox="0 0 <upem> <upem>"`, **y-down**, origin top-left.
> The glyph is centred horizontally: `dx = (upem - advanceWidth) / 2`.
> The baseline sits at `y = ascentUsed`.

This is how a browser lays out a full-width CJK glyph in a square box. Glyph `d` and pen
`points` are in the same box, so an SVG can draw both with no extra transform.

**Picking `ascentUsed`.** The box must be exactly `upem` tall or the glyph gets squashed
relative to the pens. Preference order (`extract.mjs`):

1. OS/2 `sTypoAscender`/`sTypoDescender` if their span == upem
2. hhea `ascender`/`descender` if their span == upem
3. otherwise **normalise**: keep the ascent:descent *ratio* but rescale the span to upem,
   `ascentUsed = upem * asc / (asc - desc)`. Only the baseline's position within the square
   box is derived from the ratio — the outline itself is never scaled.

The metric actually used is recorded in `out/glyphs.json` as `font.metricSource`,
`font.ascentUsed`, `font.normalized`, and per glyph as `ascent` / `baseline`.

**hanzi-writer-data's system** (input only, converted away in `seed.mjs`): x,y in a
1024-unit box, **y-up**, with the visual top at `y = 900` — their SVGs wrap the glyph in
`transform="scale(1,-1) translate(0,-900)"`. So a data point `(x, y)` draws at
`(x, 900 - y)` in a 1024-unit y-down box. `seed.mjs` applies that flip first, then scales
`1024 -> upem`.

## Layout

```
vendor/LongCang-Regular.ttf   the webfont (OFL) — downloaded, not committed by hand
data/u6768.json              raw hanzi-writer-data, one per char (ASCII-safe filenames)
data/u6CD3.json
data/u9534.json
chars.json                   manifest: codepoint <-> char <-> filenames, expected stroke counts
lib.mjs                      shared: paths, char resolution, geometry, SVG builders, rasteriser
fetch.mjs                    downloads font + reference data (idempotent)
extract.mjs                  font -> out/glyphs.json
seed.mjs                     reference medians -> out/seed/*.json (+ copy to fit/)
render.mjs                   overlay / contact-sheet renderer -> PNG
coverage.mjs                 ink-coverage metric
build.mjs                    glyphs + fit/ -> the inline SVG in ../index.html (idempotent)
fit/u*.json                  WORKING COPIES — hand-fitted; seed.mjs will not clobber these
out/                         generated: glyphs.json, seed/, PNGs
```

## Regenerating everything

```sh
cd __strokes
bun install
bun fetch.mjs        # vendor/ + data/   (add --force to re-download)
bun extract.mjs      # -> out/glyphs.json
bun seed.mjs         # -> out/seed/*.json, and fit/*.json if absent
```

`bun run all` chains the three. `seed.mjs --force` resets `fit/` from the seeds —
**this discards hand-fitting**, which is why it is opt-in.

## Scripts

### `fetch.mjs [--force]`

Downloads `vendor/LongCang-Regular.ttf` from `google/fonts` (raw.githubusercontent, with a
jsDelivr mirror as backup) and the three `hanzi-writer-data` JSONs from jsDelivr. Verifies
the font is a real sfnt and that each JSON has `strokes`/`medians`, and flags any stroke
count that disagrees with `chars.json`. Skips files that already exist.

If both raw TTF URLs break, it falls back to the Google Fonts CSS API
(`css2?family=Long+Cang&text=杨泓锴`, desktop User-Agent) and saves the gstatic **woff2** —
opentype.js cannot read woff2, so in that case either decompress it (`wawoff2`) or switch
`extract.mjs` to `fontkit`, which reads woff2 natively.

### `extract.mjs [--font path]`

Font -> `out/glyphs.json`. Per glyph records `char`, `codepoint`, `gid`, `d` (SVG path in
font units, y-down, em-box positioned), `upem`, `advanceWidth`, `dx`, `ascent`/`baseline`,
`metricSource`, and the ink bounding box. Prints the font's full vertical metrics and warns
if any ink falls outside the em box. Throws if a character has no glyph.

### `seed.mjs [--width 0.07] [--minpts 10] [--maxpts 30] [--force]`

Reference medians -> font-unit medians. Stage 1 is the fixed
`(x, 900-y) * upem/1024` mapping. Stage 2 is a per-character affine (separate x/y scale +
translate) fitting the median cloud's bbox onto the Long Cang **ink bbox inset by half a
pen width** — the centreline of a round-capped pen sits half a width inside the ink edge.
Medians are arc-length resampled to 10–30 points, preserving direction.

Output schema:

```json
{ "char": "杨", "upem": 1000, "strokes": [
  { "i": 0, "refIndices": [0], "width": 70, "points": [[x, y], "..."] }
] }
```

`width` defaults to 7% of upem. `refIndices` records which canonical hanzi-writer strokes a
pen path covers — it exists so a later agent can **merge ligated strokes** into one pen
(e.g. `refIndices: [4, 5]`) and still know the canonical order. Extra top-level keys
(`transform`, `inkBBox`, `widthFrac`) are diagnostics for the fitting pass.

### `render.mjs <char|codepoint> [--seed|--fit] [--upto K] [--sheet] [--glyph-only] [--size N] [--out path]`

The character can be `杨`, `u6768`, `U+6768`, or `6768`. Source defaults to `fit` when
present, else `seed`; force with `--seed`/`--fit`. Default size 960 px (1400 for sheets).

- **overlay** (default) — mid-grey glyph silhouette, each pen stroked at its own `width` in
  translucent red with round caps/joins, the median as a thin blue polyline with point
  dots, a **green dot at each stroke's START** (direction check), and the stroke number
  beside it. Faint em-box frame, centre cross, and baseline are drawn as reference.
- `--upto K` — overlay with only pens 1..K.
- `--glyph-only` — silhouette alone, to eyeball em-box placement.
- `--sheet` — contact sheet, frame k = glyph masked by pens 1..k for k = 0..N. A
  browser-free simulation of the progressive reveal; frame 0 is blank and the **final frame
  should show the complete glyph**. If it doesn't, the pens don't cover the ink.

Rendering is `@resvg/resvg-js` — a prebuilt native binary, no browser, no network.
Stroke-number labels need a system font; resvg is started with `loadSystemFonts: true`.

### `coverage.mjs <char|codepoint> [--seed|--fit] [--size 512] [--json]`

Rasterises the glyph ink alpha and the pen union at >=512 px and prints:

- **(a) ink coverage** `|ink n pens| / |ink|` — how much of the glyph the pens reveal
- **(b) per-pen outside-ink** `|pen_i \ ink| / |pen_i|` — how much each pen spills off

**Targets: ink coverage >= 97%, outside-ink <= ~25% per pen.** `--json` emits the same
numbers machine-readably.

### `build.mjs [--dry]`

`out/glyphs.json` + `fit/u*.json` -> the inline SVG in `../index.html`, written between
`<!-- hanzi-strokes:begin … -->` and `<!-- hanzi-strokes:end -->` inside the `.name-hanzi`
button. Idempotent: the block is replaced wholesale, so re-running after a re-fit is the
whole update. `--dry` prints the markup and the table without touching the file.

One `<mask>` per character, one white round-capped polyline per pen inside it — the same
geometry `render.mjs` draws the contact sheets with, so the browser reproduces the coverage
those sheets were signed off on. What the browser adds is the dash: each pen carries its
own polyline length (as `stroke-dasharray` and `--hz-len`, measured here rather than left
to `pathLength`, which older Safari mis-scales), its slice of the write as the unitless
fractions `--hz-t0` / `--hz-dt`, and the shape of that slice as `--hz-ease`. The stylesheet
turns those into 28 delayed animations off one duration token, plus the three below.

Last in each mask, after the pens, is `<rect class="hz-fill">` over the whole em box, with a
`--hz-t0` / `--hz-dt` window of its own — **the settle**. Pens cover 97.7–99.4% of the ink
they are drawn over, and their own antialiased edges shave a little off the outline's, so a
mask made of pens alone holds back about 3% of the name's ink mass at dpr 2 and 7% at dpr 1.
Dropping it at the end of the write delivers all of that in one frame, across the whole
name, which is what a viewer reports as a flash. So each mask fades itself fully open as its
character finishes and the strip has nothing left to reveal: measured at the moment the
class comes off, 2.91% → 0.076% at dpr 2, with no pixel moving more than 1/255. A white copy
of the glyph was the first thing tried in that slot and only got it to 2.18%: its edge is
antialiased too, so every contour comes out multiplied by a second soft copy of itself. Only
a shape that covers the glyph's edge completely leaves the outline as drawn — and a mask can
only subtract, so opening one over an em box that contains nothing but this character shows
nothing that character does not already have.

#### The timing model

The point of the model is that a hand is not a plotter: it does not cross every stroke at
one speed, and the time a stroke costs is not its length. Three things decide the spend,
and **every constant is in one commented block at the top of `build.mjs`** — that block is
the tuning surface; nothing below it is meant to be edited to change the feel.

1. **Along a stroke — curvature.** Each pen is resampled by arc length every 4 units, local
   curvature κ(s) is measured across a 45-unit chord (Menger, then box-smoothed: a
   hand-fitted polyline is angular, and the corner a person sees is the turn taken over a
   finger's width of paper, not the angle at one vertex), and tangential speed follows the
   two-thirds power law as `v ∝ (1 + κ·BEND_R)^−BETA`, floored at `V_FLOOR`. Straights run
   at 1, the tightest corners at about a third of that.
2. **At the ends — press and whip.** The glyph silhouette is rasterised at 1 px per font
   unit and a Euclidean distance transform gives the local ink thickness. Averaged over the
   last `TIP_LEN` of travel and divided by the stroke's own body thickness, that separates a
   **pressed** end (blunt, full-thickness — the nib landed or stopped there) from a
   **tapered** one (thins to a needle — a 提 exit, a hook, the tail of a 撇). A pressed
   start ramps in from `PRESS_IN_V`; a pressed end brakes to `PRESS_OUT_V`; a tapered start
   arrives at `TAPER_IN_V`; a tapered end accelerates to `WHIP_V` and is still speeding up
   when the dash lands. Pens shorter than `DOT_LEN` skip all of it: a dot gets one press
   profile and a floor duration.
3. **Between strokes — reach, beat, breath.** The lift is still proportional to how far the
   hand is carried, in *column* coordinates, so the drop to the next character costs more
   than the step to the stroke beside it. Under it sits `BEAT_MS`, so two short strokes in a
   row cannot machine-gun; over it `LIFT_MAX_MS`; and the first stroke of each character
   gets `BREATH_MS` on top. `LIFT_JITTER` varies each lift a few percent, derived from a
   hash of the pen's index — deterministic, so the build stays byte-identical.
4. **After a character — the settle.** `SETTLE_MS` (150ms of a 3000ms write) is how long a
   mask takes to open the rest of the way once its character is finished, emitted as one
   more `--hz-t0` / `--hz-dt` pair. It starts as the character's last stroke lands, so the
   weight arrives during the lift and the breath into the next character, where there is
   other motion to look at. The last character has no room after it: its window is pushed
   back against the end of the write so it *ends* at exactly 1, the instant the class is
   stripped. Pushed back far enough it would reach over strokes not yet written and show
   them — a mask opening over an unwritten stroke reveals it, which is worse than the flash
   — so it may go back only as far as the nib's arrival on the final stroke. On the shipped
   timing that gives 杨 797–947ms, 泓 1732–1882ms and 锴 2955–3000ms.

A stroke's duration is `∫ ds/v(s)`, so a corner-heavy fold earns its time and a short flick
comes out quick. Two currencies have to be reconciled — ink and air are measured in units
of travel and scale with the write, while the beat, the breath and the dot floor are stated
in milliseconds because they are limits of perception — so the ms-per-unit rate is solved
for by bisection rather than assumed, and the whole thing lands on exactly
`--hanzi-write-duration`. The last stroke of 锴 gets a keyframe name of its own so that one
animation out of the thirty-one, rather than a tally, means "finished" — the three settles
are deliberately not it, and the last of them is timed to land on the same beat as the
stroke rather than after it, so the order the engine delivers them in cannot matter.

The same integration, inverted onto a uniform time grid, is emitted as `--hz-ease`: a CSS
`linear()` of 10–24 stops (`STOP_EVERY`, `STOPS_MIN`, `STOPS_MAX`), bare values so the stops
space themselves evenly and only the progress numbers cost bytes — about 2.4 KB across the
28 pens. `linear()` is Chrome 113+, Firefox 112+, Safari 17.2+; older engines cannot parse
the substituted value and fall back to the property's initial `ease` rather than to the
`linear` in the shorthand beside it, which is a gentler pace on the same schedule.

The printed table is per pen: length, lift and ink in ms, the two end classifications with
the thickness ratios they were read from, mean/min/max speed, `t0`, `dt`, and the start/end
in ms at the current token. The header gives the solved rate and the ink/air split.

Column geometry: em boxes at `y = k × 1140` (0.14em tracking), and a viewBox trailing space
derived from the live-text box the SVG replaced (143.75px at font-size 42.24px), so the
button keeps the height the portrait row was centred against.

## Fitting workflow

1. `bun render.mjs <char> --fit` — check pens sit on their strokes, starts (green dots) are
   at the right ends, numbering follows canonical order.
2. Edit `fit/u*.json` — move `points`, adjust per-stroke `width`, merge ligated strokes by
   giving one pen multiple `refIndices` and deleting the other.
3. `bun coverage.mjs <char> --fit` — chase the targets.
4. `bun render.mjs <char> --fit --sheet` — confirm the reveal reads as writing and the last
   frame is the complete glyph.

Watch for: Long Cang ligates aggressively, so several kai strokes may live in one
continuous ink run — merge those pens rather than fighting the bbox fit. Per-stroke width
matters on this face (hairline entries, fat bellies); a single global 7% either misses thin
tails or bleeds badly at the joins. `--upto K` is the quickest way to isolate which pen
broke a frame.

## Licences

- **Long Cang** (`vendor/LongCang-Regular.ttf`) — SIL Open Font License 1.1, from
  [google/fonts `ofl/longcang`](https://github.com/google/fonts/tree/main/ofl/longcang).
  Redistributable and embeddable under the OFL; keep the licence with any redistribution
  and do not sell the font by itself. Reserved Font Name rules apply to modified copies.
- **hanzi-writer-data** (`data/*.json`) — derived from
  [makemeahanzi](https://github.com/skishore/makemeahanzi), whose graphics come from the
  **Arphic PL** fonts (Arphic Public License) with the project's data under **LGPL**.
  Used here **only as a stroke-order / skeleton reference**: it tells us how many strokes
  each character has, in what order, and in which direction. The medians shipped in `fit/`
  are subsequently redrawn against Long Cang's own outlines, and no Arphic outline data is
  reproduced in the pipeline's output. If any derived data is ever shipped, carry the
  makemeahanzi attribution and its Arphic PL / LGPL terms.
- Glyph outlines in `out/glyphs.json` are extracted from Long Cang and remain OFL.
