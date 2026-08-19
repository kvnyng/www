#!/usr/bin/env bun
/* A test bench for the resume's highlighter.
 *
 *   bun scripts/highlights-test.mjs
 *
 * Same shape as the zoom bench (scripts/zoom-test.mjs): a loopback server over the repo root, a
 * headless Chrome, a raw CDP socket, and nothing installed or left running.
 * The feature is reached two ways — through `window.__hl`, the frozen debug
 * hook, for the interval and codec algebra; and through real selections and
 * real coordinate clicks for the flows a reader actually performs, because
 * the menu appearing over the paper is the feature.
 *
 * The words under test only exist once the PDF has arrived and the text
 * layers are laid, so the first wait is for `__hl.text()` to have length —
 * everything before that would be testing an empty page.
 *
 * Every wait is a poll against a deadline. A bench that hangs is worse than
 * one that fails.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OUT = process.env.HL_TEST_OUT
    || '/private/tmp/claude-501/-Users-kvnyng-projects-www/b3c7e97e-f683-48c2-9aae-9a1fd1669aa2/scratchpad';
const SHOTS = join(OUT, 'hl-shots');
const PROFILE = join(OUT, `chrome-profile-hl-${process.pid}-${Date.now().toString(36)}`);

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
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
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
            if (file !== ROOT && !file.startsWith(ROOT + '/')) {
                return new Response('forbidden', { status: 403 });
            }
            const f = Bun.file(file);
            if (!(await f.exists())) {
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
        '--window-size=1200,900',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--hide-scrollbars',
        '--mute-audio',
        /* Hermetic: the page reaches for a font host and an analytics tag,
         * and neither is what is under test. Only the loopback answers. */
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

/* ── Page-side helpers ────────────────────────────────────────────────── */

/* The bench makes selections the way the page's own listeners expect to see
 * them — through the real Selection object, letting selectionchange fire —
 * and presses menu buttons through the pointerdown/pointerup/click a finger
 * would produce (the up matters: the highlighter waits for the hand to
 * lift). */
const HELPERS = `
window.__bench = {
    select(chars) {
        const layer = document.querySelector('.s1 .textlayer');
        const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let node; (node = w.nextNode());) {
            if (node.data.trim().length < chars) continue;
            const r = document.createRange();
            r.setStart(node, 0);
            r.setEnd(node, chars);
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
            return sel.toString();
        }
        return null;
    },
    press(selector) {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
    },
    paints() {
        const out = {};
        for (const [k, v] of CSS.highlights) out[k] = v.size;
        return out;
    },
};
true`;

/* The codec, re-spoken here just far enough to cut a payload against a text
 * length the page does not have — the staleness the decoder must refuse. */
function varint(v) {
    const out = [];
    while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); }
    out.push(v);
    return out;
}
function b64url(bytes) {
    return Buffer.from(bytes).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── The run ──────────────────────────────────────────────────────────── */

const pageErrors = [];
const ignored = [];
let server = null, chrome = null, cdp = null;

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
    notOk('bench completed within its watchdog', 'the whole run exceeded 240s');
    say(`1..${n}`);
    await teardown();
    process.exit(1);
}, 240000);

/* The analytics tag and the font host are refused by the hermetic resolver;
 * those failures are the environment's, not the feature's. */
const IGNORABLE = /googletagmanager|gtag|Failed to fetch|net::ERR|favicon|fonts\.g|ERR_NAME_NOT_RESOLVED/i;

try {
    mkdirSync(SHOTS, { recursive: true });

    const bin = chromeBinary();
    if (!bin) {
        skip('a chrome to drive', 'no Chrome/Chromium binary found; set CHROME=');
        say(`1..${n}`);
        process.exit(0);
    }

    server = serve();
    const base = `http://127.0.0.1:${server.port}`;
    const PAGE = `${base}/resume/`;
    chrome = await launchChrome(bin);
    cdp = await cdpConnect(await pageTarget(chrome.port));
    const evaluate = makeEval(cdp);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.exceptionThrown', (p) => {
        const text = p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '';
        (IGNORABLE.test(text) ? ignored : pageErrors).push(text);
    });

    /* A hash-only navigation is same-document and reloads nothing, so every
     * arrival that must be fresh goes through about:blank first. */
    async function open(url) {
        await cdp.send('Page.navigate', { url: 'about:blank' });
        await sleep(50);
        await cdp.send('Page.navigate', { url });
        const ready = await until(() => evaluate('!!window.__hl && __hl.text().length > 0'), 30000, 200);
        if (ready) await evaluate(HELPERS);
        return ready;
    }

    async function clickAt(x, y) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }

    async function shoot(name) {
        try {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(SHOTS, name), Buffer.from(shot.data, 'base64'));
        } catch { /* a missing picture is not a failed test */ }
    }

    /* ── The hook, and words to point at ──────────────────────────────── */

    if (!check('the resume lays its words and exposes window.__hl', await open(PAGE),
        'text layers never arrived')) {
        throw new Error('nothing to test without the words');
    }
    check('the browser has the Custom Highlight API',
        await evaluate('!!(window.CSS && CSS.highlights && typeof Highlight !== "undefined")'));
    const total = await evaluate('__hl.text().length');
    const seam = await evaluate('__hl.seam()');
    check('both pages are on the line', seam > 100 && total > seam + 100,
        `total ${total}, seam ${seam}`);

    /* ── Interval algebra, through the hook ───────────────────────────── */

    await evaluate('__hl.clear()');
    await evaluate('__hl.add(10, 20, 0)');
    await evaluate('__hl.add(15, 30, 1)');
    let marks = await evaluate('__hl.marks()');
    check('a new mark takes ground from an old one',
        marks.length === 2 && marks[0].s === 10 && marks[0].e === 15 && marks[0].c === 0
        && marks[1].s === 15 && marks[1].e === 30 && marks[1].c === 1,
        JSON.stringify(marks));

    await evaluate('__hl.add(30, 40, 1)');
    marks = await evaluate('__hl.marks()');
    check('touching same-color marks fuse into one',
        marks.length === 2 && marks[1].s === 15 && marks[1].e === 40 && marks[1].c === 1,
        JSON.stringify(marks));

    await evaluate('__hl.add(5, 50, 3)');
    marks = await evaluate('__hl.marks()');
    check('a covering mark swallows everything under it',
        marks.length === 1 && marks[0].s === 5 && marks[0].e === 50 && marks[0].c === 3,
        JSON.stringify(marks));

    /* ── The codec ────────────────────────────────────────────────────── */

    await evaluate('__hl.clear()');
    await evaluate(`__hl.add(3, 17, 0); __hl.add(40, 41, 2); __hl.add(${seam - 60}, ${seam - 10}, 1); __hl.add(${seam + 20}, ${seam + 90}, 3)`);
    const before = await evaluate('__hl.marks()');
    const payload = await evaluate('__hl.encode()');
    check('the payload is short and url-safe',
        /^[A-Za-z0-9_-]{1,40}$/.test(payload), `payload: ${payload}`);
    const decoded = await evaluate(`__hl.decode(${JSON.stringify(payload)})`);
    check('decode(encode(marks)) is the identity',
        decoded && JSON.stringify(decoded.marks) === JSON.stringify(before),
        JSON.stringify({ before, decoded }));
    check('the payload remembers the text it measured', decoded && decoded.total === total);
    check('garbage decodes to null, not to a throw',
        (await evaluate('[__hl.decode("!!!"), __hl.decode(""), __hl.decode("zzzzzz")]')).every((v) => v === null));

    check('the marks live in the fragment',
        (await evaluate('location.hash')).startsWith('#hl='));

    /* ── The fragment is shared with the deal ─────────────────────────── */

    await evaluate('dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))');
    let hash = await until(async () => {
        const h = await evaluate('location.hash');
        return /(^#|&)two(&|$)/.test(h) && h;
    }, 4000);
    check('dealing to page two keeps the marks in the fragment',
        !!hash && hash.includes('hl='), String(hash));

    await evaluate('dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }))');
    hash = await until(async () => {
        const h = await evaluate('location.hash');
        return !/(^#|&)two(&|$)/.test(h) && h;
    }, 4000);
    check('dealing back drops the word and keeps the marks',
        !!hash && hash.startsWith('#hl='), String(hash));

    await evaluate('__hl.clear()');
    check('no marks, no fragment', (await evaluate('location.hash')) === '');

    /* ── A reader's first mark ────────────────────────────────────────── */

    const selText = await evaluate('__bench.select(12)');
    check('a run of the resume can be selected', typeof selText === 'string' && selText.length === 12,
        String(selText));
    let menu = await until(() => evaluate('__hl.menu().open && __hl.menu()'), 3000);
    check('the menu rises over a settled selection', !!menu && menu.mode === 'draft', JSON.stringify(menu));
    check('the draft menu offers no delete',
        await evaluate('getComputedStyle(document.querySelector(".hl-menu [data-act=delete]")).display === "none"'));

    await evaluate('__bench.press(".hl-swatch[data-color=\\"1\\"]")');
    marks = await evaluate('__hl.marks()');
    check('picking a color makes the mark', marks.length === 1 && marks[0].c === 1, JSON.stringify(marks));
    check('the mark is painted', (await evaluate('__bench.paints()')).hl1 === 1);
    check('the menu stays, now about the mark', (await evaluate('__hl.menu()')).mode === 'mark');
    check('the mark sits on the selected words',
        (await evaluate('__hl.text().slice(__hl.marks()[0].s, __hl.marks()[0].e)')) === selText.trim());
    const shareURL = await evaluate('location.href');
    check('the share link is already in the address bar', shareURL.includes('#hl='));

    /* ── The link travels ─────────────────────────────────────────────── */

    check('a fresh visit to the share link restores the mark', await open(shareURL)
        && JSON.stringify(await evaluate('__hl.marks()')) === JSON.stringify(marks));
    check('the restored mark is painted', (await evaluate('__bench.paints()')).hl1 === 1);

    /* ── Revisiting by pointing at it ─────────────────────────────────── */

    const rect = await evaluate('__hl.rect(0)');
    if (check('the mark has a box to aim at', !!rect, 'no client rect')) {
        const cx = rect.x + Math.min(rect.w / 2, 40), cy = rect.y + rect.h / 2;
        await clickAt(cx, cy);
        menu = await until(() => evaluate('__hl.menu().open && __hl.menu()'), 3000);
        check('clicking the mark reopens the menu', !!menu && menu.mode === 'mark', JSON.stringify(menu));
        check('the menu rings the mark\'s color',
            await evaluate('document.querySelector(".hl-swatch.current")?.dataset.color') === '1');

        await evaluate('__bench.press(".hl-swatch[data-color=\\"2\\"]")');
        marks = await evaluate('__hl.marks()');
        check('a second thought recolors the mark', marks.length === 1 && marks[0].c === 2, JSON.stringify(marks));
        check('the fragment follows the recolor',
            (await evaluate('location.href')) !== shareURL && (await evaluate('location.hash')).startsWith('#hl='));

        /* The paper moves under a wheel; the menu must not hang in the air. */
        await evaluate('dispatchEvent(new WheelEvent("wheel", { deltaY: 0, bubbles: true }))');
        await sleep(150);
        check('a wheel takes the menu down', !(await evaluate('__hl.menu().open')));

        /* And a miss beside the mark closes rather than finds. */
        await clickAt(cx, cy);
        await until(() => evaluate('__hl.menu().open'), 3000);
        await clickAt(cx + 260, cy + 200);
        await sleep(300);
        check('clicking empty paper closes the menu', !(await evaluate('__hl.menu().open')));
    }

    /* ── Copy, if the sandbox allows a clipboard ──────────────────────── */

    try {
        await cdp.send('Browser.grantPermissions', {
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            origin: base,
        });
        await cdp.send('Page.bringToFront');
        const r2 = await evaluate('__hl.rect(0)');
        await clickAt(r2.x + Math.min(r2.w / 2, 40), r2.y + r2.h / 2);
        await until(() => evaluate('__hl.menu().open'), 3000);
        await evaluate('__bench.press(".hl-menu [data-act=copy]")');
        const clip = await until(() => evaluate('navigator.clipboard.readText()'), 3000);
        check('copy puts the marked words on the clipboard', clip === selText.trim(), String(clip));
        await evaluate('__bench.press(".hl-menu [data-act=link]")');
        const clip2 = await until(() => evaluate('navigator.clipboard.readText()'), 3000);
        check('copy link puts the share url on the clipboard',
            typeof clip2 === 'string' && clip2.includes('#hl='), String(clip2));
    } catch (e) {
        skip('clipboard round-trips', `headless clipboard unavailable: ${e.message}`);
        skip('copy link', 'same');
    }

    /* ── A picture, then delete ───────────────────────────────────────── */

    await evaluate(`__hl.add(${seam + 20}, ${seam + 90}, 0)`);
    await shoot('resume-highlights.png');

    await evaluate('__bench.press(".hl-menu [data-act=delete]")');
    marks = await evaluate('__hl.marks()');
    check('delete takes the mark away, and only it', marks.length === 1 && marks[0].s === seam + 20,
        JSON.stringify(marks));
    check('and the menu closes', !(await evaluate('__hl.menu().open')));
    await evaluate('__hl.clear()');

    /* ── The menu under the glass ─────────────────────────────────────── */

    /* Zoomed in, a passage that wraps a line is as wide as the enlarged
     * sheet: its bounding box runs far past the screen, and a menu centred
     * on that box parks in a corner. The menu must speak about the words a
     * reader can see. */
    await evaluate(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        for (let i = 0; i < 24; i++) {
            dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -24,
                clientX: innerWidth / 2, clientY: innerHeight / 2, cancelable: true, bubbles: true }));
            await frame();
        }
    })()`);
    await sleep(700); /* past the settle, whatever mechanism holds the scale */
    /* The scale lives on the zoomer's transform mid-gesture and on .grab's
     * CSS zoom once settled; the glass's height is the product. */
    const glass = await evaluate(`(() => {
        const m = getComputedStyle(document.querySelector('.zoomer')).transform;
        const a = m && m !== 'none' ? parseFloat(m.slice(m.indexOf('(') + 1)) : 1;
        const gz = parseFloat(getComputedStyle(document.querySelector('.grab')).zoom) || 1;
        return a * gz;
    })()`);
    check('the glass goes up', glass > 4, `effective zoom ${glass}`);
    const wrapped = await evaluate(`(() => {
        const layer = document.querySelector('.s1 .textlayer');
        const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let t; (t = w.nextNode());) if (t.data.trim().length) nodes.push(t);
        for (let i = 0; i < nodes.length; i++) {
            const r = document.createRange();
            r.selectNodeContents(nodes[i]);
            const b = r.getBoundingClientRect();
            if (b.width > 0 && b.left >= 0 && b.top >= 80 &&
                b.right <= innerWidth && b.bottom <= innerHeight - 80) {
                /* Reach forward until the box is wider than the screen —
                 * the pathological shape this section exists to hold. */
                let bb = b;
                for (let j = i + 1; j < nodes.length && bb.width <= innerWidth; j++) {
                    r.setEnd(nodes[j], nodes[j].data.length);
                    bb = r.getBoundingClientRect();
                }
                const sel = getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
                return { w: bb.width, text: sel.toString().slice(0, 20) };
            }
        }
        return null;
    })()`);
    check('a wrapped run outruns the screen', !!wrapped
        && wrapped.w > (await evaluate('innerWidth')), JSON.stringify(wrapped));
    menu = await until(() => evaluate('__hl.menu().open && __hl.menu()'), 3000);
    check('the menu rises under the glass', !!menu && menu.mode === 'draft', JSON.stringify(menu));

    /* Where the menu hangs, against where the visible words are — the
     * range's line boxes clipped to the viewport, by hand here. */
    const seen = `((range) => {
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const box of range.getClientRects()) {
            const cl = Math.max(box.left, 0), cr = Math.min(box.right, innerWidth);
            const ct = Math.max(box.top, 0), cb = Math.min(box.bottom, innerHeight);
            if (cr <= cl || cb <= ct) continue;
            if (cl < l) l = cl; if (ct < t) t = ct;
            if (cr > r) r = cr; if (cb > b) b = cb;
        }
        const m = document.querySelector('.hl-menu').getBoundingClientRect();
        return { vis: { l, t, r, b }, menu: { l: m.left, t: m.top, r: m.right, b: m.bottom },
            inner: { w: innerWidth, h: innerHeight } };
    })`;
    const overWords = (p) =>
        p.menu.l >= 0 && p.menu.t >= 0 && p.menu.r <= p.inner.w && p.menu.b <= p.inner.h &&
        (p.menu.l + p.menu.r) / 2 > p.vis.l && (p.menu.l + p.menu.r) / 2 < p.vis.r &&
        p.menu.b <= p.vis.t && p.vis.t - p.menu.b <= 30;
    let placed = await evaluate(`${seen}(getSelection().getRangeAt(0))`);
    check('the menu hangs over the words on screen', overWords(placed), JSON.stringify(placed));

    /* And again once the color lands — the menu re-shows about the mark,
     * the same placement a clicked wash gets. */
    await evaluate('__bench.press(".hl-swatch[data-color=\\"2\\"]")');
    await until(() => evaluate('__hl.menu().mode === "mark"'), 3000);
    placed = await evaluate(`${seen}([...CSS.highlights.get('hl2')][0])`);
    check('and still over the wash it just made', overWords(placed), JSON.stringify(placed));

    await evaluate('__hl.clear()');
    await evaluate('dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(300);

    /* ── Bad and stale links ──────────────────────────────────────────── */

    check('a mangled fragment falls back to a clean page',
        await open(`${PAGE}#hl=not-a-real-payload-at-all`)
        && (await evaluate('__hl.marks()')).length === 0);

    /* A payload cut against words this page does not have. */
    const stale = b64url([1, ...varint(total + 7), ...varint(5), ...varint((10 - 1) * 4 + 0)]);
    check('a link cut against other words stays silent',
        await open(`${PAGE}#hl=${stale}`)
        && (await evaluate('__hl.marks()')).length === 0);

    /* And a fresh arrival on #two&hl= lands dealt and marked. */
    const two = b64url([1, ...varint(total), ...varint(seam + 5), ...varint((40 - 1) * 4 + 2)]);
    const landed = await open(`${PAGE}#two&hl=${two}`);
    check('a #two&hl= link lands on page two with the mark',
        landed && (await evaluate('__hl.marks()')).length === 1
        && (await evaluate('document.querySelector(".counter .live").textContent')) === 'two',
        JSON.stringify(await evaluate('__hl.marks()')));

    check('no unexpected page errors', pageErrors.length === 0, pageErrors.join('\n'));
    if (ignored.length) note(`ignored ${ignored.length} environmental error(s): ${ignored[0]}`);
} catch (e) {
    notOk('bench ran to completion', e && e.stack || String(e));
} finally {
    clearTimeout(watchdog);
    say(`1..${n}`);
    note(`${failed} failed, ${skipped} skipped, shots in ${SHOTS}`);
    await teardown();
    process.exit(failed ? 1 : 0);
}
