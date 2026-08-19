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
 * device pixels. That is true — but it is not equally legible at every zoom.
 * Measured here on this page, snap disabled, sub-pixel phase swept a full
 * device pixel in quarter steps:
 *
 *     phase      0.00   0.25   0.50   0.75
 *     z=256      1.61   1.91   2.15   1.88     <- phase is the whole story
 *     z=8.3      2.37   2.30   2.20   2.30     <- content is, and phase is 0.17
 *
 * Blown up to 256x, a stem fills the screen and the only thing left to measure
 * is where its edge falls between device pixels — so the floor is real, the
 * half-pixel penalty is plain, and 2.0 separates them cleanly. At 8x the crop
 * is dense body type whose curved and diagonal edges cross more pixels per row
 * no matter where the layer sits; 2.2 is what that content measures at its
 * best, and a 2.0 bar there would fail a page doing everything right. So the
 * bar is per zoom, and the phase regression is caught where phase is legible. */
const CRISP_MAX = { z8: 3.0, z64: 3.0, z256: 2.0 };

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

/* What the negative control demands of a deliberately re-pinned layer. The
 * model says z × 1.4, so a shade over 8x should read near 11px; anything
 * under this floor means the metric cannot see a smear it is standing in
 * front of, and every crisp verdict it gave is worthless. */
const NEG_FLOOR = 8;

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

    const zoomer = () => document.querySelector('.zoomer');

    return {
        z() {
            const el = zoomer();
            if (!el) return null;
            const t = getComputedStyle(el).transform;
            if (!t || t === 'none') return 1;
            const m = t.match(/matrix3?d?\\(([^)]+)\\)/);
            if (!m) return 1;
            return Number(m[1].split(',')[0]);
        },
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
            const img = new Image();
            img.src = dataUrl;
            await img.decode();
            const cw = Math.min(crop, img.naturalWidth);
            const ch = Math.min(crop, img.naturalHeight);
            const sx = Math.floor((img.naturalWidth - cw) / 2);
            const sy = Math.floor((img.naturalHeight - ch) / 2);
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
            const d = g.getImageData(0, 0, cw, ch).data;
            const lum = new Float64Array(cw * ch);
            for (let i = 0, p = 0; i < d.length; i += 4, p++) {
                lum[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            }
            const m = sharpness(cw, ch, lum);
            m.crop = cw + 'x' + ch;
            return m;
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

    /* ── 3b. the phase regression ─────────────────────────────────────── */

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

    /* ── 3c. the negative control ─────────────────────────────────────── */

    /* Every verdict above is one-sided: a metric that had quietly stopped
       working — a decode returning blank, a crop landing off the image, an
       edit that broke the transition walk — would sail through as three
       passes. So stage the exact regression the pivot exists to prevent, put
       the pins back, and require the number to move. If the smear is invisible
       from here, the bench is blind and nothing it said above means anything;
       that must fail loudly rather than pass in silence. */
    if (!calibrated) {
        skip(`negative control: a re-pinned layer measures at least ${NEG_FLOOR}px`, uncalibrated);
    } else {
        /* On a fresh page, because will-change pins a layer at whatever raster
           it is holding — and after the climb to 256x that raster is a fine
           one. Pinning it then and dropping back to 8x would show a texture
           sharper than the view needs, which is the opposite of the smear this
           test is looking for. A reload is the only way to be sure the layer
           starts at 1x, and it costs a second. */
        let m = null, pins = null, err = null;
        try {
            await cdp.send('Page.navigate', { url: `${base}/resume/` });
            await until(async () => (await evaluate('document.readyState')) === 'complete', 20000);
            await until(() => evaluate(`document.documentElement.classList.contains('ready')`), 15000);
            await evaluate(HELPERS);
            await sleep(700);
            await evaluate('window.__bench.repin(true)');
            await evaluate('window.__bench.zoomTo(8)', 25000);
            /* A pinned layer never sharpens, so there is nothing to wait for
               beyond the frame that draws it. */
            await sleep(900);
            pins = await evaluate('window.__bench.pins()');
            const data = await capture();
            m = await measure(data);
            await save('negative-control-z8.png', data);
        } catch (e) {
            err = String(e.message || e);
        } finally {
            /* The staged regression leaves with the test, pass or fail. */
            await evaluate('window.__bench.repin(false)');
            await escape();
        }
        if (err) {
            notOk(`negative control: a re-pinned layer measures at least ${NEG_FLOOR}px`, err);
        } else {
            const w = m.edgeWidthMedian;
            check(`negative control: re-pinned at 8x measures ${w === null ? 'n/a' : w.toFixed(2) + 'px'} (want >= ${NEG_FLOOR})`,
                w !== null && m.edgeWidthN >= MIN_EDGES && w >= NEG_FLOOR,
                `a re-pinned layer should smear to about z x 1.4px and the metric should see it. ` +
                `Got median ${w === null ? 'n/a' : w.toFixed(2) + 'px'} over ${m.edgeWidthN} edges, ` +
                `ink ${(m.inkFrac * 100).toFixed(1)}%, maxGrad ${m.maxGrad.toFixed(0)}, ` +
                `pins ${JSON.stringify(pins)}. If this reads crisp, the metric is blind ` +
                `and the three crisp results above are meaningless.`);
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
    check('escape: back to z=1 with the zoomed class gone',
        Math.abs(st.z - 1) < 1e-6 && st.zoomed === false, `got ${after}`);

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
note(`At dpr 2 on this page, measured with the snap disabled and phase swept:`);
note(`  z=256  floor 1.61px on a whole device pixel, 2.15px on a half — phase is`);
note(`         the whole story here, so the bar is ${CRISP_MAX.z256}px and the phase test lives here.`);
note(`  z=8/64 2.20–2.37px whatever the phase: dense body type, not blur. Bar ${CRISP_MAX.z8}px.`);
note(`  pinned layer ~z x 1.4px; past ${CATASTROPHIC}px it is not re-rasterizing at all.`);
note('');
for (const label of ['z8', 'z64', 'z256']) {
    const m = sharp[label];
    const l = latency[label];
    note(`${label.padEnd(5)} : ${m ? (m.edgeWidthMedian === null ? 'no edge found' : m.edgeWidthMedian.toFixed(2) + 'px median edge, ' + m.edgeWidthN + ' edges, ink ' + (m.inkFrac * 100).toFixed(1) + '%') : '—'}`);
    note(`        sharp after ${l === null || l === undefined ? '—' : l + 'ms'} from the last wheel`);
}
note(`phase : ${sharp.phase ? (sharp.phase.edgeWidthMedian === null ? 'no edge found' : sharp.phase.edgeWidthMedian.toFixed(2) + 'px after a half-device-pixel pan') : '—'}`);
note('');
note(`shots  : ${shots.length ? '' : '—'}`);
for (const p of shots) note(`         ${p}`);
note(`tests  : ${n} run, ${failed} failed, ${skipped} skipped, ${((Date.now() - started) / 1000).toFixed(1)}s`);
note('────────────────────────────────────────────────────');

clearTimeout(watchdog);
await teardown();
process.exit(failed ? 1 : 0);
