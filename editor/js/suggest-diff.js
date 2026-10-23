/* ============================================
   SUGGEST-DIFF — word-level diff for track-changes
   Pure module: no DOM, no globals beyond the IIFE.
   Produces accept/reject-able "hunks" describing the
   change from a clean baseline to a working copy.
   ============================================ */

const SuggestDiff = (() => {
    'use strict';

    // Hard ceiling on the size of the *changed region* (the middle left after the
    // common prefix/suffix are stripped — see diffToHunks). Above this many tokens
    // on the smaller side we skip diffing and emit one region-scoped replace hunk,
    // bounding the cost of a pathological whole-node rewrite. A localized edit in a
    // huge node trims down to a tiny region and never approaches this.
    const MAX_TOKENS = 50000;
    // Myers' algorithm runs in O((N+M)*D) where D is the edit distance, so its cost
    // scales with how MUCH changed, not document size — a few edited words in a long
    // chapter resolve in a handful of steps. If D would exceed this (a large-scale
    // rewrite), we stop and fall back to a region-scoped replace.
    const MAX_DIFF = 1500;
    // Characters of surrounding context stored with each hunk for drift recovery.
    const CTX = 24;

    function isString(v) { return typeof v === 'string'; }

    // Split a string into a gap-free sequence of tokens: whitespace runs, word
    // runs, and punctuation/other runs. Every character of `str` belongs to
    // exactly one token, so the tokens can be reconstructed losslessly. Each
    // token records its start offset in the original string.
    function tokenize(str) {
        if (!isString(str)) throw new TypeError('tokenize: expected string, got ' + typeof str);
        const toks = [];
        const re = /(\s+|[^\s\w]+|\w+)/g;
        let m;
        let lastEnd = 0;
        while ((m = re.exec(str)) !== null) {
            // Defensive: the three alternatives cover every character, so there
            // should never be a gap. If one ever appears, capture it verbatim so
            // reconstruction stays exact rather than silently dropping text.
            if (m.index > lastEnd) {
                toks.push({ text: str.slice(lastEnd, m.index), start: lastEnd });
            }
            toks.push({ text: m[0], start: m.index });
            lastEnd = m.index + m[0].length;
            if (m[0].length === 0) { re.lastIndex++; }  // guard against zero-width loops
        }
        if (lastEnd < str.length) {
            toks.push({ text: str.slice(lastEnd), start: lastEnd });
        }
        return toks;
    }

    // Myers' O(ND) shortest-edit-script over token TEXT (Myers, 1986). Returns an
    // ordered op list ('equal' | 'del' | 'ins'; 'del' carries the old token, 'ins'
    // the new one), or null if the edit distance would exceed `maxD` (caller then
    // uses the region-scoped fallback). Cost is O((N+M)*D), so a small edit in a
    // large region is cheap; memory is the per-d frontier snapshots, bounded by maxD.
    function myersEditScript(a, b, maxD) {
        const N = a.length, M = b.length;
        if (N === 0) return b.map(t => ({ op: 'ins', b: t }));
        if (M === 0) return a.map(t => ({ op: 'del', a: t }));

        const cap = Math.min(maxD, N + M);
        const offset = cap;
        const V = new Int32Array(2 * cap + 1);
        const trace = [];
        let foundD = -1;

        outer:
        for (let d = 0; d <= cap; d++) {
            trace.push(V.slice());                 // frontier before this step (for backtrack)
            for (let k = -d; k <= d; k += 2) {
                const idx = offset + k;
                let x;
                if (k === -d || (k !== d && V[idx - 1] < V[idx + 1])) {
                    x = V[idx + 1];                // move down  (insert b token)
                } else {
                    x = V[idx - 1] + 1;            // move right (delete a token)
                }
                let y = x - k;
                while (x < N && y < M && a[x].text === b[y].text) { x++; y++; }  // snake
                V[idx] = x;
                if (x >= N && y >= M) { foundD = d; break outer; }
            }
        }
        if (foundD < 0) return null;               // distance exceeded the cap

        // Backtrack the stored frontiers into an op list (built end-to-start).
        const rev = [];
        let x = N, y = M;
        for (let d = foundD; d >= 0; d--) {
            const Vd = trace[d];
            const k = x - y;
            let prevK;
            if (k === -d || (k !== d && Vd[offset + k - 1] < Vd[offset + k + 1])) {
                prevK = k + 1;                     // predecessor came via a down move
            } else {
                prevK = k - 1;                     // predecessor came via a right move
            }
            const prevX = Vd[offset + prevK];
            const prevY = prevX - prevK;
            while (x > prevX && y > prevY) {       // unwind the snake (equal tokens)
                rev.push({ op: 'equal', a: a[x - 1], b: b[y - 1] });
                x--; y--;
            }
            if (d > 0) {
                if (x === prevX) rev.push({ op: 'ins', b: b[prevY] });  // down move
                else rev.push({ op: 'del', a: a[prevX] });              // right move
            }
            x = prevX; y = prevY;
        }
        rev.reverse();
        return rev;
    }

    function sliceCtx(str, anchor, beforeLen) {
        const cb = str.slice(Math.max(0, anchor - CTX), anchor);
        const ca = str.slice(anchor + beforeLen, anchor + beforeLen + CTX);
        return { ctxBefore: cb, ctxAfter: ca };
    }

    function classify(before, after) {
        if (before && after) return 'replace';
        if (after) return 'insert';
        return 'delete';
    }

    // Number of leading tokens whose text is identical in both sequences.
    function commonPrefixLen(a, b) {
        const n = Math.min(a.length, b.length);
        let i = 0;
        while (i < n && a[i].text === b[i].text) i++;
        return i;
    }

    // Number of trailing tokens whose text is identical, not crossing into the
    // already-claimed prefix region (cap = remaining tokens on the shorter side).
    function commonSuffixLen(a, b, cap) {
        let i = 0;
        while (i < cap &&
               a[a.length - 1 - i].text === b[b.length - 1 - i].text) i++;
        return i;
    }

    // Build hunks from old/new strings. Each hunk:
    //   { id, type, anchor, before, after, ctxBefore, ctxAfter }
    // Hunks are sorted by anchor ascending and are non-overlapping.
    function diffToHunks(oldStr, newStr) {
        if (!isString(oldStr)) throw new TypeError('diffToHunks: oldStr must be a string');
        if (!isString(newStr)) throw new TypeError('diffToHunks: newStr must be a string');
        if (oldStr === newStr) return [];

        const aFull = tokenize(oldStr);
        const bFull = tokenize(newStr);

        // Strip the matching head and tail so the expensive LCS only ever sees the
        // region that actually changed. For a one-word edit in a long chapter this
        // collapses thousands of tokens down to a handful, and — crucially — the
        // resulting hunk is scoped to the edit, never the whole node. Tokens carry
        // absolute offsets, so slicing the arrays leaves every anchor correct.
        const p = commonPrefixLen(aFull, bFull);
        const s = commonSuffixLen(aFull, bFull, Math.min(aFull.length, bFull.length) - p);
        const a = aFull.slice(p, aFull.length - s);
        const b = bFull.slice(p, bFull.length - s);

        // Offset where the common suffix begins in oldStr — the landing point for a
        // pure insertion that sits at the end of the changed middle (the following
        // equal token now lives in the trimmed-away suffix, not in `ops`).
        const suffixStart = s > 0 ? aFull[aFull.length - s].start : oldStr.length;

        // One replace hunk spanning exactly the changed region — used when the region
        // is too large to diff or the edit distance exceeds the Myers cap. Scoped to
        // the region (between common prefix and suffix), never the whole node.
        function regionFallback(why) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('SuggestDiff: ' + why + '; emitting a single region-scoped replace hunk.');
            }
            const before = a.map(t => t.text).join('');
            const after = b.map(t => t.text).join('');
            const anchor = a.length ? a[0].start : suffixStart;
            const ctx = sliceCtx(oldStr, anchor, before.length);
            return [{
                id: 'sg-0-' + anchor, type: classify(before, after), anchor: anchor,
                before: before, after: after, ctxBefore: ctx.ctxBefore, ctxAfter: ctx.ctxAfter
            }];
        }

        if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
            return regionFallback('changed region exceeds ' + MAX_TOKENS + ' tokens');
        }

        const ops = myersEditScript(a, b, MAX_DIFF);
        if (ops === null) {
            return regionFallback('edit distance exceeds ' + MAX_DIFF);
        }
        const hunks = [];
        let k = 0;
        let counter = 0;
        while (k < ops.length) {
            if (ops[k].op === 'equal') { k++; continue; }
            // Collect a maximal run of non-equal ops.
            const delToks = [];
            const insToks = [];
            while (k < ops.length && ops[k].op !== 'equal') {
                if (ops[k].op === 'del') delToks.push(ops[k].a);
                else insToks.push(ops[k].b);
                k++;
            }
            const before = delToks.map(t => t.text).join('');
            const after = insToks.map(t => t.text).join('');
            if (before === '' && after === '') continue;  // nothing real to record

            // Anchor: start offset of the first deleted token. For a pure insert
            // (no deletions) anchor at the offset of the following equal token in
            // old, or — when the insert is the last thing in the changed middle —
            // at the start of the common suffix.
            let anchor;
            if (delToks.length) {
                anchor = delToks[0].start;
            } else {
                const nextEqual = ops[k];  // first equal op after the run (if any)
                anchor = (nextEqual && nextEqual.a) ? nextEqual.a.start : suffixStart;
            }
            const ctx = sliceCtx(oldStr, anchor, before.length);
            hunks.push({
                id: 'sg-' + (counter++) + '-' + anchor,
                type: classify(before, after),
                anchor: anchor,
                before: before,
                after: after,
                ctxBefore: ctx.ctxBefore,
                ctxAfter: ctx.ctxAfter
            });
        }

        // Guarantee sorted, disjoint output (the edit script yields this already,
        // but assert it so a future change can't silently break accept ordering).
        hunks.sort((x, y) => x.anchor - y.anchor);
        for (let n = 1; n < hunks.length; n++) {
            const prev = hunks[n - 1];
            if (hunks[n].anchor < prev.anchor + prev.before.length) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('SuggestDiff: overlapping hunks detected; review may be imperfect.');
                }
                break;
            }
        }
        return hunks;
    }

    function indexOfUnique(haystack, needle) {
        if (needle === '') return -1;
        const first = haystack.indexOf(needle);
        if (first === -1) return -1;
        if (haystack.indexOf(needle, first + 1) !== -1) return -2;  // ambiguous
        return first;
    }

    // Re-anchor hunks against a (possibly changed) `content` string. Mutates each
    // hunk's `anchor` in place when relocated, and sets `relocated`/`orphaned`
    // flags. Never drops a hunk. Returns the same array for chaining.
    function validateHunks(content, hunks) {
        if (!isString(content)) throw new TypeError('validateHunks: content must be a string');
        if (!Array.isArray(hunks)) throw new TypeError('validateHunks: hunks must be an array');
        for (const h of hunks) {
            if (!h || typeof h !== 'object') continue;
            h.relocated = false;
            h.orphaned = false;
            const before = isString(h.before) ? h.before : '';
            const ctxBefore = isString(h.ctxBefore) ? h.ctxBefore : '';
            const ctxAfter = isString(h.ctxAfter) ? h.ctxAfter : '';

            // Fast path: the original substring still sits at the stored anchor.
            if (before !== '') {
                if (content.substr(h.anchor, before.length) === before) continue;
            } else {
                // Pure insert: validate by the surrounding context at the anchor.
                const left = content.slice(Math.max(0, h.anchor - ctxBefore.length), h.anchor);
                if (left === ctxBefore) continue;
            }

            // Context fallback: unique occurrence of ctxBefore + before + ctxAfter.
            const full = ctxBefore + before + ctxAfter;
            let idx = indexOfUnique(content, full);
            if (idx >= 0) { h.anchor = idx + ctxBefore.length; h.relocated = true; continue; }

            // Loosened fallback: unique occurrence of `before` alone (replace/delete).
            if (before !== '') {
                idx = indexOfUnique(content, before);
                if (idx >= 0) { h.anchor = idx; h.relocated = true; continue; }
            }

            h.orphaned = true;
        }
        return hunks;
    }

    // Apply one hunk to `content`, returning the new string. Validates that the
    // hunk's `before` is actually present at its anchor (or relocatable) first;
    // throws on an orphaned/invalid hunk rather than corrupting content.
    function applyHunk(content, hunk) {
        if (!isString(content)) throw new TypeError('applyHunk: content must be a string');
        if (!hunk || typeof hunk !== 'object') throw new TypeError('applyHunk: hunk must be an object');
        const before = isString(hunk.before) ? hunk.before : '';
        const after = isString(hunk.after) ? hunk.after : '';
        validateHunks(content, [hunk]);
        if (hunk.orphaned) {
            throw new Error('applyHunk: hunk could not be located in content (orphaned).');
        }
        const a = hunk.anchor;
        if (before !== '' && content.substr(a, before.length) !== before) {
            throw new Error('applyHunk: anchor mismatch after validation.');
        }
        return content.slice(0, a) + after + content.slice(a + before.length);
    }

    // Apply all hunks. Applies right-to-left by anchor so earlier offsets stay
    // valid. Returns the rebuilt string.
    function applyAllHunks(content, hunks) {
        if (!isString(content)) throw new TypeError('applyAllHunks: content must be a string');
        if (!Array.isArray(hunks)) throw new TypeError('applyAllHunks: hunks must be an array');
        const ordered = hunks.slice().sort((x, y) => y.anchor - x.anchor);
        let out = content;
        for (const h of ordered) out = applyHunk(out, h);
        return out;
    }

    return { tokenize, diffToHunks, validateHunks, applyHunk, applyAllHunks, MAX_TOKENS };
})();

// Allow use from a non-browser test harness (Node) without affecting the editor.
if (typeof module !== 'undefined' && module.exports) { module.exports = SuggestDiff; }
