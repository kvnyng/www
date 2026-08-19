/* A highlighter for the resume. Sweep some words on either sheet and a small
 * palette appears; pick a color and the passage stays washed, the way a
 * highlighter would leave it. Click a wash later and the palette returns,
 * now with a way to remove it.
 *
 * Nothing is stored anywhere. The whole markup lives in the URL fragment —
 * each mark is (start, length, color) measured in characters over the two
 * pages' text, delta-coded into varints and base64url'd into hl=. Copy the
 * address bar and the marks travel with it; no server, no localStorage. The
 * fragment is shared with the deal's resting word (#two), so both writers
 * compose the whole from each other's facts.
 *
 * The words themselves are the pdf.js text layers the page already lays
 * over its sheets — real text nodes in sheet coordinates, so they ride the
 * deal, the zoom and the swing on their own. Painting goes through the CSS
 * Custom Highlight API rather than wrapping elements, and that choice is
 * load-bearing twice over: the layers' DOM stays exactly as pdf.js built it,
 * and the character offsets the URL speaks in stay true no matter how often
 * the layers are rebuilt — a resize throws the spans away and lays new ones,
 * but the text is the same text, so the numbers still point at the same
 * words. A MutationObserver watches for those rebuilds and re-aims the
 * ranges. Browsers without the API just read the paper.
 */
(() => {
    'use strict';

    const NCOLORS = 4; // two bits in the encoding; the palette lives in style.css
    const VERSION = 1;

    let layers = [];        // the two .textlayer containers, in page order
    let layerRanges = [];   // a Range over each container's contents
    let base = [0, 0];      // where each layer's text begins on the global line
    let nodes = [];         // every text node, page one's then page two's
    let starts = [];        // its offset on the global line
    let fullText = '';
    let indexedOnce = false;

    let marks = [];         // {s, e, c} — sorted, disjoint, e exclusive
    let draft = null;       // {s, e} of the current selection, before it has a color
    let active = null;      // the mark the open menu is about, by identity
    let mode = null;        // 'draft' | 'mark'
    let menu;

    /* ── The text, measured whenever the layers are laid ──────────────── */

    /* Offsets are counted over the concatenation of the text nodes of page
     * one's layer and then page two's — page order, not document order,
     * because the pile stacks page two's markup underneath page one's. */
    function reindex() {
        const fresh = [];
        for (const layer of layers) {
            const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
            for (let t; (t = walker.nextNode());) if (t.data.length) fresh.push(t);
        }
        if (fresh.length === nodes.length && fresh.every((t, i) => t === nodes[i])) return;
        nodes = fresh;
        starts = [];
        let total = 0;
        for (const t of nodes) { starts.push(total); total += t.data.length; }
        fullText = nodes.map((t) => t.data).join('');
        layerRanges = layers.map((layer) => {
            const r = document.createRange();
            r.selectNodeContents(layer);
            return r;
        });
        base = [0, 0];
        for (const t of nodes) {
            if (layers[0].contains(t)) base[1] += t.data.length;
            else break;
        }
        /* The first real index is the moment a shared link can finally be
         * read against the words it was cut from. */
        if (!indexedOnce && fullText.length) { indexedOnce = true; applyHash(); }
        render();
    }

    /* Global offset → (text node, local offset). An end boundary that falls
     * on a node seam belongs to the earlier node's tail, not the next one's
     * head, or a mark ending at a line would leak into the next. */
    function locate(off, isEnd) {
        let lo = 0, hi = nodes.length - 1, i = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] < off || (!isEnd && starts[mid] === off)) { i = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return [nodes[i], Math.max(0, Math.min(off - starts[i], nodes[i].data.length))];
    }

    function rangeFor(m) {
        const r = document.createRange();
        const [sn, so] = locate(m.s, false);
        const [en, eo] = locate(m.e, true);
        r.setStart(sn, so);
        r.setEnd(en, eo);
        return r;
    }

    /* (node, offset) inside a layer → global offset. Range.toString()
     * concatenates exactly the text nodes the index walked, so the two
     * coordinate systems agree by construction. */
    function pointToGlobal(node, offset) {
        for (let i = 0; i < layers.length; i++) {
            if (!layers[i].contains(node)) continue;
            const r = layerRanges[i].cloneRange();
            try { r.setEnd(node, offset); } catch { return null; }
            return base[i] + r.toString().length;
        }
        return null;
    }

    /* A selection's span on the global line, clamped to the one layer it
     * touches. A boundary that wandered off the paper — onto the desk, the
     * catcher, the crumbs — clamps to that layer's edge. */
    function selectionSpan(range) {
        for (let i = 0; i < layers.length; i++) {
            let cs, ce;
            try {
                cs = layerRanges[i].comparePoint(range.startContainer, range.startOffset);
                ce = layerRanges[i].comparePoint(range.endContainer, range.endOffset);
            } catch { continue; }
            if (cs !== 0 && ce !== 0 && !(cs < 0 && ce > 0)) continue;
            const len = i + 1 < layers.length ? base[i + 1] - base[i] : fullText.length - base[i];
            const s = cs < 0 ? base[i] : cs > 0 ? base[i] + len
                : pointToGlobal(range.startContainer, range.startOffset);
            const e = ce < 0 ? base[i] : ce > 0 ? base[i] + len
                : pointToGlobal(range.endContainer, range.endOffset);
            if (s === null || e === null) return null;
            if (e > s) return { s, e };
        }
        return null;
    }

    /* ── The marks ────────────────────────────────────────────────────── */

    /* Touching same-color marks fuse into one; everything stays sorted and
     * disjoint, which is what keeps the encoding's deltas non-negative.
     * Marks that come through untouched keep their identity — the open
     * menu holds its mark by reference, and an unrelated addition must not
     * quietly swap the object out from under it. */
    function normalized(list) {
        list.sort((a, b) => a.s - b.s);
        const out = [];
        for (const m of list) {
            const last = out[out.length - 1];
            if (last && last.e === m.s && last.c === m.c) {
                out[out.length - 1] = { s: last.s, e: m.e, c: last.c };
            } else out.push(m);
        }
        return out;
    }

    /* A new mark wins the ground it covers: overlapped neighbors are
     * trimmed, swallowed ones removed. Returns the surviving mark that
     * contains the added span (it may have fused with a neighbor). */
    function addMark(s, e, c) {
        const next = [];
        for (const m of marks) {
            if (m.e <= s || m.s >= e) { next.push(m); continue; }
            if (m.s < s) next.push({ s: m.s, e: s, c: m.c });
            if (m.e > e) next.push({ s: e, e: m.e, c: m.c });
        }
        next.push({ s, e, c });
        marks = normalized(next);
        return marks.find((m) => m.s <= s && e <= m.e) || null;
    }

    function removeMark(mark) {
        marks = marks.filter((m) => m !== mark);
    }

    function recolor(mark, c) {
        mark.c = c;
        marks = normalized(marks);
        return marks.find((m) => m.s <= mark.s && mark.e <= m.e) || null;
    }

    function render() {
        for (let c = 0; c < NCOLORS; c++) {
            const ranges = marks.filter((m) => m.c === c).map(rangeFor);
            if (ranges.length) CSS.highlights.set('hl' + c, new Highlight(...ranges));
            else CSS.highlights.delete('hl' + c);
        }
        if (active) CSS.highlights.set('hlx', new Highlight(rangeFor(active)));
        else CSS.highlights.delete('hlx');
    }

    /* ── The encoding ─────────────────────────────────────────────────── */

    /* bytes: [version][varint textLength][per mark: varint gap-from-previous-
     * end, varint (length-1)*4+color]. The text length is the staleness
     * check: if the resume is ever revised, old links decode to nothing
     * rather than to washes quietly sitting on the wrong words. */

    function pushV(bytes, v) {
        while (v > 127) { bytes.push((v & 127) | 128); v = Math.floor(v / 128); }
        bytes.push(v);
    }

    function encode() {
        if (!marks.length) return '';
        const bytes = [VERSION];
        pushV(bytes, fullText.length);
        let prev = 0;
        for (const m of marks) {
            pushV(bytes, m.s - prev);
            pushV(bytes, (m.e - m.s - 1) * 4 + m.c);
            prev = m.e;
        }
        return btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function decode(payload) {
        try {
            const raw = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
            const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
            if (bytes[0] !== VERSION) return null;
            let i = 1;
            const readV = () => {
                let v = 0, mul = 1;
                for (;;) {
                    if (i >= bytes.length) throw new Error('truncated');
                    const b = bytes[i++];
                    v += (b & 127) * mul;
                    if (b < 128) return v;
                    mul *= 128;
                }
            };
            const total = readV();
            const out = [];
            let prev = 0;
            while (i < bytes.length) {
                const s = prev + readV();
                const packed = readV();
                const e = s + Math.floor(packed / 4) + 1;
                if (e > total) return null;
                out.push({ s, e, c: packed % 4 });
                prev = e;
            }
            return { total, marks: out };
        } catch { return null; }
    }

    /* The fragment is shared ground: the deal's rest() writes the page word
     * and carries hl= through; this side writes hl= and carries the word. */
    function sync() {
        const two = /(^#|&)two(&|$)/.test(location.hash);
        const payload = encode();
        const frag = [two ? 'two' : '', payload ? 'hl=' + payload : ''].filter(Boolean).join('&');
        history.replaceState(null, '', frag ? '#' + frag : location.pathname);
    }

    function applyHash() {
        if (!fullText.length) return; // the words are not laid yet; read the hash when they are
        const m = location.hash.match(/hl=([A-Za-z0-9_-]+)/);
        const decoded = m && decode(m[1]);
        /* A length mismatch means the words moved since this link was cut.
         * Wrong marks are worse than none. */
        marks = decoded && decoded.total === fullText.length ? decoded.marks : [];
        active = null;
        render();
    }

    /* ── The menu ─────────────────────────────────────────────────────── */

    const ICONS = {
        copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
    };
    const svg = (name, cls) =>
        `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

    function buildMenu() {
        menu = document.createElement('div');
        menu.className = 'hl-menu';
        menu.setAttribute('role', 'toolbar');
        menu.setAttribute('aria-label', 'Highlight');
        const swatches = Array.from({ length: NCOLORS }, (_, c) =>
            `<button type="button" class="hl-swatch" data-color="${c}" aria-label="Highlight color ${c + 1}"></button>`
        ).join('');
        menu.innerHTML = swatches
            + '<span class="hl-menu-rule"></span>'
            + `<button type="button" class="hl-act" data-act="copy" title="Copy text" aria-label="Copy text">${svg('copy', 'when-idle')}${svg('check', 'when-copied')}</button>`
            + `<button type="button" class="hl-act" data-act="link" title="Copy link with highlights" aria-label="Copy link with highlights">${svg('link', 'when-idle')}${svg('check', 'when-copied')}</button>`
            + `<button type="button" class="hl-act" data-act="delete" title="Remove highlight" aria-label="Remove highlight">${svg('trash', 'when-idle')}</button>`;
        document.body.appendChild(menu);

        /* Pressing a button must not steal focus or the selection — the
         * selection is the very thing the button is about to act on. */
        menu.addEventListener('pointerdown', (ev) => ev.preventDefault());
        menu.addEventListener('click', onMenuClick);
    }

    const menuOpen = () => menu.classList.contains('open');

    function updateSwatches() {
        menu.querySelectorAll('.hl-swatch').forEach((b) => {
            b.classList.toggle('current', mode === 'mark' && !!active && +b.dataset.color === active.c);
        });
    }

    /* Fixed positioning against the viewport — this page never scrolls, the
     * paper moves under its transforms instead, and the rects the ranges
     * report already have every transform folded in. But under the glass a
     * range can run far past the screen: a passage that wraps a line is as
     * wide as the zoomed sheet, and a wash clicked at 8x may begin pages of
     * screen away. Centring on that box points at paper nobody can see, and
     * the clamp then parks the pill toward a corner — so the menu is placed
     * by the part of the range actually on screen: its line boxes clipped
     * to the viewport, united. */
    function visibleRect(range) {
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const box of range.getClientRects()) {
            const cl = Math.max(box.left, 0), cr = Math.min(box.right, innerWidth);
            const ct = Math.max(box.top, 0), cb = Math.min(box.bottom, innerHeight);
            if (cr <= cl || cb <= ct) continue;
            if (cl < l) l = cl;
            if (ct < t) t = ct;
            if (cr > r) r = cr;
            if (cb > b) b = cb;
        }
        return r > l ? { left: l, top: t, bottom: b, width: r - l }
            : range.getBoundingClientRect();
    }

    function showMenu(newMode, range) {
        mode = newMode;
        menu.dataset.mode = newMode;
        updateSwatches();
        menu.style.visibility = 'hidden';
        menu.classList.add('open');
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        const rect = visibleRect(range);
        let left = rect.left + rect.width / 2 - mw / 2;
        left = Math.max(8, Math.min(left, innerWidth - mw - 8));
        let top = rect.top - mh - 10;
        if (top < 8) top = Math.min(rect.bottom + 10, innerHeight - mh - 8);
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.visibility = '';
    }

    function hideMenu() {
        menu.classList.remove('open');
        mode = null;
        draft = null;
        if (active) { active = null; render(); }
    }

    function flash(btn) {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 900);
    }

    function copy(text, btn) {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(() => flash(btn), () => { });
    }

    function onMenuClick(ev) {
        const btn = ev.target.closest('button');
        if (!btn) return;
        if (btn.dataset.color !== undefined) {
            const c = +btn.dataset.color;
            if (mode === 'draft' && draft) {
                const m = addMark(draft.s, draft.e, c);
                draft = null;
                const sel = getSelection();
                if (sel) sel.removeAllRanges();
                active = m;
                render();
                sync();
                /* The menu stays, now speaking about the mark it just made —
                 * a second thought about the color costs one more click. */
                if (m) showMenu('mark', rangeFor(m)); else hideMenu();
            } else if (mode === 'mark' && active) {
                active = recolor(active, c);
                render();
                sync();
                updateSwatches();
            }
        } else if (btn.dataset.act === 'copy') {
            const span = mode === 'draft' ? draft : active;
            if (span) copy(fullText.slice(span.s, span.e), btn);
        } else if (btn.dataset.act === 'link') {
            copy(location.href, btn);
        } else if (btn.dataset.act === 'delete') {
            if (active) removeMark(active);
            hideMenu();
            render();
            sync();
        }
    }

    /* ── Pointing at a mark ───────────────────────────────────────────── */

    function caretAt(x, y) {
        if (document.caretPositionFromPoint) {
            const p = document.caretPositionFromPoint(x, y);
            return p ? [p.offsetNode, p.offset] : null;
        }
        if (document.caretRangeFromPoint) {
            const r = document.caretRangeFromPoint(x, y);
            return r ? [r.startContainer, r.startOffset] : null;
        }
        return null;
    }

    /* The caret snaps to the nearest text from anywhere on the paper, so
     * finding a mark under the caret is only half the test — the click must
     * also land on the mark's own painted boxes, which getClientRects
     * reports with the zoom and the deal already applied. */
    function markAt(x, y) {
        const pt = caretAt(x, y);
        if (!pt || !layers.some((l) => l.contains(pt[0]))) return null;
        const o = pointToGlobal(pt[0], pt[1]);
        if (o === null) return null;
        const hit = marks.find((m) => m.s <= o && o <= m.e);
        if (!hit) return null;
        for (const rect of rangeFor(hit).getClientRects()) {
            if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3) return hit;
        }
        return null;
    }

    /* ── Wiring ───────────────────────────────────────────────────────── */

    /* Selections arrive as a stream of selectionchange events — a drag, a
     * shift-arrow, a touch handle all speak through it — so the menu waits
     * for the stream to go quiet, and for the hand to lift, rather than
     * chasing every event under a drag still in flight. */
    let settleTimer = null;
    let pointerIsDown = false;
    function onSelectionSettled() {
        if (pointerIsDown) return; // the pointerup listener re-asks on release
        const sel = getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
            if (mode === 'draft') hideMenu();
            return;
        }
        const r = sel.getRangeAt(0);
        const span = selectionSpan(r);
        if (!span) { if (mode === 'draft') hideMenu(); return; }
        let { s, e } = span;
        while (s < e && /\s/.test(fullText[s])) s++;
        while (e > s && /\s/.test(fullText[e - 1])) e--;
        if (e <= s) { if (mode === 'draft') hideMenu(); return; }
        draft = { s, e };
        if (active) { active = null; render(); }
        showMenu('draft', r);
    }
    const askSettle = (ms) => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(onSelectionSettled, ms);
    };

    function onClick(ev) {
        if (menu.contains(ev.target)) return;
        const sel = getSelection();
        if (sel && !sel.isCollapsed) return; // a drag just ended; the selection path owns this
        const m = markAt(ev.clientX, ev.clientY);
        if (m) {
            draft = null;
            active = m;
            render();
            showMenu('mark', rangeFor(m));
        } else if (mode) {
            hideMenu();
        }
    }

    function boot() {
        layers = [
            document.querySelector('.s1 .textlayer'),
            document.querySelector('.s2 .textlayer'),
        ];
        if (layers.some((l) => !l) || !window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
        buildMenu();

        /* The layers are empty until the PDF arrives, and laid again on
         * every resize; the observer catches both and re-aims the index.
         * The catcher div's travels during a selection fire this too, but
         * reindex sees the same text nodes and puts the walk down. */
        const observer = new MutationObserver(() => askReindex());
        for (const layer of layers) observer.observe(layer, { childList: true, subtree: true });
        let reindexTimer = null;
        const askReindex = () => {
            clearTimeout(reindexTimer);
            reindexTimer = setTimeout(reindex, 120);
        };
        reindex();

        document.addEventListener('selectionchange', () => askSettle(150));
        addEventListener('pointerdown', (ev) => {
            pointerIsDown = true;
            /* Any press outside the menu takes it down — a pan, a drag, a
             * deal all move the paper out from under it. A press on a mark
             * brings it straight back through the click. */
            if (menuOpen() && !menu.contains(ev.target)) hideMenu();
        });
        addEventListener('pointerup', () => { pointerIsDown = false; askSettle(60); });
        document.addEventListener('click', onClick);
        /* The paper moves under these; the menu must not hang where it was. */
        addEventListener('wheel', () => { if (menuOpen()) hideMenu(); }, { passive: true });
        addEventListener('gesturechange', () => { if (menuOpen()) hideMenu(); });
        addEventListener('resize', () => { if (menuOpen()) hideMenu(); });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
                /* The top rung of the escape ladder, the rest of which is in
                 * index.html. The menu and the sweep that raised it are one
                 * thing to a reader — a passage they are holding — so the
                 * press takes both or neither, and says which: a press
                 * marked spent is one the glass and the deal below leave
                 * alone, and that is the whole of what keeps a single
                 * Escape from putting a passage down and the magnification
                 * with it. Nothing held, nothing swept, and the press falls
                 * straight through to them untouched. */
                const sel = getSelection();
                const swept = !!(sel && sel.rangeCount && !sel.isCollapsed);
                if (menuOpen() || swept) {
                    hideMenu();
                    if (swept) sel.removeAllRanges();
                    ev.preventDefault();
                }
                return;
            }
            if (!ev.metaKey && !ev.ctrlKey && !ev.altKey &&
                ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(ev.key)) {
                if (menuOpen()) hideMenu();
            }
        });
        /* Pasting a friend's link over this page's address is a navigation
         * only the fragment sees. */
        addEventListener('hashchange', applyHash);

        /* The bench's window in: read-only views plus the same mutation
         * paths the buttons use. */
        window.__hl = Object.freeze({
            marks: () => marks.map((m) => ({ s: m.s, e: m.e, c: m.c })),
            text: () => fullText,
            seam: () => base[1],
            encode,
            decode,
            add: (s, e, c) => { const m = addMark(s, e, c); render(); sync(); return m && { s: m.s, e: m.e, c: m.c }; },
            clear: () => { marks = []; hideMenu(); render(); sync(); },
            menu: () => ({ open: menuOpen(), mode }),
            rect: (i) => {
                const m = marks[i];
                if (!m) return null;
                const r = rangeFor(m).getClientRects()[0];
                return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
            },
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
