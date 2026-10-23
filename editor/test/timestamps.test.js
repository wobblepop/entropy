/* Per-node timestamp tests for editor/js/state.js. DOM-free (state.js touches no DOM in
 * the paths exercised here). Run with:  node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadEditorState } = require('./helpers/load-editor');

function nextTick() { const t = Date.now(); while (Date.now() === t) { /* spin <1ms */ } }

test('newFile seeds created and modified on the intro node', () => {
    const S = loadEditorState();
    S.newFile();
    const intro = S.getNode('intro');
    assert.ok(intro.created && intro.modified, 'intro has created+modified');
    assert.equal(intro.created, intro.modified, 'seed created == modified');
});

test('addNode sets created and modified', () => {
    const S = loadEditorState();
    S.newFile();
    const n = S.addNode('chap1', 'Chapter 1');
    assert.ok(n.created && n.modified);
    assert.equal(n.created, n.modified);
});

test('updateNode bumps modified, preserves created', () => {
    const S = loadEditorState();
    S.newFile();
    const n = S.addNode('chap1', 'Chapter 1');
    const created0 = n.created, modified0 = n.modified;
    nextTick();
    S.updateNode('chap1', { title: 'Chapter One' });
    const after = S.getNode('chap1');
    assert.equal(after.created, created0, 'created unchanged');
    assert.ok(after.modified >= modified0, 'modified refreshed');
    assert.equal(after.title, 'Chapter One', 'change applied');
});

test('duplicateNode gives the copy fresh stamps (not the source modified)', () => {
    const S = loadEditorState();
    S.newFile();
    S.addNode('chap1', 'Chapter 1');
    S.updateNode('chap1', { content: 'body' });
    const srcMod = S.getNode('chap1').modified;
    nextTick();
    const newId = S.duplicateNode('chap1');
    const copy = S.getNode(newId);
    assert.ok(copy.created && copy.modified);
    assert.equal(copy.created, copy.modified, 'duplicate created == modified');
    assert.ok(copy.created >= srcMod, 'duplicate stamped at/after source');
});

test('legacy node without created gets modified on first edit; created stays absent', () => {
    const S = loadEditorState();
    S.loadContent({ meta: { title: 'L', version: '1' }, root: 'intro',
        nodes: { intro: { id: 'intro', title: 'A', content: '' } } }, 'legacy.json');
    assert.equal(S.getNode('intro').modified, undefined, 'legacy starts with no modified');
    S.updateNode('intro', { summary: 'x' });
    assert.ok(S.getNode('intro').modified, 'legacy gets stamped on edit');
    assert.equal(S.getNode('intro').created, undefined, 'created not backfilled for legacy');
});

test('merely reading the data does not mutate timestamps', () => {
    const S = loadEditorState();
    S.newFile();
    const before = S.getNode('intro').modified;
    S.getNode('intro'); S.getAllNodeIds(); S.getWordCount();
    assert.equal(S.getNode('intro').modified, before, 'no timestamp drift from reads');
});
