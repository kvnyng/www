#!/usr/bin/env bun
/* The card a shared /resume link unfurls into.
 *
 *   bun scripts/og-card.mjs            # writes assets/images/resume-og.png
 *   bun scripts/og-card.mjs --open     # ...and opens it
 *
 * A link preview is a still, and the page it stands for is not: the pile is
 * a thing you deal with the wheel, and none of that survives a screenshot.
 * So the card is not a screenshot. It is the same room and the same object
 * built again at 1200x630 — the dark ground, the two sheets lying askew, the
 * page's own faces — arranged for the one frame a preview gets.
 *
 * It is drawn by the browser rather than by hand in an image editor for the
 * same reason the page is: the sheets here are resume/page-{1,2}.svg, the
 * real tracings, so when the resume is re-exported the card re-renders from
 * the new pages instead of quietly going stale. Chrome is asked for a 2x
 * raster and sips brings it back down to 1200x630 — the vectors are drawn at
 * twice the density and averaged down, which is what keeps six-point body
 * type reading as type and not as grey mush.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'assets/images/resume-og.png');
const TMP = process.env.OG_TMP
    || '/private/tmp/claude-501/-Users-kvnyng-projects-www/og-card';

/* The card's own size, and the one every consumer of og:image assumes. */
const W = 1200, H = 630;

const PROFILE = join(TMP, `chrome-profile-${process.pid}-${Date.now().toString(36)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── The card ─────────────────────────────────────────────────────────────
 * Served at /__og-card off the same root as the rest, so the sheets and the
 * vendored faces resolve by their real site paths and nothing here has a
 * second copy of anything. */

const CARD = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<style>
  :root {
      --text-color: white;
      --background-color: #1E1E1E;
      --grey-out: #808080;
      --font-heading: 'Philosopher', sans-serif;
  }

  * { box-sizing: border-box; margin: 0; }

  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }

  body {
      background: var(--background-color);
      font-family: var(--font-heading);
      color: var(--text-color);
      position: relative;
  }

  /* ── The pile ───────────────────────────────────────────────────────
     Centred, and far too big for the frame on purpose: the paper comes up
     from the bottom edge and is cut off by it, so what the card shows is
     the head of a document that plainly continues. A page shrunk to fit
     inside its card is a picture of a page; a page the card cannot hold
     is a page.

     Wider than the frame's middle and tilted a couple of degrees, which
     is what keeps it from reading as a screenshot pasted onto black. */
  .pile {
      position: absolute;
      left: 50%;
      top: 208px;
      width: 852px;
      margin-left: -426px;
      aspect-ratio: 612 / 792;
      transform: rotate(2.2deg);
      /* Turned about the top edge, so the lean does not swing the visible
         head of the page off centre. */
      transform-origin: 50% 0;
  }

  .sheet { position: absolute; inset: 0; }

  /* The under-sheet lies askew, the way a pile actually lands. Its corner
     past the top page is the whole reason there are two of them here, and
     with the foot of the pile off the card that corner is the only tell
     left — so it leans further than the 1.7deg the page rests at, and it
     leans back against the top sheet rather than with it: counter-turned
     past straight, the under-page's top edge comes out above and right of
     the leading one, which is the corner of the card that has the room. */
  .s2 {
      transform: rotate(-3.6deg) translate(0.7%, -0.2%);
      transform-origin: 50% 45%;
  }

  /* Paper and its body. The page's own rule is a stack of hairlines along
     the bottom edge — the edge this card cuts off — so the shade that has
     to do the work here is cast down and to the right, off the top sheet
     onto the strip of the one beneath it. */
  .sheet img {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      background: white;
      border-radius: 3px;
      box-shadow:
          0 1px 0 #d6d4cd,
          0 2.5px 0 #b9b7af,
          10px 12px 26px rgba(0, 0, 0, 0.55);
  }

  /* Each sheet's pool of shade on the desk — a baked gradient rather than
     a filter, as on the page. Only its top arc is on the card, which is
     the part that sets the paper off the ground. */
  .aura {
      position: absolute;
      background: radial-gradient(ellipse closest-side,
              rgba(0, 0, 0, 0.85) 45%,
              rgba(0, 0, 0, 0.45) 72%,
              rgba(0, 0, 0, 0) 100%);
  }
  .s1 .aura { inset: -3% -5% -7% -5%; opacity: 0.5; }
  .s2 .aura { inset: -2% -6% -9% -6%; opacity: 0.4; }

  /* The under-page is further from the light. */
  .dim {
      position: absolute;
      inset: 0;
      background: #000;
      opacity: 0.09;
      border-radius: 3px;
  }

  /* ── The title ──────────────────────────────────────────────────────
     In the air above the paper, centred over it. The counter's key: the
     name in ink, what it is in the grey the page keeps for captions —
     "Kevin Yang Resume" read as one line, coloured as two facts. */
  .title {
      position: absolute;
      top: 92px;
      left: 0;
      right: 0;
      text-align: center;
      font-size: 66px;
      line-height: 1;
      letter-spacing: -0.005em;
      /* Above the paper in the stack as well as over it, for the corner
         that leans up into the line's outer end. */
      z-index: 2;
      /* The same halo the crumbs and the counter wear, for where the tilt
         brings white paper up under white type. */
      text-shadow: 0 1px 12px rgba(30, 30, 30, 0.95), 0 0 4px rgba(30, 30, 30, 0.95);
  }

  .title .what { color: var(--grey-out); }
</style>
</head>
<body>
  <p class="title">Kevin Yang <span class="what">Resume</span></p>

  <div class="pile">
      <div class="sheet s2">
          <div class="aura"></div>
          <img src="/resume/page-2.svg" width="612" height="792" alt="">
          <div class="dim"></div>
      </div>
      <div class="sheet s1">
          <div class="aura"></div>
          <img src="/resume/page-1.svg" width="612" height="792" alt="">
      </div>
  </div>
</body>
</html>`;

/* ── The server ───────────────────────────────────────────────────────── */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.pdf': 'application/pdf',
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
            if (path === '/__og-card') {
                return new Response(CARD, {
                    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
                });
            }
            if (path.endsWith('/')) path += 'index.html';
            const file = resolve(join(ROOT, path));
            /* A dumb server, but not a naive one: nothing above the root. */
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
        `--window-size=${W},${H}`,
        /* Draw at twice the density and let sips average it back down. */
        '--force-device-scale-factor=2',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--hide-scrollbars',
        '--mute-audio',
        /* Hermetic: the faces are vendored, and a card whose type depends on
           reaching a font host is a card that renders differently offline. */
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

function cdpConnect(url) {
    return new Promise((res, rej) => {
        const ws = new WebSocket(url);
        const waiting = new Map();
        let seq = 0;
        let dead = null;

        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.id === undefined) return;
            const w = waiting.get(msg.id);
            if (!w) return;
            waiting.delete(msg.id);
            clearTimeout(w.timer);
            if (msg.error) w.rej(new Error(`${msg.error.message} [${msg.error.code}]`));
            else w.res(msg.result);
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
            close() { try { ws.close(); } catch { } },
        }));
    });
}

/* ── The run ──────────────────────────────────────────────────────────── */

let server = null, chrome = null, cdp = null;

function cleanup() {
    try { cdp && cdp.close(); } catch { }
    try { chrome && chrome.proc.kill(); } catch { }
    try { server && server.stop(true); } catch { }
    setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch { } }, 250);
}

try {
    mkdirSync(TMP, { recursive: true });

    const bin = chromeBinary();
    if (!bin) throw new Error('no Chrome found — set CHROME to a binary');

    server = serve();
    const base = `http://127.0.0.1:${server.port}`;

    chrome = await launchChrome(bin);
    cdp = await cdpConnect(await pageTarget(chrome.port));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: `${base}/__og-card` });

    /* Two sheets of traced vector and three webfont files have to be in hand
       before the shutter: the wait is on the browser saying so, not on a
       number of milliseconds picked because it worked once. */
    const ready = async () => {
        const { result } = await cdp.send('Runtime.evaluate', {
            expression: `(async () => {
                await document.fonts.ready;
                const imgs = [...document.images];
                return imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0);
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        return result.value === true;
    };
    const deadline = Date.now() + 20000;
    while (!(await ready())) {
        if (Date.now() > deadline) throw new Error('the card never finished loading its sheets or its faces');
        await sleep(100);
    }
    /* One frame past ready, so the last raster is the one that gets caught. */
    await sleep(250);

    const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: W, height: H, scale: 2 },
        captureBeyondViewport: true,
    });

    const big = join(TMP, 'card@2x.png');
    writeFileSync(big, Buffer.from(data, 'base64'));

    mkdirSync(join(ROOT, 'assets/images'), { recursive: true });
    const sips = Bun.spawnSync(['sips', '-z', String(H), String(W), big, '--out', OUT],
        { stdout: 'ignore', stderr: 'pipe' });
    if (sips.exitCode !== 0) {
        throw new Error(`sips could not resample the card\n${new TextDecoder().decode(sips.stderr)}`);
    }

    const kb = Math.round(statSync(OUT).size / 1024);
    console.log(`${OUT.slice(ROOT.length + 1)}  ${W}x${H}  ${kb} KB`);
    if (process.argv.includes('--open')) Bun.spawnSync(['open', OUT]);
} finally {
    cleanup();
}
