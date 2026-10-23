/* Tests for editor/js/pdf-export.js — the editor's "Save as PDF" picker helpers.
 *
 * The picker duplicates the reader's section walks (computeDepths, subtreeIds,
 * structureLabels, linearOrder, expandSelection) because the editor bundle cannot
 * reach inside the viewer's IIFE. These tests pin the copies to the originals in
 * explainer/js/print-chapter.js on synthetic books AND every book JSON in the repo,
 * so a change to one side without the other fails here. Also covers the file-name
 * rules (cross-checked too), the service error message, and the summary line. Pure
 * functions; no DOM required.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPdfExportInternals, loadPrintChapterInternals, loadEditorState, findBooks } = require('./helpers/load-editor');

const E = loadPdfExportInternals();
const P = loadPrintChapterInternals();

const BOOK = {
    meta: {
        title: 'Book: One',
        structure: {
            parts: [{ title: 'Part A', nodes: ['a', 'a1'] }, { title: 'Part B', nodes: ['b'] }],
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

const JUNK = [null, undefined, {}, { nodes: null }, { nodes: 'x', root: 'r' }, { nodes: {}, root: 'missing' }, { meta: 'junk', nodes: {} }];

// Every way the picker can combine picks on a small book.
function allPicks(data) {
    const ids = Object.keys((data && data.nodes) || {});
    const picks = [[], ['nope'], ids, ids.slice().reverse()];
    for (let i = 0; i < ids.length; i++) {
        picks.push([ids[i]]);
        for (let j = i + 1; j < ids.length; j++) picks.push([ids[j], ids[i]]);
    }
    return picks;
}

function assertSameWalks(data, label) {
    assert.deepEqual(E.computeDepths(data), P.computeDepths(data), `${label}: computeDepths`);
    assert.deepEqual(E.structureLabels(data), P.structureLabels(data), `${label}: structureLabels`);
    assert.deepEqual(E.linearOrder(data), P.linearOrder(data), `${label}: linearOrder`);
    for (const id of Object.keys((data && data.nodes) || {}).concat(['nope'])) {
        assert.deepEqual(E.subtreeIds(data, id), P.subtreeIds(data, id), `${label}: subtreeIds(${id})`);
    }
    for (const pick of allPicks(data)) {
        for (const kids of [true, false]) {
            assert.deepEqual(E.expandSelection(data, pick, kids), P.expandSelection(data, pick, kids),
                `${label}: expandSelection(${JSON.stringify(pick)}, ${kids})`);
        }
    }
}

test('pdf-export: section walks match the reader on synthetic books (cycles, shared children, orphans)', () => {
    assertSameWalks(BOOK, 'BOOK');
    assertSameWalks(PLAIN, 'PLAIN');
});

test('pdf-export: section walks match the reader on junk input', () => {
    for (const j of JUNK) {
        assert.deepEqual(E.computeDepths(j), P.computeDepths(j));
        assert.deepEqual(E.structureLabels(j), P.structureLabels(j));
        assert.deepEqual(E.linearOrder(j), P.linearOrder(j));
        assert.deepEqual(E.subtreeIds(j, 'r'), P.subtreeIds(j, 'r'));
        assert.deepEqual(E.expandSelection(j, ['r'], true), P.expandSelection(j, ['r'], true));
        assert.deepEqual(E.expandSelection(PLAIN, j, true), P.expandSelection(PLAIN, j, true));
    }
});

test('pdf-export: linearOrder matches EditorState.getLinearOrder (what the node tree shows)', () => {
    for (const data of [BOOK, PLAIN]) {
        const S = loadEditorState();
        S.loadContent(JSON.parse(JSON.stringify(data)), 'x.json');
        assert.deepEqual(E.linearOrder(data), S.getLinearOrder());
    }
});

test('pdf-export: expandSelection reads in tree order and honours the sub-sections switch', () => {
    assert.deepEqual(E.expandSelection(PLAIN, ['c3', 'c1'], true), ['c1', 'c1a', 'c3']);
    assert.deepEqual(E.expandSelection(PLAIN, ['c3', 'c1'], false), ['c1', 'c3']);
    assert.deepEqual(E.expandSelection(PLAIN, ['c1a', 'c1'], true), ['c1', 'c1a']);
    assert.deepEqual(E.expandSelection(PLAIN, ['zzz', 7], true), []);
});

test('pdf-export: summaryText reports how many sections will print', () => {
    assert.equal(E.summaryText(0), 'No sections ticked');
    assert.equal(E.summaryText(1), '1 section will print');
    assert.equal(E.summaryText(7), '7 sections will print in reading order');
    assert.equal(E.summaryText(NaN), 'No sections ticked');
    assert.equal(E.summaryText(-1), 'No sections ticked');
    assert.equal(E.summaryText('2'), 'No sections ticked');
});

test('pdf-export: file names follow the reader rules (pdfFileTitle, topLevelChosen, pdfTitleForSelection)', () => {
    for (const args of [['Book: One', 'Chapter 2', 'A/B?'], ['Book', '', 'Sec'], ['', '', ''], [null, undefined, '  x  '], ['a'.repeat(300), '', '']]) {
        assert.equal(E.pdfFileTitle(...args), P.pdfFileTitle(...args));
    }
    for (const data of [BOOK, PLAIN]) {
        for (const pick of allPicks(data)) {
            assert.deepEqual(E.topLevelChosen(data, pick), P.topLevelChosen(data, pick), `topLevelChosen ${JSON.stringify(pick)}`);
            assert.equal(E.titleForSelection(data, pick), P.pdfTitleForSelection(data, pick, false), `title ${JSON.stringify(pick)}`);
        }
    }
    assert.equal(E.titleForSelection(PLAIN, ['c1', 'c1a']), 'Plain - Chapter 1 - One');
    assert.equal(E.titleForSelection(PLAIN, ['c3', 'c1']), 'Plain - Chapter 1 to Three');
    assert.equal(E.titleForSelection(PLAIN, ['r', 'c1', 'c1a', 'c2', 'c3']), 'Plain');
    assert.equal(E.titleForSelection(null, ['x']), 'section');
});

test('pdf-export: errorFromResponse prefers the service JSON error, then the body text, then the status', () => {
    assert.equal(E.errorFromResponse(400, '{"error":"unknown section id(s): zz"}'), 'PDF service: unknown section id(s): zz');
    assert.equal(E.errorFromResponse(500, 'boom'), 'PDF service: boom');
    assert.equal(E.errorFromResponse(502, ''), 'PDF service: HTTP 502');
    assert.equal(E.errorFromResponse(500, '{"nope":1}'), 'PDF service: {"nope":1}');
    assert.equal(E.errorFromResponse(500, null), 'PDF service: HTTP 500');
});

test('pdf-export: serviceUrl falls back to the loopback default without a browser store', () => {
    assert.equal(E.serviceUrl(), 'http://127.0.0.1:8644');
});

// Corpus: the editor's walks must agree with the reader's on every real book too.
for (const { name, data } of findBooks()) {
    test(`pdf-export corpus: ${name} — walks match the reader`, () => {
        assert.deepEqual(E.computeDepths(data), P.computeDepths(data));
        assert.deepEqual(E.structureLabels(data), P.structureLabels(data));
        const order = E.linearOrder(data);
        assert.deepEqual(order, P.linearOrder(data));
        assert.deepEqual(new Set(order), new Set(Object.keys(data.nodes)), 'every node appears once');
        const chapters = order.filter(id => (E.computeDepths(data)[id] || 0) === 1);
        const some = [order[0], chapters[0], chapters[chapters.length - 1]].filter(Boolean);
        for (const kids of [true, false]) {
            assert.deepEqual(E.expandSelection(data, some, kids), P.expandSelection(data, some, kids));
            assert.deepEqual(E.expandSelection(data, order.slice().reverse(), kids), order);
        }
    });
}
