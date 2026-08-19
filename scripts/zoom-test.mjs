#!/usr/bin/env bun
/* A test bench for the resume's glass.
 *
 *   bun scripts/zoom-test.mjs
 *
 * There is no rendering engine to interrogate any more. The sheets are vector
 * tracings, the zoom is one CSS transform, and the only thing that ever stood
 * between the compositor and those vectors was the site's own
 * `will-change: transform` pins — which the stylesheet now lifts while the
 * glass is up. So the oracle here is not bookkeeping. It is pixels: take a
 * screenshot, measure how far an ink edge takes to get from light to dark, and
 * say whether that is a letter or a smear.
 *
 * The metric is the svg-zoom-lab's: the 10–90% transition width across glyph
 * strokes, median over every row and column of a 400×400 crop. A pinned layer
 * measures almost exactly z × 1.4 px — the signature of a bitmap rastered once
 * at 1x and stretched — and past 6 px the page is not re-rasterizing at all.
 * Nearer the floor the numbers are finer, and what they mean depends on the
 * zoom; the bars below carry the measurements they came from.
 *
 * The page is served from the repo root by this file, driven over raw CDP by
 * this file, and everything it starts, it kills. Every wait is a poll against
 * a deadline; a bench that hangs is worse than one that fails.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OUT = process.env.ZOOM_TEST_OUT
    || '/private/tmp/claude-501/-Users-kvnyng-projects-www/0a5b9bea-02e1-42fd-8c0c-5a17bb70c0e2/scratchpad';
const SHOTS = join(OUT, 'shots');
/* A profile of this run's own, because a Chrome from a previous run may still
 * be letting go of the last one, and two of them over one directory hand the
 * bench a browser with no page in it. */
const PROFILE = join(OUT, `chrome-profile-${process.pid}-${Date.now().toString(36)}`);

/* The verdict bars. The second lab settled what this page can actually do: a
 * settled transform rasters byte-identical to the browser's own zoom, and the
 * only thing that ever separates them is where the layer origin falls between
 * device pixels.
 *
 * Two eras of measurement stand behind these numbers. While the zoom rode the
 * compositor's transform, what the page could achieve depended on the zoom —
 * phase swept a full device pixel in quarter steps, snap disabled:
 *
 *     phase      0.00   0.25   0.50   0.75
 *     z=256      1.61   1.91   2.15   1.88     <- phase was the whole story
 *     z=8.3      2.37   2.30   2.20   2.30     <- content was, phase worth 0.17
 *
 * At 256x a stem filled the screen and only its sub-pixel phase was left to
 * measure; at 8x dense body type crossed more pixels per row whatever the
 * layer did, and 2.2px was simply what that content came to.
 *
 * The settle swap ended the split. A beat after the hand stops, the zoom moves
 * off the transform onto CSS zoom on .grab, and layout scale is not
 * discretionary — the renderer rasterizes at size rather than deciding whether
 * to. Measured once that landed, every zoom sits on the same floor: 1.74px at
 * 8x, 1.61px at 64x, 1.63px at 256x. So one bar serves all three, and the
 * transform era's 2.2px is history rather than a limit. */
const CRISP_MAX = { z8: 2.0, z64: 2.0, z256: 2.0 };

/* The bar the phase test holds the settled page to, at the zoom where a
 * half-device-pixel offset is worth half a pixel of blur. */
const PHASE_MAX = 2.0;

/* The old bar, kept only to grade a failure. Past this the layer is not
 * slightly out of phase — it is not re-rasterizing at all. */
const CATASTROPHIC = 6;

const CROP = 400;

/* How long the bench waits after the last wheel before it believes what it is
 * looking at. The page snaps the layer onto a whole device pixel about 150ms
 * after the last zoom or pan write, and the re-raster needs a frame or two on
 * top of that — so this must never shrink under roughly 200ms or the bench
 * would be measuring the phase blur it exists to catch and calling it a
 * regression. */
const SETTLE_MS = 400;

/* Long enough to cover the snap even when a pan restarts its timer: the phase
 * test spends this before measuring, and it is deliberately generous. */
const SNAP_WAIT_MS = 600;

/* Below this many measured transitions the crop is not saying anything —
 * blank paper, or the inside of a stroke so large there is no edge left in
 * frame. Either way, move and look again. */
const MIN_EDGES = 20;

/* What the blindness control demands of two staged pixels of blur. A Gaussian
 * of that radius spreads a step over roughly ten device pixels at dpr 2, so a
 * metric in working order reads far past this; anything under it means the
 * bench cannot see blur it is standing in front of, and every crisp verdict it
 * gave is worthless. */
const BLUR_FLOOR = 6;

/* The bar a moving page is held to. The settled floor is 2.0, and this is the
 * same claim with room for the shutter: a screenshot of a gesture can land
 * part-way through a paint, and that costs a little width without meaning the
 * page was soft. */
const MID_MAX = 2.5;

/* Per-frame main-thread cost of a continuous layout-scale gesture. A frame is
 * 16.7ms; past half of it spent in script and layout the gesture is no longer
 * keeping up, and that is jank the reader feels. */
const FRAME_MS_MAX = 8;

/* Where the bench looks when the crop comes back empty. Nudges accumulate, so
 * these compose into a square spiral with a widening leg — at 256x a whole
 * viewport of pan is a fraction of a pdf unit, and one fixed step would search
 * a neighbourhood narrower than a serif stem. Fractions of the viewport, not
 * pixels, so the search scales with the window as well as the zoom. */
const RESCUE = (() => {
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const plan = [];
    for (let i = 0; i < 8; i++) {
        const [dx, dy] = dirs[i % 4];
        const leg = 0.4 * Math.ceil((i + 1) / 2);   // 0.4, 0.4, 0.8, 0.8, 1.2, 1.2, 1.6, 1.6
        plan.push([dx * leg, dy * leg]);
    }
    return plan;
})();

/* Wide and tall enough that the pile is over 612 css px across — the same
 * geometry the lab calibrated against. */
const WINDOW = '1280,1100';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── TAP bookkeeping ──────────────────────────────────────────────────── */

let n = 0, failed = 0, skipped = 0;
const say = (line) => console.log(line);
const note = (text) => say('# ' + String(text).replace(/\n/g, '\n#   '));

function ok(name, diag) {
    say(`ok ${++n} - ${name}`);
    if (diag) note('  ' + diag);
}
function notOk(name, why) {
    failed++;
    say(`not ok ${++n} - ${name}`);
    if (why) note('  ' + why);
}
function skip(name, why) {
    skipped++;
    say(`ok ${++n} - ${name} # skip ${why}`);
}
function check(name, cond, why) {
    if (cond) ok(name); else notOk(name, why);
    return !!cond;
}

/* ── The server ───────────────────────────────────────────────────────── */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
};

function serve() {
    return Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        development: false,
        async fetch(req) {
            let path;
            try {
                path = decodeURIComponent(new URL(req.url).pathname);
            } catch {
                return new Response('bad path', { status: 400 });
            }
            if (path.endsWith('/')) path += 'index.html';
            const file = resolve(join(ROOT, path));
            /* A dumb server, but not a naive one: nothing above the root. */
            if (file !== ROOT && !file.startsWith(ROOT + '/')) {
                return new Response('forbidden', { status: 403 });
            }
            const f = Bun.file(file);
            if (!(await f.exists())) {
                /* Chrome asks for a favicon whether or not the page named one,
                 * and its 404 would land in the console as an error the page
                 * never caused. Answer the probe with nothing at all. */
                if (path === '/favicon.ico') return new Response(null, { status: 204 });
                return new Response('not found', { status: 404 });
            }
            return new Response(f, {
                headers: {
                    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
                    'cache-control': 'no-store',
                },
            });
        },
    });
}

/* ── Chrome ───────────────────────────────────────────────────────────── */

function chromeBinary() {
    const candidates = [
        process.env.CHROME,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
}

async function launchChrome(bin) {
    rmSync(PROFILE, { recursive: true, force: true });
    mkdirSync(PROFILE, { recursive: true });
    const proc = Bun.spawn([
        bin,
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${PROFILE}`,
        `--window-size=${WINDOW}`,
        /* Headless left alone reports a 1x screen. The lab's thresholds are
         * 2x numbers, and the page is read on a 2x screen; pin it. */
        '--force-device-scale-factor=2',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--hide-scrollbars',
        '--mute-audio',
        /* The bench times a re-raster, so the renderer must be allowed to run
         * flat out even though nothing is on screen. */
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        /* Hermetic: the page reaches for a font host and an analytics tag, and
         * a bench whose timings depend on the internet is not a bench. Only
         * the loopback server answers. */
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        'about:blank',
    ], { stdout: 'ignore', stderr: 'pipe' });

    let stderr = '';
    (async () => {
        try {
            for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk);
        } catch { /* the pipe dies with the process; that is the normal end */ }
    })();

    const portFile = join(PROFILE, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (existsSync(portFile)) {
            const first = readFileSync(portFile, 'utf8').split('\n')[0].trim();
            if (/^\d+$/.test(first)) return { proc, port: Number(first), stderr: () => stderr };
        }
        if (proc.exitCode !== null) break;
        await sleep(60);
    }
    try { proc.kill(); } catch { }
    throw new Error(`chrome never published a debugging port\n${stderr.slice(-2000)}`);
}

async function pageTarget(port) {
    const deadline = Date.now() + 15000;
    let asked = false;
    while (Date.now() < deadline) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
            /* The endpoint answers but shows no page: ask for one rather than
             * spending the rest of the deadline hoping. */
            if (!asked) {
                asked = true;
                try { await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }); } catch { }
            }
        } catch { /* the endpoint comes up a beat after the port file */ }
        await sleep(100);
    }
    throw new Error('no page target on the devtools endpoint');
}

/* ── CDP ──────────────────────────────────────────────────────────────── */

function cdpConnect(url) {
    return new Promise((res, rej) => {
        const ws = new WebSocket(url);
        const waiting = new Map();
        const listeners = new Map();
        let seq = 0;
        let dead = null;

        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.id !== undefined) {
                const w = waiting.get(msg.id);
                if (!w) return;
                waiting.delete(msg.id);
                clearTimeout(w.timer);
                if (msg.error) w.rej(new Error(`${msg.error.message} [${msg.error.code}]`));
                else w.res(msg.result);
            } else {
                for (const fn of listeners.get(msg.method) || []) {
                    try { fn(msg.params); } catch { /* a listener must never sink the run */ }
                }
            }
        });
        ws.addEventListener('close', () => {
            dead = new Error('devtools socket closed');
            for (const [, w] of waiting) { clearTimeout(w.timer); w.rej(dead); }
            waiting.clear();
        });
        ws.addEventListener('error', () => rej(new Error('devtools socket refused')));
        ws.addEventListener('open', () => res({
            send(method, params = {}, timeout = 30000) {
                if (dead) return Promise.reject(dead);
                return new Promise((r, j) => {
                    const id = ++seq;
                    const timer = setTimeout(() => {
                        waiting.delete(id);
                        j(new Error(`${method} timed out after ${timeout}ms`));
                    }, timeout);
                    waiting.set(id, { res: r, rej: j, timer });
                    ws.send(JSON.stringify({ id, method, params }));
                });
            },
            on(method, fn) {
                if (!listeners.has(method)) listeners.set(method, []);
                listeners.get(method).push(fn);
            },
            close() { try { ws.close(); } catch { } },
        }));
    });
}

function makeEval(cdp) {
    return async function evaluate(expression, timeout = 30000) {
        const r = await cdp.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        }, timeout);
        if (r.exceptionDetails) {
            const d = r.exceptionDetails;
            throw new Error(d.exception?.description || d.text || 'page threw');
        }
        return r.result.value;
    };
}

/* A poll with a deadline, which is the only kind this file has. */
async function until(fn, ms, step = 100) {
    const deadline = Date.now() + ms;
    for (;;) {
        let v;
        try { v = await fn(); } catch { v = undefined; }
        if (v) return v;
        if (Date.now() >= deadline) return null;
        await sleep(step);
    }
}

/* ── The page-side helpers ────────────────────────────────────────────── */

/* The zoom listener sits on window, so a pinch is the ctrl-wheel the browser
 * would have synthesized anyway; a plain wheel is a pan once the glass is up,
 * and the deal itself when it is down. The zoom is read back out of the
 * computed transform rather than trusted from a tick count — the page owns
 * that number and it is the only honest copy of it.
 *
 * The sharpness metric below is the svg-zoom-lab's, ported to run inside the
 * page against a screenshot handed back as a data URL: same 10–90% transition
 * walk, same Rec.709 luminance, same centre crop, so the lab's calibration
 * carries over unchanged. */
const HELPERS = `
window.__bench = (() => {
    const MIN_CONTRAST = 60;
    const MAX_RUN = 400;

    function transitions(get, n, out) {
        let i = 0;
        while (i < n - 1) {
            const d0 = get(i + 1) - get(i);
            if (Math.abs(d0) < 0.5) { i++; continue; }
            const sign = Math.sign(d0);
            let j = i, flat = 0;
            while (j < n - 1) {
                const d = get(j + 1) - get(j);
                if (Math.sign(d) === sign) { flat = 0; j++; }
                else if (Math.abs(d) < 0.5 && flat < 1) { flat++; j++; }
                else break;
            }
            const a = get(i), b = get(j);
            if (Math.abs(b - a) >= MIN_CONTRAST && (j - i) <= MAX_RUN) {
                const lo = a + 0.10 * (b - a), hi = a + 0.90 * (b - a);
                const cross = (lvl) => {
                    for (let k = i; k < j; k++) {
                        const p = get(k), q = get(k + 1);
                        if ((p - lvl) * (q - lvl) <= 0 && p !== q) return k + (lvl - p) / (q - p);
                    }
                    return null;
                };
                const c10 = cross(lo), c90 = cross(hi);
                if (c10 !== null && c90 !== null) out.push(Math.abs(c90 - c10));
            }
            i = Math.max(j, i + 1);
        }
    }

    const quantile = (sorted, q) => {
        if (!sorted.length) return null;
        const p = (sorted.length - 1) * q;
        const lo = Math.floor(p), hi = Math.ceil(p);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
    };

    function sharpness(w, h, lum) {
        let maxGrad = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                const gx = x + 1 < w ? lum[i + 1] - lum[i] : 0;
                const gy = y + 1 < h ? lum[i + w] - lum[i] : 0;
                const g = Math.hypot(gx, gy);
                if (g > maxGrad) maxGrad = g;
            }
        }
        const widths = [];
        for (let y = 0; y < h; y++) {
            const base = y * w;
            transitions((k) => lum[base + k], w, widths);
        }
        for (let x = 0; x < w; x++) {
            transitions((k) => lum[k * w + x], h, widths);
        }
        widths.sort((a, b) => a - b);
        let ink = 0, min = 255, max = 0;
        for (let i = 0; i < lum.length; i++) {
            const v = lum[i];
            if (v < 200) ink++;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return {
            edgeWidthMedian: quantile(widths, 0.5),
            edgeWidthP10: quantile(widths, 0.10),
            edgeWidthN: widths.length,
            maxGrad,
            inkFrac: ink / lum.length,
            contrast: max - min,
        };
    }

    async function decode(dataUrl) {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        return img;
    }
    function lumOf(img, x, y, w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, x, y, w, h, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        const lum = new Float64Array(w * h);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            lum[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        }
        return lum;
    }

    const zoomer = () => document.querySelector('.zoomer');
    const grab = () => document.querySelector('.grab');

    /* The zoom lives in one of two places now. During a gesture it is a scale
       on the .zoomer transform, where the compositor can carry it for free;
       once the hand stops, the page swaps it onto CSS zoom on .grab — a
       layout-scale, which the renderer must rasterize at size rather than
       choosing to. So "what is the zoom" is the product of the two, and any
       reading that looks at only one of them is right half the time. */
    function matrixOf(el) {
        const t = el ? getComputedStyle(el).transform : 'none';
        if (!t || t === 'none') return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        const m = t.match(/matrix(3d)?\\(([^)]+)\\)/);
        if (!m) return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        const p = m[2].split(',').map(Number);
        return m[1]
            ? { a: p[0], b: p[1], c: p[4], d: p[5], tx: p[12], ty: p[13] }
            : { a: p[0], b: p[1], c: p[2], d: p[3], tx: p[4], ty: p[5] };
    }
    function zoomOf(el) {
        if (!el) return 1;
        const v = parseFloat(getComputedStyle(el).zoom);
        return Number.isFinite(v) && v > 0 ? v : 1;
    }

    return {
        /* The scale carried by the transform alone — what the gesture writes. */
        zTransform() {
            const el = zoomer();
            return el ? matrixOf(el).a : null;
        },
        /* The effective zoom, whichever mode the page is in. */
        z() {
            const el = zoomer();
            if (!el) return null;
            return matrixOf(el).a * zoomOf(grab());
        },
        /* Where the scale is actually living, as observed rather than as
           assumed. The mechanism is in flux — a transform scale during the
           gesture, CSS zoom on .grab at settle, a .paper wrapper carrying
           zoom with a counter-scale — so this reports what it finds and
           leaves the judging to the outcome tests. */
        mode() {
            const m = matrixOf(zoomer());
            const gz = zoomOf(grab());
            const scaled = Math.abs(m.a - 1) > 1e-3;
            const zoomed = Math.abs(gz - 1) > 1e-3;
            return {
                grabZoom: gz,
                scale: m.a,
                paper: [...document.querySelectorAll('.paper')].map((el) => ({
                    zoom: zoomOf(el), scale: matrixOf(el).a,
                })),
                tx: m.tx, ty: m.ty,
                /* A translation-only matrix is what the zoomer should hold once
                   the scale has moved to CSS zoom. */
                pureTranslation: Math.abs(m.a - 1) < 1e-3 && Math.abs(m.d - 1) < 1e-3 &&
                    Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6,
                effective: m.a * gz,
                mode: zoomed && !scaled ? 'zoom'
                    : scaled && !zoomed ? 'transform'
                        : !scaled && !zoomed ? 'rest' : 'mixed',
            };
        },
        /* The mechanism, read in one synchronous pass so every part of it is
           from the same frame. The scale is carried three ways at once and
           they have to agree: the glass magnifies by z, each sheet of paper is
           laid out at z through CSS zoom, and the same paper is scaled back by
           1/z so the magnification lands on a box rasterized at size rather
           than on a stretched picture of one. */
        contract() {
            const zEl = zoomer();
            const pile = document.querySelector('.pile');
            return {
                zoomerScale: zEl ? matrixOf(zEl).a : null,
                zoomerTransform: zEl ? getComputedStyle(zEl).transform : 'none',
                zoomerInline: zEl ? zEl.style.transform : '',
                grabZoom: zoomOf(grab()),
                pileW: pile ? pile.getBoundingClientRect().width : null,
                papers: [...document.querySelectorAll('.paper')].map((el) => ({
                    zoom: zoomOf(el),
                    scale: matrixOf(el).a,
                    transform: getComputedStyle(el).transform,
                    inlineWidth: el.style.width,
                })),
            };
        },
        /* A gesture the bench can photograph while it is still happening.
           The burst is left running on the page and its promise parked on
           window, so the harness can come back mid-flight, take a screenshot
           of a moving page, and only then wait for it to finish. That is the
           whole point now: the zoom is a layout scale on every frame, so the
           picture is supposed to be sharp during the movement, not merely
           after it. */
        burst(opts) {
            const st = { done: false, ticks: 0, z: window.__bench.z(), samples: [] };
            window.__burst = st;
            const wait = opts.raf
                ? () => new Promise((r) => requestAnimationFrame(() => r()))
                : () => new Promise((r) => setTimeout(r, opts.spacing));
            window.__burstPromise = (async () => {
                for (let i = 0; i < opts.ticks; i++) {
                    if (opts.kind === 'zoom') {
                        const up = opts.reverseAt === undefined || i < opts.reverseAt;
                        window.__bench.wheel({ ctrlKey: true, deltaY: up ? -8 : 8 });
                    } else {
                        window.__bench.wheel({ deltaX: opts.dx || 0, deltaY: opts.dy || 0 });
                    }
                    st.ticks++;
                    /* Reading the zoom back costs a style flush, so the cost
                       run does without it: that overhead is the bench's, and
                       charging it to the page would be a lie. */
                    if (!opts.quiet) st.z = window.__bench.z();
                    if (opts.sample) st.samples.push(window.__bench.mode());
                    await wait();
                }
                st.done = true;
                return { ticks: st.ticks, z: st.z, samples: st.samples };
            })();
            return true;
        },
        burstState() {
            const st = window.__burst;
            if (!st) return null;
            return {
                done: st.done, ticks: st.ticks, z: st.z,
                mode: window.__bench.mode(), contract: window.__bench.contract(),
            };
        },
        awaitBurst() { return window.__burstPromise; },
        zoomed() {
            const s = document.querySelector('.scene');
            return !!s && s.classList.contains('zoomed');
        },
        /* Every element the stylesheet pins, as the compositor sees it. */
        pins() {
            const read = (sel) => [...document.querySelectorAll(sel)]
                .map((el) => getComputedStyle(el).willChange);
            return { zoomer: read('.zoomer'), grab: read('.grab'), sheet: read('.sheet') };
        },
        wheel(init) {
            dispatchEvent(new WheelEvent('wheel', Object.assign({
                cancelable: true, bubbles: true,
                clientX: innerWidth / 2, clientY: innerHeight / 2,
            }, init)));
        },
        key(k) {
            dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        },
        /* Pans in fractions of the viewport, so the search step means the same
           thing on any window. */
        nudge(fx, fy) {
            window.__bench.wheel({ deltaX: fx * innerWidth, deltaY: fy * innerHeight });
        },
        /* Puts the pins back exactly as the stylesheet used to ship them —
           the regression the pivot exists to prevent, staged on purpose so
           the bench can prove it would notice. */
        /* Blur the glass on purpose. The bench used to prove it could see a
           smear by staging one out of the page's own machinery; with the zoom
           carried by layout at every moment there is no longer a way to make
           the page render badly, which is the good news the resilience test
           reports. So the blindness control stops depending on the mechanism
           and simply puts two pixels of blur on the glass: if the metric
           cannot see that, it cannot see anything. */
        blurGrab(on) {
            const id = '__bench_blur';
            const had = document.getElementById(id);
            if (on && !had) {
                const st = document.createElement('style');
                st.id = id;
                st.textContent = '.grab { filter: blur(2px) !important; }';
                document.head.appendChild(st);
            } else if (!on && had) {
                had.remove();
            }
            return !!document.getElementById(id);
        },
        repin(on) {
            const id = '__bench_repin';
            const had = document.getElementById(id);
            if (on && !had) {
                const st = document.createElement('style');
                st.id = id;
                st.textContent =
                    '.scene.zoomed :is(.zoomer, .grab, .sheet) { will-change: transform !important; }';
                document.head.appendChild(st);
            } else if (!on && had) {
                had.remove();
            }
            return !!document.getElementById(id);
        },
        async zoomTo(target) {
            const cx = innerWidth / 2, cy = innerHeight / 2;
            const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
            /* The page owns how hard one event pushes — it has been a 24px
               clamp and it is an 8px one now, which is the difference between
               eight ticks to 8x and sixty-three to 256x. So the loop is bounded
               generously and gets out on the target or on a stall, never on a
               count tuned to a constant it does not own. */
            let ticks = 0, stalled = 0;
            while (ticks < 400) {
                const before = window.__bench.z();
                if (before >= target - 1e-6) break;
                window.__bench.wheel({ ctrlKey: true, deltaY: -24, clientX: cx, clientY: cy });
                ticks++;
                await frame();
                /* The ceiling is a clamp, not an error: once the page stops
                   moving there is nothing more to ask of it. */
                if (window.__bench.z() <= before + 1e-9) { stalled++; if (stalled >= 2) break; }
                else stalled = 0;
            }
            return { ticks, z: window.__bench.z() };
        },
        /* The screenshot comes back as a data URL, is decoded by the browser
           that drew it, and is measured over the middle CROP square. */
        async measure(dataUrl, crop) {
            const img = await decode(dataUrl);
            const cw = Math.min(crop, img.naturalWidth);
            const ch = Math.min(crop, img.naturalHeight);
            const sx = Math.floor((img.naturalWidth - cw) / 2);
            const sy = Math.floor((img.naturalHeight - ch) / 2);
            const m = sharpness(cw, ch, lumOf(img, sx, sy, cw, ch));
            m.crop = cw + 'x' + ch;
            return m;
        },
        /* Two frames of the same view — one taken mid-gesture, one after the
           settle has swapped modes — and the question of whether the picture
           moved between them. Best integer shift by absolute difference over
           the middle, because a shift is exactly what the eye would read as a
           jump at settle. */
        async align(a, b, crop, radius) {
            const [ia, ib] = await Promise.all([decode(a), decode(b)]);
            const W = ia.naturalWidth, H = ia.naturalHeight;
            const cw = Math.min(crop, W - 2 * radius, H - 2 * radius);
            const ax = Math.floor((W - cw) / 2), ay = Math.floor((H - cw) / 2);
            const bw = cw + 2 * radius;
            const la = lumOf(ia, ax, ay, cw, cw);
            const lb = lumOf(ib, ax - radius, ay - radius, bw, bw);
            let best = null;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    let sad = 0;
                    for (let y = 0; y < cw; y += 2) {
                        const ra = y * cw;
                        const rb = (y + dy + radius) * bw + (dx + radius);
                        for (let x = 0; x < cw; x += 2) sad += Math.abs(la[ra + x] - lb[rb + x]);
                    }
                    if (best === null || sad < best.sad) best = { dx, dy, sad };
                }
            }
            best.perPx = best.sad / ((cw / 2) * (cw / 2));
            best.crop = cw;
            best.shift = Math.max(Math.abs(best.dx), Math.abs(best.dy));
            return best;
        },
        textLayer() {
            return {
                spans: document.querySelectorAll('.textlayer span').length,
                links: document.querySelectorAll('.textlayer a[href]').length,
            };
        },
        deal() {
            const live = document.querySelector('.counter .live');
            return { live: live ? live.textContent : null, hash: location.hash };
        },
    };
})();
true`;

/* ── The run ──────────────────────────────────────────────────────────── */

const errors = [];
const ignored = [];
const latency = {};
const sharp = {};
const midSharp = {};
let frameCost = null;
let panCost = null;
const shots = [];

let server = null, chrome = null, cdp = null;

/* Chrome does not die the instant it is asked to, and a profile removed out
 * from under a browser that is still running comes back. So: ask, wait, insist,
 * and only then sweep. */
async function teardown() {
    try { cdp && cdp.close(); } catch { }
    try { server && server.stop(true); } catch { }
    if (chrome) {
        try { chrome.proc.kill(); } catch { }
        const gone = await Promise.race([chrome.proc.exited, sleep(3000).then(() => 'waited')]);
        if (gone === 'waited') {
            try { chrome.proc.kill(9); } catch { }
            await Promise.race([chrome.proc.exited, sleep(1000)]);
        }
    }
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { }
}

const watchdog = setTimeout(async () => {
    notOk('bench completed within its watchdog', 'the whole run exceeded 300s');
    say(`1..${n}`);
    await teardown();
    process.exit(1);
}, 300000);

async function main() {
    mkdirSync(SHOTS, { recursive: true });
    /* Profiles left behind by a run that was killed before it could tidy. An
     * hour is long enough that nothing still running is swept up with them. */
    try {
        for (const name of readdirSync(OUT)) {
            if (!name.startsWith('chrome-profile-')) continue;
            const dir = join(OUT, name);
            if (dir !== PROFILE && Date.now() - statSync(dir).mtimeMs > 3600000) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    } catch { /* the scratch directory is a convenience, not a dependency */ }

    server = serve();
    const base = `http://127.0.0.1:${server.port}`;
    note(`serving ${ROOT} at ${base}`);

    const bin = chromeBinary();
    if (!bin) {
        notOk('chrome is available', 'no chrome found; set $CHROME');
        say(`1..${n}`);
        return;
    }
    note(`chrome ${bin}`);

    chrome = await launchChrome(bin);
    note(`devtools on port ${chrome.port}`);
    cdp = await cdpConnect(await pageTarget(chrome.port));

    /* Everything the page says, from before it says anything. */
    cdp.on('Runtime.consoleAPICalled', (p) => {
        if (p.type !== 'error' && p.type !== 'assert') return;
        const text = (p.args || [])
            .map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type))
            .join(' ');
        errors.push({ from: 'console.' + p.type, text, url: p.stackTrace?.callFrames?.[0]?.url || '' });
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails || {};
        errors.push({
            from: 'exception',
            text: d.exception?.description || d.text || 'uncaught',
            url: d.url || '',
        });
    });
    cdp.on('Log.entryAdded', (p) => {
        const e = p.entry || {};
        if (e.level !== 'error') return;
        const rec = { from: `log:${e.source}`, text: e.text || '', url: e.url || '' };
        /* Requests to hosts this bench deliberately black-holes (the font host,
         * the analytics tag) are the bench's own doing, not the page's. */
        if (e.source === 'network' && rec.url && !rec.url.startsWith(base)) ignored.push(rec);
        else errors.push(rec);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const evaluate = makeEval(cdp);

    /* ── 1. the page arrives ──────────────────────────────────────────── */

    await cdp.send('Page.navigate', { url: `${base}/resume/` });
    const loaded = await until(
        async () => (await evaluate('document.readyState')) === 'complete', 20000);
    if (!check('page loaded', loaded, 'readyState never reached complete')) {
        say(`1..${n}`);
        return;
    }
    const ready = await until(
        () => evaluate(`document.documentElement.classList.contains('ready')`), 15000);
    check('entrance ran (html.ready)', ready, 'html never took the ready class');

    await evaluate(HELPERS);

    const dpr = await evaluate('devicePixelRatio');
    const geom = await evaluate(`JSON.stringify({ w: innerWidth, h: innerHeight,
        pile: (document.querySelector('.pile') || { offsetWidth: null }).offsetWidth })`);
    note(`viewport ${geom} dpr ${dpr}`);
    await sleep(900);

    /* The thresholds below are not universal constants. The 6px pass mark and
       the z × 1.4 smear model were measured in the lab at dpr 2 against a pile
       wider than 612 css px — one css pixel per pdf unit or better. On a 1x
       screen every width halves and a smear would slip under the bar; on a
       cramped pile the geometry stops matching. So the calibration is checked,
       not assumed, and if it has drifted the pixel verdicts are skipped rather
       than reported with false confidence. */
    const pileW = JSON.parse(geom).pile;
    const dprOk = check('calibration: devicePixelRatio is 2', dpr === 2,
        `got ${dpr} — the edge-width thresholds and the z x 1.4 model are all dpr-2 numbers`);
    const pileOk = check(`calibration: pile is at least 612 css px (${pileW})`,
        typeof pileW === 'number' && pileW >= 612,
        `got ${pileW} — the lab calibrated against a pile of at least one css px per pdf unit`);
    const calibrated = dprOk && pileOk;
    const uncalibrated = 'calibration drifted; these px thresholds do not apply here';

    const capture = async () =>
        (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
    const save = async (name, data) => {
        const path = join(SHOTS, name);
        await Bun.write(path, Buffer.from(data, 'base64'));
        shots.push(path);
        return path;
    };
    const measure = (data) =>
        evaluate(`window.__bench.measure("data:image/png;base64,${data}", ${CROP})`, 60000);
    const escape = async () => {
        await evaluate('window.__bench.key("Escape")');
        await sleep(300);
    };

    /* ── 2. the pins, which are the whole mechanism ───────────────────── */

    const flat = (p) => [...p.zoomer, ...p.grab, ...p.sheet];
    const atRest = await evaluate('window.__bench.pins()');
    check(`will-change at rest: .zoomer/.grab/.sheet all "transform" (${flat(atRest).length} elements)`,
        flat(atRest).length >= 3 && flat(atRest).every((v) => v === 'transform'),
        `got ${JSON.stringify(atRest)}`);

    await evaluate('window.__bench.zoomTo(8)', 20000);
    await sleep(400);
    const zoomedPins = await evaluate('window.__bench.pins()');
    check('will-change under the glass: all three lift to "auto"',
        flat(zoomedPins).length >= 3 && flat(zoomedPins).every((v) => v === 'auto'),
        `got ${JSON.stringify(zoomedPins)} — the .scene.zoomed :is(.zoomer, .grab, .sheet) rule is what lifts these`);

    await escape();
    const restored = await evaluate('window.__bench.pins()');
    check('will-change after Escape: pins restored to "transform"',
        flat(restored).length >= 3 && flat(restored).every((v) => v === 'transform'),
        `got ${JSON.stringify(restored)}`);

    /* Where the scale is sitting. Now that the mechanism is settled this is
       both telemetry and a contract, so the same reading serves the note and
       the verdict. */
    const placement = (c) => `zoomer scale ${c.zoomerScale === null ? '?' : c.zoomerScale.toFixed(3)}, ` +
        `.grab zoom ${c.grabZoom.toFixed(3)}, ` +
        (c.papers.length
            ? c.papers.map((x) => `paper zoom ${x.zoom.toFixed(3)} x scale ${x.scale.toFixed(4)}`).join(' + ')
            : 'no .paper');

    /* The mode contract, checked against the zoom the glass itself is carrying
       so a moving gesture is judged against the frame it was caught in rather
       than against a number from before the shutter opened. Three carriers of
       one scale: the glass magnifies by z, each paper is laid out at z, and
       the same paper is scaled back by 1/z so what gets magnified is a box
       rasterized at size. If those three ever disagree the picture is either
       the wrong size or the wrong sharpness. */
    function contractFaults(c, expectZ) {
        const f = [];
        if (c.zoomerScale === null) return ['no .zoomer element'];
        const z = c.zoomerScale;
        const near = (a, b, tol) => Math.abs(a - b) <= tol;
        const rel = (a, b, r) => Math.abs(a - b) <= Math.abs(b) * r;

        if (c.grabZoom !== 1) f.push(`.grab zoom is ${c.grabZoom}, but that machinery is gone`);

        if (z > 1.0001) {
            if (expectZ !== undefined && !near(z, expectZ, Math.max(0.05, expectZ * 0.02))) {
                f.push(`zoomer scale ${z.toFixed(3)} is not the expected ${expectZ.toFixed(3)}`);
            }
            if (c.papers.length !== 2) f.push(`${c.papers.length} .paper elements, expected 2`);
            c.papers.forEach((pp, i) => {
                if (!near(pp.zoom, z, 0.1)) {
                    f.push(`paper[${i}] zoom ${pp.zoom.toFixed(3)} is not the glass's ${z.toFixed(3)}`);
                }
                if (!rel(pp.scale, 1 / z, 1e-3)) {
                    f.push(`paper[${i}] counter-scale ${pp.scale.toFixed(5)} is not 1/z ${(1 / z).toFixed(5)}`);
                }
                const w = parseFloat(pp.inlineWidth);
                if (!pp.inlineWidth || !Number.isFinite(w) || !near(w, c.pileW, 1)) {
                    f.push(`paper[${i}] inline width "${pp.inlineWidth}" is not the pile's ${c.pileW === null ? '?' : c.pileW.toFixed(2)}px`);
                }
            });
        } else {
            /* Put down clean: the stylesheet's own page, with nothing of the
               glass left inline on it. */
            if (c.zoomerTransform !== 'none' || c.zoomerInline !== '') {
                f.push(`zoomer still transformed at rest ("${c.zoomerInline || c.zoomerTransform}")`);
            }
            c.papers.forEach((pp, i) => {
                if (pp.zoom !== 1) f.push(`paper[${i}] zoom ${pp.zoom} at rest`);
                if (pp.transform !== 'none') f.push(`paper[${i}] transform "${pp.transform}" at rest`);
                if (pp.inlineWidth) f.push(`paper[${i}] inline width "${pp.inlineWidth}" left behind at rest`);
            });
        }
        return f;
    }

    /* ── 3. crispness, which is the point ─────────────────────────────── */

    /* One zoom level, measured properly: recentre so the crop has ink in it,
       climb, then watch the screen until it sharpens — the latency is the
       first frame that passes, and the verdict is the frame after it has had
       its settling time. */
    async function crispAt(label, target, file) {
        const bar = CRISP_MAX[label];
        await escape();
        const climb = await evaluate(`window.__bench.zoomTo(${target})`, 25000);
        const t0 = Date.now();

        /* The latency poll. Captures cost ~80ms of their own, so the interval
           is a floor, not a period — the lab measured the same way. */
        let firstPass = null, last = null;
        const deadline = t0 + 6000;
        for (;;) {
            const data = await capture();
            const m = await measure(data);
            const el = Date.now() - t0;
            last = { data, m, el };
            if (firstPass === null && m.edgeWidthN >= MIN_EDGES &&
                m.edgeWidthMedian !== null && m.edgeWidthMedian <= bar) {
                firstPass = el;
            }
            if (el >= SETTLE_MS && firstPass !== null) break;
            if (Date.now() >= deadline) break;
            await sleep(150);
        }
        if (Date.now() - t0 < SETTLE_MS) await sleep(SETTLE_MS - (Date.now() - t0));

        /* If the crop landed on blank paper or inside one fat stroke it has no
           edges to speak of. Walk the spiral until something has an edge in it,
           keeping whichever view had the most to say. At 256x the crop is about
           six tenths of a pdf unit — narrower than a serif stem — so the search
           has to widen as it goes rather than shuffle in place. */
        let best = last, walked = 0;
        for (const [fx, fy] of RESCUE) {
            if (best.m.edgeWidthN >= MIN_EDGES) break;
            walked++;
            await evaluate(`window.__bench.nudge(${fx}, ${fy})`);
            await sleep(500);
            const data = await capture();
            const m = await measure(data);
            if (m.edgeWidthN > best.m.edgeWidthN) best = { data, m, el: null };
        }
        if (walked) note(`  ${label}: first crop had ${last.m.edgeWidthN} edges; walked ${walked} of ${RESCUE.length} rescue steps to ${best.m.edgeWidthN}`);

        const path = await save(file, best.data);
        const m = best.m;
        latency[label] = firstPass;
        sharp[label] = m;

        const detail = `z=${climb.z.toFixed(1)} (${climb.ticks} ticks), median 10–90 edge ` +
            `${m.edgeWidthMedian === null ? 'n/a' : m.edgeWidthMedian.toFixed(2) + 'px'}, ` +
            `p10 ${m.edgeWidthP10 === null ? 'n/a' : m.edgeWidthP10.toFixed(2)}, ` +
            `${m.edgeWidthN} edges, ink ${(m.inkFrac * 100).toFixed(1)}%, ` +
            `contrast ${m.contrast.toFixed(0)}, maxGrad ${m.maxGrad.toFixed(0)}`;

        if (m.edgeWidthN < MIN_EDGES || m.edgeWidthMedian === null) {
            notOk(`crisp at ${label}: edge width under ${bar}px`,
                `no measurable edge in the ${m.crop} crop after ${RESCUE.length + 1} placements — ` +
                `${detail}; see ${path}`);
        } else {
            /* Two tiers, because the two failures want different fixes: a
               little over the bar is a layer sitting between device pixels,
               and a lot over it is a layer that never re-rasterized at all. */
            const w = m.edgeWidthMedian;
            check(`crisp at ${label}: median edge ${w.toFixed(2)}px (want <= ${bar})`,
                w <= bar,
                `${detail} — ` + (w > CATASTROPHIC
                    ? `past ${CATASTROPHIC}px this is not a phase problem: a pinned layer measures about z x 1.4px, so the will-change pins are still on`
                    : `over ${bar}px but under ${CATASTROPHIC}px — at this zoom that is the signature of a layer origin on a fractional device pixel, which the settle snap is what should be removing`) +
                `; see ${path}`);
        }
        note(`  ${detail}`);
        note(`  first frame under ${bar}px: ${firstPass === null ? 'never within 6s' : firstPass + 'ms after the last wheel'}`);

        const c = await evaluate('window.__bench.contract()');
        const faults = contractFaults(c, climb.z);
        check(`mechanism at ${label}: glass x${c.zoomerScale.toFixed(2)}, paper laid out at z and scaled back by 1/z`,
            faults.length === 0, `${faults.join('; ')} | ${placement(c)}`);
        note(`  settled placement: ${placement(c)}`);
        return climb.z;
    }

    if (calibrated) {
        await crispAt('z8', 8, 'z8.png');
        await crispAt('z64', 64, 'z64.png');
        await crispAt('z256', 256, 'z256.png');
    } else {
        skip('crisp at z8', uncalibrated);
        skip('crisp at z64', uncalibrated);
        skip('crisp at z256', uncalibrated);
    }

    /* ── 3b. crisp WHILE it moves, which is the whole point ───────────── */

    /* The settled page has been sharp for several rounds now. What the reader
       actually complained about is the movement: a zoom carried on the
       compositor stretches the last raster until the hand stops, so the words
       swim and then snap. Layout zoom is written every frame precisely so that
       never happens — and the only way to hold the page to that is to
       photograph it in the middle of a gesture rather than after one.
       The burst is left running on the page; the bench comes back mid-flight,
       takes the picture, and only then waits for the gesture to finish. */
    async function midGesture(label, opts) {
        await escape();
        if (opts.preZoom) {
            await evaluate(`window.__bench.zoomTo(${opts.preZoom})`, 25000);
            await sleep(SETTLE_MS + 200);
        }
        await evaluate(`window.__bench.burst(${JSON.stringify(opts.burst)})`);
        await sleep(opts.captureAt);
        const before = await evaluate('window.__bench.burstState()');
        const data = await capture();
        const after = await evaluate('window.__bench.burstState()');
        await evaluate('window.__bench.awaitBurst()', 60000);
        await sleep(SETTLE_MS);
        const m = await measure(data);
        const path = await save(`midgesture-${label}.png`, data);
        midSharp[label] = m;

        const w = m.edgeWidthMedian;
        const moving = before && after && !before.done &&
            (opts.burst.kind === 'zoom' ? after.z > before.z + 1e-6 : after.ticks > before.ticks);
        const detail = `z ${before ? before.z.toFixed(1) : '?'} -> ${after ? after.z.toFixed(1) : '?'} ` +
            `across the shutter (tick ${before ? before.ticks : '?'} of ${opts.burst.ticks}), ` +
            `median ${w === null ? 'n/a' : w.toFixed(2) + 'px'}, ${m.edgeWidthN} edges, ` +
            `ink ${(m.inkFrac * 100).toFixed(1)}%, mode "${after ? after.mode.mode : '?'}"`;

        if (!moving) {
            notOk(`mid-gesture ${label}: stays under ${MID_MAX}px while moving`,
                `the burst was not still running when the shutter opened, so this proves ` +
                `nothing about movement — ${detail}; see ${path}`);
        } else if (w === null || m.edgeWidthN < MIN_EDGES) {
            notOk(`mid-gesture ${label}: stays under ${MID_MAX}px while moving`,
                `no measurable edge in the crop — ${detail}; see ${path}`);
        } else {
            const ok_ = w <= MID_MAX;
            check(`mid-gesture ${label}: ${w.toFixed(2)}px while moving (want <= ${MID_MAX})`,
                ok_,
                `${detail} — a page that only rasterizes at rest stretches its last raster ` +
                `through the gesture, which is exactly what this width is measuring. ` +
                `EXPECTED RED while the mid-gesture mechanism is being rebuilt: this is the ` +
                `oracle for that feature, not a regression in what already works; see ${path}`);
        }
        note(`  ${detail}`);
        /* A crisp frame mid-gesture is only trustworthy if the scale was on
           layout at the time. If it was on the transform, this machine's
           compositor chose to re-rasterize — and the whole reason for the
           pivot is that the reader's machine chose not to. Say so, so a pass
           here is never mistaken for a guarantee. */
        if (after && after.contract) {
            const faults = contractFaults(after.contract);
            check(`mechanism mid-${label}: paper carried the layout scale through the gesture`,
                faults.length === 0,
                `${faults.join('; ')} | ${placement(after.contract)}`);
            note(`  placement at the shutter: ${placement(after.contract)}`);
            if (faults.length === 0) {
                note(`  the paper was laid out at z when the shutter opened, so this width is a ` +
                    `guarantee and not a favour: the raster was made at size, whatever the ` +
                    `compositor would have chosen to do with a stretched one`);
            }
        }
    }

    if (calibrated) {
        /* Sixty-four ticks at 30ms is a two-second pinch from 1x to the
           ceiling; the shutter opens a third of the way in, around 12x, where
           there is plenty of ink. */
        await midGesture('zoom', {
            burst: { kind: 'zoom', ticks: 64, spacing: 30 },
            captureAt: 700,
        });
        /* And the same question of a pan, which at 64x moves the paper far
           faster than the eye can follow a stale raster. */
        /* Along the line, not across it. At 64x the screen holds about
           nineteen css pixels of paper, so a vertical pan is in the blank
           between two lines within a few ticks, while a horizontal one runs
           the length of a sentence. */
        await midGesture('pan', {
            preZoom: 64,
            burst: { kind: 'pan', ticks: 40, spacing: 30, dx: 25 },
            captureAt: 400,
        });
    } else {
        skip('mid-gesture zoom', uncalibrated);
        skip('mid-gesture pan', uncalibrated);
    }

    /* ── 3c. where the scale sits, reported not judged ────────────────── */

    /* The mechanism is being rebuilt, so this asserts nothing. It samples a
       climbing gesture frame by frame and writes down where the scale was
       living at each one, which is the context the crispness numbers above
       and below are read against. When the mechanism settles, this is the
       block that grows a contract. */
    if (calibrated) {
        try {
            await escape();
            await evaluate(`window.__bench.burst({ kind: 'zoom', ticks: 24, raf: true, sample: true })`);
            await evaluate('window.__bench.awaitBurst()', 30000);
            const climbC = await evaluate('window.__bench.contract()');
            note(`placement at the top of a 24-frame climb: ${placement(climbC)}`);
            await sleep(SETTLE_MS + 300);
            const settledC = await evaluate('window.__bench.contract()');
            note(`  after the settle: ${placement(settledC)}` +
                ` — the settle only snaps the pan now, so nothing about the scale moves`);
            await escape();
            await sleep(300);
            note(`  put down:         ${placement(await evaluate('window.__bench.contract()'))}`);
        } catch (e) {
            note(`placement probe failed: ${String(e.message || e)}`);
        }
    }

    /* ── 3d. and the settle must not move the picture ─────────────────── */

    /* Nothing changes hands at settle now — the pan is simply nudged onto a
       whole device pixel — so the last frame of the gesture and the settled
       frame should be the same picture, off by at most that nudge. */
    if (!calibrated) {
        skip('geometry: the settle moves the picture <= 1 device px', uncalibrated);
    } else {
        try {
            await escape();
            await evaluate('window.__bench.zoomTo(8)', 25000);
            /* A zero-delta ctrl-wheel re-arms the 150ms settle without moving
               anything — exp(0) is 1, so the zoom and the pan come out of
               zoomAt exactly as they went in. That buys a clean window to
               photograph the unsettled frame in. */
            await evaluate('window.__bench.wheel({ ctrlKey: true, deltaY: 0 })');
            const tTick = Date.now();
            const preData = await capture();
            const preElapsed = Date.now() - tTick;

            await sleep(SETTLE_MS + 300);
            const postData = await capture();

            const al = await evaluate(
                `window.__bench.align("data:image/png;base64,${preData}", "data:image/png;base64,${postData}", 256, 8)`,
                90000);
            await save('settle-pre.png', preData);
            await save('settle-post.png', postData);

            check(`geometry: the settle moves the picture ${al.shift} device px (want <= 1)`,
                al.shift <= 1,
                `best alignment dx=${al.dx} dy=${al.dy} over a ${al.crop}px crop ` +
                `(residual ${al.perPx.toFixed(1)}/px) — only the pan snap should move at settle, ` +
                `and it can only move half a device pixel`);
            note(`  pre-shot at +${preElapsed}ms, post-shot after the settle`);
        } catch (e) {
            notOk('geometry: the settle moves the picture <= 1 device px', String(e.message || e));
        }
    }

    /* ── 3e. what a frame of it costs ─────────────────────────────────── */

    /* Layout scale is not free the way a compositor transform is: every frame
       of the gesture is a real relayout and repaint. That is the trade the
       pivot made deliberately, and this is the number that says whether the
       trade still fits inside a frame. */
    if (!calibrated) {
        skip(`cost: a gesture frame stays under ${FRAME_MS_MAX}ms of main-thread work`, uncalibrated);
    } else {
        try {
            await escape();
            await cdp.send('Performance.enable');
            const readTask = async () => {
                const { metrics } = await cdp.send('Performance.getMetrics');
                const m = metrics.find((x) => x.name === 'TaskDuration');
                return m ? m.value : null;
            };
            /* Two bursts, because the two halves of a gesture cost wildly
               different things and one number would hide it: changing the zoom
               value relays out the sheets every frame, while panning at a
               fixed zoom only moves a translate. Only the first is held to the
               bar; the second is measured so a failure says which it was. */
            const burstCost = async (expr) => {
                const a = await readTask();
                const wall = Date.now();
                await evaluate(expr);
                const run = await evaluate('window.__bench.awaitBurst()', 60000);
                const bT = await readTask();
                return (a === null || bT === null) ? null : {
                    perFrame: ((bT - a) * 1000) / run.ticks,
                    task: (bT - a) * 1000,
                    ticks: run.ticks,
                    wall: Date.now() - wall,
                };
            };

            /* Sixty ticks up and sixty back, one per frame, so every frame does
               real work rather than clamping at the ceiling. */
            const scaling = await burstCost(
                `window.__bench.burst({ kind: 'zoom', ticks: 120, raf: true, reverseAt: 60, quiet: true })`);
            await escape();
            await evaluate('window.__bench.zoomTo(64)', 25000);
            await sleep(SETTLE_MS);
            const panning = await burstCost(
                `window.__bench.burst({ kind: 'pan', ticks: 120, raf: true, quiet: true, dx: 2 })`);
            await escape();

            if (!scaling) {
                notOk(`cost: a gesture frame stays under ${FRAME_MS_MAX}ms of main-thread work`,
                    'Performance.getMetrics did not report TaskDuration');
            } else {
                frameCost = scaling.perFrame;
                panCost = panning ? panning.perFrame : null;
                check(`cost: ${frameCost.toFixed(2)}ms of main-thread work per pinch frame (want <= ${FRAME_MS_MAX})`,
                    frameCost <= FRAME_MS_MAX,
                    `${scaling.ticks} frames of changing zoom cost ${scaling.task.toFixed(0)}ms of main-thread ` +
                    `time over ${scaling.wall}ms wall (${(scaling.task / scaling.wall * 100).toFixed(0)}% of the ` +
                    `thread), while ${panning ? panning.ticks + ' frames of panning at 64x cost only ' + panning.perFrame.toFixed(2) + 'ms each' : 'the pan comparison did not run'}. ` +
                    `So it is not layout zoom that is expensive — it is changing the zoom value, which ` +
                    `relays out both sheets every frame. Past ${FRAME_MS_MAX}ms a frame a pinch cannot keep up ` +
                    `on slower hardware than this`);
                note(`  pinch ${frameCost.toFixed(2)}ms/frame vs pan at 64x ${panCost === null ? '—' : panCost.toFixed(2) + 'ms/frame'}` +
                    ` (bench floor is about 0.4ms/frame)`);
            }
        } catch (e) {
            notOk(`cost: a gesture frame stays under ${FRAME_MS_MAX}ms of main-thread work`, String(e.message || e));
        }
    }

    /* ── 3d. the phase regression ─────────────────────────────────────── */

    /* The last thing between this page and the browser's own zoom was never
       resolution — it was where the layer origin fell between device pixels.
       On a whole pixel the raster is byte-identical to native; half a pixel
       over, the compositor resamples and every edge softens. The page answers
       that with a snap: a beat after the last write, the pan is nudged so the
       origin lands whole.

       This runs at 256x, not at 8x, because that is where the question is
       legible. The sweep above found half a device pixel worth 0.53px of blur
       at 256x (1.61 -> 2.15) and only 0.17px at 8x, where the dense body type
       drowns it. Half a device pixel is 0.25 css px of pan at dpr 2, and at
       256x that moves the view by a thousandth of a css page pixel — so the
       before and after frames are the same content, and the only variable in
       the comparison is the phase. */
    if (!calibrated) {
        skip(`phase: a half-device-pixel pan still settles under ${PHASE_MAX}px`, uncalibrated);
    } else {
        try {
            await escape();
            await evaluate('window.__bench.zoomTo(256)', 25000);
            await sleep(SETTLE_MS + 200);
            const beforeM = await measure(await capture());

            /* panX -= deltaX, so a quarter of a css pixel is half a device one. */
            await evaluate('window.__bench.wheel({ deltaX: 0.25, deltaY: 0 })');
            await sleep(SNAP_WAIT_MS);
            const data = await capture();
            const afterM = await measure(data);
            const path = await save('phase-halfpixel-z256.png', data);
            sharp.phase = afterM;

            const fmt = (m) => m.edgeWidthMedian === null
                ? 'n/a' : m.edgeWidthMedian.toFixed(2) + 'px';
            const detail = `settled ${fmt(beforeM)} -> after a half-pixel pan ${fmt(afterM)} ` +
                `(${afterM.edgeWidthN} edges, ink ${(afterM.inkFrac * 100).toFixed(1)}%)`;

            if (afterM.edgeWidthMedian === null || afterM.edgeWidthN < MIN_EDGES) {
                notOk(`phase: a half-device-pixel pan still settles under ${PHASE_MAX}px`,
                    `no measurable edge after the pan — ${detail}; see ${path}`);
            } else {
                check(`phase: half-device-pixel pan settles to ${fmt(afterM)} (want <= ${PHASE_MAX})`,
                    afterM.edgeWidthMedian <= PHASE_MAX,
                    `${detail} — at 256x an unsnapped layer on a half device pixel reads about ` +
                    `2.15px against a 1.61px floor, which is exactly this: the settle snap is not ` +
                    `landing the origin on a whole device pixel. See ${path}`);
                note(`  ${detail}`);
            }
        } catch (e) {
            notOk(`phase: a half-device-pixel pan still settles under ${PHASE_MAX}px`, String(e.message || e));
        }
    }

    /* ── 3e. pinned compositor, and what the swap does about it ───────── */

    /* Both tests below stage something hostile on a fresh page and then look at
       8x. Fresh, because will-change pins a layer at whatever raster it is
       holding, and after the climb to 256x that raster is a fine one — pinning
       that and dropping back to 8x would show a texture sharper than the view
       needs, which is the opposite of what either test asks about. A reload is
       the only way to be sure the layer starts at 1x, and it costs a second. */
    async function stagedAtZ8(opts) {
        await cdp.send('Page.navigate', { url: `${base}/resume/` });
        await until(async () => (await evaluate('document.readyState')) === 'complete', 20000);
        await until(() => evaluate(`document.documentElement.classList.contains('ready')`), 15000);
        await evaluate(HELPERS);
        await sleep(700);
        if (opts.repin) await evaluate('window.__bench.repin(true)');
        if (opts.blur) await evaluate('window.__bench.blurGrab(true)');
        await evaluate('window.__bench.zoomTo(8)', 25000);
        await sleep(SETTLE_MS + 600);
        const pins = await evaluate('window.__bench.pins()');
        const md = await evaluate('window.__bench.mode()');
        const data = await capture();
        const m = await measure(data);
        const path = await save(opts.shot, data);
        return { m, pins, md, path };
    }
    const unstage = async () => {
        try { await evaluate('window.__bench.repin(false)'); } catch { }
        try { await evaluate('window.__bench.blurGrab(false)'); } catch { }
        try { await escape(); } catch { }
    };

    /* The user's own report was that the compositor simply declined to
       re-rasterize on their machine, and pinning will-change is that failure
       made deliberate. The whole point of moving the settled zoom onto layout
       scale is that it does not ask the compositor's permission — so with the
       pins jammed back on, the page must still come up sharp. This is the
       direct regression test for the bug that caused the pivot. */
    if (!calibrated) {
        skip(`resilience: a pinned compositor still settles under ${CRISP_MAX.z8}px`, uncalibrated);
    } else {
        let r = null, err = null;
        try {
            r = await stagedAtZ8({ repin: true, shot: 'resilience-pinned-z8.png' });
        } catch (e) {
            err = String(e.message || e);
        } finally {
            await unstage();
        }
        if (err) {
            notOk(`resilience: a pinned compositor still settles under ${CRISP_MAX.z8}px`, err);
        } else {
            const w = r.m.edgeWidthMedian;
            check(`resilience: pinned compositor, settled anyway at ${w === null ? 'n/a' : w.toFixed(2) + 'px'} (want <= ${CRISP_MAX.z8})`,
                w !== null && r.m.edgeWidthN >= MIN_EDGES && w <= CRISP_MAX.z8,
                `with will-change pinned the compositor cannot re-raster, so layout zoom is the ` +
                `only thing that can make this sharp — and it did not. ` +
                `Median ${w === null ? 'n/a' : w.toFixed(2) + 'px'} over ${r.m.edgeWidthN} edges, ` +
                `mode "${r.md.mode}" (grab zoom ${r.md.grabZoom.toFixed(2)}, scale ${r.md.scale.toFixed(2)}), ` +
                `pins ${JSON.stringify(r.pins)}. See ${r.path}`);
            note(`  pinned at ${JSON.stringify(r.pins.zoomer)}, settled into mode "${r.md.mode}" at ${w === null ? 'n/a' : w.toFixed(2) + 'px'}`);
        }
    }

    /* And the control that keeps the metric honest. Every crispness verdict is
       one-sided: a metric that had quietly stopped working — a decode returning
       blank, a crop landing off the image, an edit that broke the transition
       walk — would sail through as passes. Staging a smear out of the page's
       own machinery no longer works, because there is no longer a way to make
       this page render badly; that is the good news the resilience test above
       reports, and it costs the bench its old control. So the control stops
       depending on the mechanism entirely and puts two pixels of blur on the
       glass. If the bench cannot see that, nothing it said above means
       anything. */
    if (!calibrated) {
        skip(`metric blindness control: two staged pixels of blur read at least ${BLUR_FLOOR}px`, uncalibrated);
    } else {
        let r = null, err = null;
        try {
            r = await stagedAtZ8({ blur: true, shot: 'blindness-control-z8.png' });
        } catch (e) {
            err = String(e.message || e);
        } finally {
            await unstage();
        }
        if (err) {
            notOk(`metric blindness control: two staged pixels of blur read at least ${BLUR_FLOOR}px`, err);
        } else {
            const w = r.m.edgeWidthMedian;
            check(`metric blindness control: staged blur reads ${w === null ? 'n/a' : w.toFixed(2) + 'px'} (want >= ${BLUR_FLOOR})`,
                w !== null && r.m.edgeWidthN >= MIN_EDGES && w >= BLUR_FLOOR,
                `two css pixels of blur spread a step over roughly ten device pixels at dpr 2, ` +
                `and the metric did not see it. Got median ` +
                `${w === null ? 'n/a' : w.toFixed(2) + 'px'} over ${r.m.edgeWidthN} edges, ` +
                `ink ${(r.m.inkFrac * 100).toFixed(1)}%, maxGrad ${r.m.maxGrad.toFixed(0)}. ` +
                `If this reads crisp the bench is blind, and every crisp verdict above is ` +
                `meaningless. See ${r.path}`);
            note(`  staged blur read ${w === null ? 'n/a' : w.toFixed(2) + 'px'} over ${r.m.edgeWidthN} edges`);
        }
    }

    /* ── 4. nothing moves at rest ─────────────────────────────────────── */

    await escape();
    await evaluate('window.__bench.zoomTo(64)', 25000);
    await sleep(800);
    try {
        const a = await capture();
        await save('z64-rest-a.png', a);
        await sleep(400);
        const b = await capture();
        await save('z64-rest-b.png', b);
        check(`rest stability at 64x: two shots 400ms apart are byte-identical`,
            a === b,
            `the shots differ (${a.length} vs ${b.length} base64 chars) — something repainted with no input`);
    } catch (e) {
        notOk('rest stability at 64x: two shots 400ms apart are byte-identical', String(e.message || e));
    }

    /* ── 5. the glass goes down ───────────────────────────────────────── */

    await escape();
    const after = await evaluate(
        `JSON.stringify({ z: window.__bench.z(), zoomed: window.__bench.zoomed() })`);
    const st = JSON.parse(after);
    /* And put down clean: every inline trace of the glass gone from the paper,
       so the deal gets back exactly the page the stylesheet describes. */
    const restC = await evaluate('window.__bench.contract()');
    const restFaults = contractFaults(restC);
    check('escape: back to z=1, zoomed class gone, paper left clean',
        Math.abs(st.z - 1) < 1e-6 && st.zoomed === false && restFaults.length === 0,
        `${restFaults.join('; ')} | ${after} | ${placement(restC)}`);

    /* ── 6. the deal, which the pivot must not have touched ───────────── */

    const deal = async (dy) => evaluate(`(async () => {
        for (let i = 0; i < 8; i++) {
            window.__bench.wheel({ deltaY: ${dy} });
            await new Promise((r) => setTimeout(r, 40));
        }
        return true;
    })()`, 15000);

    await deal(120);
    const onTwo = await until(async () => {
        const v = await evaluate('window.__bench.deal()');
        return (v.live === 'two' && v.hash === '#two') ? v : null;
    }, 3000, 100);
    check('deal: wheeling down reaches page two (counter + #two)', onTwo,
        `settled at ${JSON.stringify(await evaluate('window.__bench.deal()'))}`);

    await deal(-120);
    const onOne = await until(async () => {
        const v = await evaluate('window.__bench.deal()');
        return (v.live === 'one' && v.hash !== '#two') ? v : null;
    }, 3000, 100);
    check('deal: wheeling back up returns to page one', onOne,
        `settled at ${JSON.stringify(await evaluate('window.__bench.deal()'))}`);

    /* ── 7. pdf.js's remaining job: the ink you can touch ─────────────── */

    const text = await until(async () => {
        const v = await evaluate('window.__bench.textLayer()');
        return (v.spans > 0 && v.links > 0) ? v : null;
    }, 15000, 250);
    if (text) {
        ok(`text layer built (${text.spans} spans, ${text.links} link anchors)`);
    } else {
        const v = await evaluate('window.__bench.textLayer()');
        notOk('text layer built (spans > 0, link anchors > 0)',
            `after 15s: ${JSON.stringify(v)}`);
    }

    /* ── 8. nothing shouted along the way ─────────────────────────────── */

    /* One throw inside a repaint becomes one line per frame, so the report
       counts repeats rather than printing forty copies of the same stack. */
    const tally = (list) => {
        const seen = new Map();
        for (const e of list) {
            const line = `${e.from}: ${e.text}${e.url ? ` @ ${e.url}` : ''}`;
            seen.set(line, (seen.get(line) || 0) + 1);
        }
        return [...seen].map(([line, count]) => count > 1 ? `${line}   (×${count})` : line);
    };
    if (errors.length === 0) {
        ok(`console hygiene: no error-level entries${ignored.length ? ` (${ignored.length} blocked-host network errors ignored)` : ''}`);
    } else {
        const unique = tally(errors);
        notOk(`console hygiene: no error-level entries (${errors.length} entries, ${unique.length} distinct)`,
            unique.join('\n'));
    }
    for (const line of tally(ignored)) note(`  ignored (blocked host): ${line}`);
}

const started = Date.now();
try {
    await main();
} catch (e) {
    notOk('bench ran to completion', String(e && e.stack || e));
}

say(`1..${n}`);
note('');
note('── summary ─────────────────────────────────────────');
note(`At dpr 2 on this page. One scale, carried three ways and checked at every`);
note(`zoom both moving and at rest: the glass magnifies by z, each sheet of paper`);
note(`is laid out at z through CSS zoom, and that paper is scaled back by 1/z so`);
note(`what the glass magnifies was rasterized at size. Because the raster is made`);
note(`at size by construction, a crisp reading here is a guarantee rather than a`);
note(`compositor's favour — which is what the reader's machine withheld.`);
note(`Settled bar ${CRISP_MAX.z8}px, moving bar ${MID_MAX}px (slack for a shutter that can open mid-paint).`);
note(`Phase matters where it is legible: at 256x half a device pixel of offset`);
note(`cost 2.15px against a 1.61px floor, held to ${PHASE_MAX}px. Past ${CATASTROPHIC}px nothing is`);
note(`re-rasterizing at all.`);
note('');
for (const label of ['z8', 'z64', 'z256']) {
    const m = sharp[label];
    const l = latency[label];
    note(`${label.padEnd(5)} : ${m ? (m.edgeWidthMedian === null ? 'no edge found' : m.edgeWidthMedian.toFixed(2) + 'px median edge, ' + m.edgeWidthN + ' edges, ink ' + (m.inkFrac * 100).toFixed(1) + '%') : '—'}`);
    note(`        sharp after ${l === null || l === undefined ? '—' : l + 'ms'} from the last wheel`);
}
note(`phase : ${sharp.phase ? (sharp.phase.edgeWidthMedian === null ? 'no edge found' : sharp.phase.edgeWidthMedian.toFixed(2) + 'px after a half-device-pixel pan') : '—'}`);
note('');
for (const label of ['zoom', 'pan']) {
    const m = midSharp[label];
    note(`mid ${label.padEnd(5)}: ${m ? (m.edgeWidthMedian === null ? 'no edge found' : m.edgeWidthMedian.toFixed(2) + 'px WHILE moving, ' + m.edgeWidthN + ' edges') : '—'}`);
}
note(`cost  : ${frameCost === null ? '—' : frameCost.toFixed(2) + ' ms/frame while the zoom changes (pinch)'}`);
note(`        ${panCost === null ? '—' : panCost.toFixed(2) + ' ms/frame panning at 64x — it is changing the scale that costs, not holding it'}`);
note('');
note(`shots  : ${shots.length ? '' : '—'}`);
for (const p of shots) note(`         ${p}`);
note(`tests  : ${n} run, ${failed} failed, ${skipped} skipped, ${((Date.now() - started) / 1000).toFixed(1)}s`);
note('────────────────────────────────────────────────────');

clearTimeout(watchdog);
await teardown();
process.exit(failed ? 1 : 0);
