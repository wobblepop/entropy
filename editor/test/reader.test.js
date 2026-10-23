/* Reader tests for explainer/js/markdown.js (parseInline). These guard that the reader
 * shares the editor's emphasis dialect: flanking + a bold-italic (***) rule that produces
 * well-formed nesting. parseInline is a pure string function, so no DOM is required.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadReaderMarkdown } = require('./helpers/load-editor');

const MD = loadReaderMarkdown();

test('reader: ***both*** renders well-formed <strong><em>', () => {
    assert.equal(MD.parseInline('a ***both*** b'), 'a <strong><em>both</em></strong> b');
});
test('reader: tight emphasis renders', () => {
    assert.equal(MD.parseInline('a **bold** b'), 'a <strong>bold</strong> b');
    assert.equal(MD.parseInline('a *it* b'), 'a <em>it</em> b');
});
test('reader: space-flanked asterisks stay literal', () => {
    assert.equal(MD.parseInline('3 * 4 * 5'), '3 * 4 * 5');
    assert.doesNotMatch(MD.parseInline('pros * cons * costs'), /<(em|strong)/);
});
test('reader: mixed emphasis in one line nests correctly', () => {
    assert.equal(MD.parseInline('***a*** then **b** then *c*'),
        '<strong><em>a</em></strong> then <strong>b</strong> then <em>c</em>');
});
test('reader: <u> underline passes through as a real tag', () => {
    assert.equal(MD.parseInline('a <u>under</u> b'), 'a <u>under</u> b');
});
