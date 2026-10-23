/* Reader tests for explainer/js/print-chapter.js — the "Save as PDF" helpers that decide
 * WHICH sections go into a chapter PDF (subtree in reading order), how chapters are
 * labelled from meta.structure, the suggested file name, and the #pdf deep link.
 * These are pure functions, so no DOM is required.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPrintChapterInternals, findBooks } = require('./helpers/load-editor');

const P = loadPrintChapterInternals();

const BOOK = {
    meta: {
        title: 'Book: One',
        author: 'A. Author',
        structure: {
            frontmatter: ['intro'],
            parts: [
                { title: 'Part A', nodes: ['a', 'a1'] },
                { title: 'Part B', nodes: ['b'] },
            ],
            epilogues: [{ title: 'After', node: 'ep' }],
        },
    },
    root: 'intro',
    nodes: {
        intro: { id: 'intro', title: 'Intro', content: '', children: ['a', 'b', 'ep'] },
        a:     { id: 'a', title: 'A', content: 'Body A', children: ['a1'] },
        a1:    { id: 'a1', title: 'A.1', content: 'Body A1', children: ['a1x'] },
        a1x:   { id: 'a1x', title: 'A.1.x', content: '', children: [] },
        b:     { id: 'b', title: 'B', content: '', children: ['a1'] },   // shared child
        ep:    { id: 'ep', title: 'Ep', content: '', children: ['intro'] }, // cycle back to root
        orphan:{ id: 'orphan', title: 'Orphan', content: '', children: [] },
    },
};

test('print: computeDepths follows the tree from the root; orphans are absent', () => {
    const d = P.computeDepths(BOOK);
    assert.equal(d.intro, 0);
    assert.equal(d.a, 1);
    assert.equal(d.a1, 2);
    assert.equal(d.a1x, 3);
    assert.equal(d.ep, 1);
    assert.equal(d.orphan, undefined);
});

test('print: computeDepths tolerates junk input', () => {
    assert.deepEqual(P.computeDepths(null), {});
    assert.deepEqual(P.computeDepths({ nodes: null, root: 'x' }), {});
    assert.deepEqual(P.computeDepths({ nodes: {}, root: 'missing' }), {});
});

test('print: subtreeIds is the node then its descendants in reading order', () => {
    assert.deepEqual(P.subtreeIds(BOOK, 'a'), ['a', 'a1', 'a1x']);
    assert.deepEqual(P.subtreeIds(BOOK, 'a1x'), ['a1x']);
});

test('print: subtreeIds survives cycles and shared children, and rejects unknown roots', () => {
    // ep -> intro -> (a, b, ep): the cycle must terminate and list each node once.
    const fromEp = P.subtreeIds(BOOK, 'ep');
    assert.equal(fromEp[0], 'ep');
    assert.equal(new Set(fromEp).size, fromEp.length);
    assert.ok(fromEp.includes('intro') && fromEp.includes('a1x'));
    assert.deepEqual(P.subtreeIds(BOOK, 'nope'), []);
    assert.deepEqual(P.subtreeIds(null, 'a'), []);
});

test('print: structureLabels numbers chapters across parts and marks epilogues', () => {
    assert.deepEqual(P.structureLabels(BOOK), { a: 'Chapter 1', a1: 'Chapter 2', b: 'Chapter 3', ep: 'Epilogue' });
    assert.deepEqual(P.structureLabels({ meta: {} }), {});
    assert.deepEqual(P.structureLabels({ meta: { structure: 'garbage' } }), {});
    assert.deepEqual(P.structureLabels({ meta: { structure: { parts: [{ nodes: [42, 'x'] }] } } }), { x: 'Chapter 2' });
});

test('print: pdfFileTitle joins book/label/section and strips file-name-hostile characters', () => {
    assert.equal(P.pdfFileTitle('Book: One', 'Chapter 2', 'A/B?'), 'Book- One - Chapter 2 - A-B-');
    assert.equal(P.pdfFileTitle('Book', '', 'Sec'), 'Book - Sec');
    assert.equal(P.pdfFileTitle('', '', ''), 'section');
    assert.equal(P.pdfFileTitle(null, undefined, '  x  '), 'x');
    assert.ok(P.pdfFileTitle('a'.repeat(300), '', '').length <= 120);
});

test('print: pdfIdFromHash distinguishes absent / bare / valued pdf params', () => {
    assert.equal(P.pdfIdFromHash(''), null);
    assert.equal(P.pdfIdFromHash(null), null);
    assert.equal(P.pdfIdFromHash('#foo'), null);
    assert.equal(P.pdfIdFromHash('#pdfx=1'), null);
    assert.equal(P.pdfIdFromHash('#pdf'), '');
    assert.equal(P.pdfIdFromHash('#pdf='), '');
    assert.equal(P.pdfIdFromHash('#pdf=intro'), 'intro');
    assert.equal(P.pdfIdFromHash('#x=1&pdf=a%20b&y=2'), 'a b');
    assert.equal(P.pdfIdFromHash('#pdf=%E0%A4%A'), '');   // malformed escape -> default selection
});

test('print: renderMediaForPrint prints images and turns playable media into link lines', () => {
    const img = P.renderMediaForPrint({ type: 'image', src: 'x.png', alt: 'An "alt"', caption: 'Cap <b>' });
    assert.match(img, /^<figure class="media-item"><img src="x.png" alt="An &quot;alt&quot;">/);
    assert.match(img, /<figcaption class="media-caption">Cap &lt;b&gt;<\/figcaption>/);
    assert.doesNotMatch(img, /loading=/);

    const vid = P.renderMediaForPrint({ type: 'video', src: 'https://example.com/v', caption: 'Clip' });
    assert.equal(vid, '<div class="print-media-link"><span class="mtype">Video</span><a href="https://example.com/v">Clip</a></div>');

    const local = P.renderMediaForPrint({ type: 'audio', src: 'local.mp3' });
    assert.equal(local, '<div class="print-media-link"><span class="mtype">Audio</span>local.mp3</div>');

    assert.equal(P.renderMediaForPrint({ type: 'image' }), '');
    assert.equal(P.renderMediaForPrint({ type: 'hologram', src: 'x' }), '');
    assert.equal(P.renderMediaForPrint(null), '');
});

test('print: renderSection namespaces footnote anchors so they cannot collide with read-all mode', () => {
    const node = { id: 'n1', title: 'T <1>', summary: 'S', content: 'See [site](https://e.com) and note[^a].\n\n[^a]: Note text', tags: ['t'] };
    const html = P.renderSection(node, 1, 'Chapter 9');
    assert.match(html, /^<section class="print-node depth-1" data-node-id="n1" id="print-sec-n1">/);
    assert.match(html, /<div class="print-chapter-num">Chapter 9<\/div>/);
    assert.match(html, /<h2 class="print-node-title">T &lt;1&gt;<\/h2>/);
    assert.match(html, /id="fnref-pdf-n1-1"/);
    assert.match(html, /id="fn-pdf-n1-note-1"/);
    assert.doesNotMatch(html, /id="fn-n1-/);
});

test('print: relative depth is clamped to the 0..5 style range', () => {
    const node = { id: 'z', title: 'Z', content: '' };
    assert.match(P.renderSection(node, -3, ''), /depth-0/);
    assert.match(P.renderSection(node, 9, ''), /depth-5/);
});

// --- multi-section selection (printSections / the editor's picker) ---

// Acyclic fixture: the BOOK above deliberately loops ep -> intro, which makes
// "does one pick nest inside another" answers depend on the cycle.
const PLAIN = {
    meta: { title: 'Plain', structure: { parts: [{ nodes: ['c1', 'c2'] }] } },
    root: 'r',
    nodes: {
        r:   { id: 'r', title: 'Root', content: '', children: ['c1', 'c2', 'c3'] },
        c1:  { id: 'c1', title: 'One', content: '', children: ['c1a'] },
        c1a: { id: 'c1a', title: 'One A', content: '', children: [] },
        c2:  { id: 'c2', title: 'Two', content: '', children: [] },
        c3:  { id: 'c3', title: 'Three', content: '', children: [] },
    },
};

test('print: linearOrder is the root subtree in reading order, then orphans', () => {
    assert.deepEqual(P.linearOrder(BOOK), ['intro', 'a', 'a1', 'a1x', 'b', 'ep', 'orphan']);
    assert.deepEqual(P.linearOrder(PLAIN), ['r', 'c1', 'c1a', 'c2', 'c3']);
    assert.deepEqual(P.linearOrder(null), []);
    assert.deepEqual(P.linearOrder({ nodes: 'x' }), []);
    assert.deepEqual(P.linearOrder({ nodes: {}, root: 'missing' }), []);
});

test('print: expandSelection follows reading order regardless of pick order and de-duplicates', () => {
    assert.deepEqual(P.expandSelection(PLAIN, ['c3', 'c1'], false), ['c1', 'c3']);
    assert.deepEqual(P.expandSelection(PLAIN, ['c3', 'c1'], true), ['c1', 'c1a', 'c3']);
    assert.deepEqual(P.expandSelection(PLAIN, ['c1a', 'c1', 'c1'], true), ['c1', 'c1a']);
    // shared child a1 (under both a and b) is listed once
    assert.deepEqual(P.expandSelection(BOOK, ['b', 'a'], true), ['a', 'a1', 'a1x', 'b']);
    assert.deepEqual(P.expandSelection(BOOK, ['orphan', 'intro'], false), ['intro', 'orphan']);
});

test('print: expandSelection drops unknown ids and rejects junk input', () => {
    assert.deepEqual(P.expandSelection(PLAIN, ['nope', 42, null, 'c2'], true), ['c2']);
    assert.deepEqual(P.expandSelection(PLAIN, ['nope'], true), []);
    assert.deepEqual(P.expandSelection(PLAIN, 'c2', true), []);
    assert.deepEqual(P.expandSelection(PLAIN, [], true), []);
    assert.deepEqual(P.expandSelection(null, ['c2'], true), []);
    assert.deepEqual(P.expandSelection({ nodes: null }, ['c2'], true), []);
});

test('print: topLevelChosen keeps only the picks not nested inside another pick', () => {
    assert.deepEqual(P.topLevelChosen(PLAIN, ['c1a', 'c3', 'c1']), ['c1', 'c3']);
    assert.deepEqual(P.topLevelChosen(PLAIN, ['c2', 'c1']), ['c1', 'c2']);
    assert.deepEqual(P.topLevelChosen(PLAIN, ['r', 'c2']), ['r']);
    assert.deepEqual(P.topLevelChosen(PLAIN, ['c1a']), ['c1a']);
    assert.deepEqual(P.topLevelChosen(PLAIN, ['zzz']), []);
    assert.deepEqual(P.topLevelChosen(null, ['c1']), []);
});

test('print: pdfTitleForSelection keeps the single-section name for one heading', () => {
    assert.equal(P.pdfTitleForSelection(BOOK, ['a'], true), 'Book- One - Chapter 1 - A');
    assert.equal(P.pdfTitleForSelection(BOOK, ['a1x'], false), 'Book- One - A.1.x');
    // one pick that happens to cover the whole book still uses the single form
    assert.equal(P.pdfTitleForSelection(PLAIN, ['r'], true), 'Plain - Root');
    // a heading plus its own sub-sections (ticked explicitly or expanded) is named by the heading
    assert.equal(P.pdfTitleForSelection(PLAIN, ['c1a', 'c1'], true), 'Plain - Chapter 1 - One');
    assert.equal(P.pdfTitleForSelection(PLAIN, ['c1a', 'c1'], false), 'Plain - Chapter 1 - One');
});

test('print: pdfTitleForSelection names a range first-to-last using chapter labels when present', () => {
    assert.equal(P.pdfTitleForSelection(PLAIN, ['c2', 'c1'], false), 'Plain - Chapter 1 to Chapter 2');
    assert.equal(P.pdfTitleForSelection(PLAIN, ['c3', 'c1'], true), 'Plain - Chapter 1 to Three');
    assert.equal(P.pdfTitleForSelection(PLAIN, ['c1a', 'c3'], false), 'Plain - One A to Three');
    assert.equal(P.pdfTitleForSelection(BOOK, ['b', 'a'], false), 'Book- One - Chapter 1 to Chapter 3');
});

test('print: pdfTitleForSelection uses just the book title when several picks cover every reachable node', () => {
    assert.equal(P.pdfTitleForSelection(PLAIN, ['r', 'c1', 'c1a', 'c2', 'c3'], false), 'Plain');
    assert.equal(P.pdfTitleForSelection(PLAIN, ['c1', 'c2', 'c3', 'r'], true), 'Plain');
    const untitled = { meta: {}, root: 'r', nodes: { r: { id: 'r', children: ['x'] }, x: { id: 'x' } } };
    assert.equal(P.pdfTitleForSelection(untitled, ['r', 'x'], false), 'book');
});

test('print: pdfTitleForSelection tolerates junk', () => {
    assert.equal(P.pdfTitleForSelection(PLAIN, [], true), 'Plain');
    assert.equal(P.pdfTitleForSelection(PLAIN, ['nope'], true), 'Plain');
    assert.equal(P.pdfTitleForSelection(null, ['x'], true), 'section');
    assert.equal(P.pdfTitleForSelection({ meta: 'junk', nodes: {} }, ['x'], true), 'section');
});

test('print: renderToc lists every printed section in order with anchors, labels, and relative depth', () => {
    const toc = P.renderToc(PLAIN, ['c1', 'c1a', 'c3']);
    assert.match(toc, /^<nav class="print-toc" aria-label="Contents"><h2 class="print-toc-title">Contents<\/h2><ul class="print-toc-list">/);
    assert.deepEqual(toc.match(/<li [^>]*>/g), ['<li class="depth-0">', '<li class="depth-1">', '<li class="depth-0">']);
    assert.match(toc, /<a href="#print-sec-c1"><span class="print-toc-num">Chapter 1<\/span><span class="print-toc-text">One<\/span><\/a>/);
    assert.match(toc, /<a href="#print-sec-c1a"><span class="print-toc-text">One A<\/span><\/a>/);
    assert.ok(toc.indexOf('print-sec-c1"') < toc.indexOf('print-sec-c1a"') && toc.indexOf('print-sec-c1a"') < toc.indexOf('print-sec-c3"'), 'print order');
    // section anchors match the contents links
    assert.match(P.renderSection(PLAIN.nodes.c1a, 1, ''), /id="print-sec-c1a"/);
});

test('print: renderToc is empty for a single section or junk, and escapes titles and ids', () => {
    assert.equal(P.renderToc(PLAIN, ['c1']), '');
    assert.equal(P.renderToc(PLAIN, ['c1', 'nope']), '');
    assert.equal(P.renderToc(PLAIN, 'c1'), '');
    assert.equal(P.renderToc(PLAIN, []), '');
    assert.equal(P.renderToc(null, ['c1', 'c2']), '');
    const weird = { root: 'x y', nodes: { 'x y': { id: 'x y', title: 'T <1>', children: ['z'] }, z: { id: 'z', title: 'Z & Co' } } };
    const toc = P.renderToc(weird, ['x y', 'z']);
    assert.match(toc, /href="#print-sec-x%20y"/);
    assert.match(toc, /T &lt;1&gt;/);
    assert.match(toc, /Z &amp; Co/);
});

// Corpus: for every book in the repo, printing the root with sub-sections must cover
// every node reachable from the root, and structure labels must line up 1:1 with the
// chapter nodes meta.structure lists.
for (const { name, data } of findBooks()) {
    test(`print corpus: ${name} — root subtree covers every reachable node`, () => {
        const depths = P.computeDepths(data);
        const sub = P.subtreeIds(data, data.root);
        assert.deepEqual(new Set(sub), new Set(Object.keys(depths)));
        assert.equal(sub[0], data.root);
        for (const id of sub) assert.ok(data.nodes[id], `unknown id ${id}`);
    });
    const s = data.meta && data.meta.structure;
    if (s && Array.isArray(s.parts)) {
        test(`print corpus: ${name} — one "Chapter N" label per structured chapter node`, () => {
            const labels = P.structureLabels(data);
            const chapterIds = s.parts.flatMap(p => (p && Array.isArray(p.nodes) ? p.nodes : []));
            assert.equal(Object.values(labels).filter(l => l.startsWith('Chapter ')).length, chapterIds.length);
            chapterIds.forEach((id, i) => assert.equal(labels[id], `Chapter ${i + 1}`));
            for (const id of chapterIds) assert.ok(data.nodes[id], `structure lists unknown node ${id}`);
        });
    }
}
