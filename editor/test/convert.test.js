/* Round-trip / formatting tests for the editor's markdown <-> HTML conversion
 * (editor/js/editor.js). Run with:  node --test   (from editor/test, after `npm install`).
 *
 * These guard the fixes that made the conversion idempotent: emphasis flanking, empty-tag
 * cleanup, block-nesting backstops, span-style emphasis, and nested lists. If jsdom is not
 * installed the whole file skips with a clear message instead of failing.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadEditorInternals, findBooks, hasJsdom } = require('./helpers/load-editor');

const skip = hasJsdom ? false : 'jsdom not installed — run `npm install` in editor/test';
let INT;
before(() => { if (!skip) INT = loadEditorInternals(); });

// --- Fix 1: emphasis flanking ---
test('flanking: space-flanked asterisks stay literal (no spurious italics)', { skip }, () => {
    assert.doesNotMatch(INT.markdownToHtml('Volume is 3 * 4 * 5 units.'), /<(em|strong)/);
    assert.doesNotMatch(INT.markdownToHtml('Weigh pros * cons * costs.'), /<(em|strong)/);
});
test('flanking: tight emphasis still renders', { skip }, () => {
    assert.match(INT.markdownToHtml('a **bold** b'), /<strong>bold<\/strong>/);
    assert.match(INT.markdownToHtml('a *italic* b'), /<em>italic<\/em>/);
    assert.match(INT.markdownToHtml('a ***both*** b'), /<strong><em>both<\/em><\/strong>/);
    assert.match(INT.markdownToHtml('a ~~strike~~ b'), /<del>strike<\/del>/);
    assert.match(INT.markdownToHtml('x *a* *b* y'), /<em>a<\/em> <em>b<\/em>/);
});
test('flanking: space-flanked strikethrough stays literal', { skip }, () => {
    assert.doesNotMatch(INT.markdownToHtml('a ~~ no ~~ b'), /<del>/);
});

// --- Fix 2: empty inline-tag cleanup ---
test('empty/whitespace inline tags do not leak markers', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p>before<strong></strong>after</p>'), 'beforeafter');
    assert.equal(INT.htmlToMarkdown('<p><strong> </strong>text</p>'), 'text');
    assert.equal(INT.htmlToMarkdown('<p>a<em></em>b<code></code>c</p>'), 'abc');
});

// --- Fix 3: block-nesting backstops ---
test('block nesting cannot leak as quoted/heading markers', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<blockquote><h2>My Title</h2></blockquote>'), '> My Title');
    assert.equal(INT.htmlToMarkdown('<h2><blockquote>Quoted</blockquote></h2>'), '## Quoted');
});

// --- Fix 4: span-style emphasis honored ---
test('inline-styled spans serialize to emphasis', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p><span style="font-weight:bold">heavy</span> x</p>'), '**heavy** x');
    assert.equal(INT.htmlToMarkdown('<p><span style="font-style:italic">slant</span> x</p>'), '*slant* x');
    assert.equal(INT.htmlToMarkdown('<p><span style="text-decoration:line-through">gone</span> x</p>'), '~~gone~~ x');
});
test('non-emphasis spans and empty styled spans do not emit markers', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p><span style="font-weight:normal">plain</span> x</p>'), 'plain x');
    assert.equal(INT.htmlToMarkdown('<p><span style="font-weight:bold"> </span>x</p>'), 'x');
});

// --- Edge-space emphasis (execCommand often wraps an adjacent space) ---
test('emphasis markers hug text; edge whitespace stays outside and survives reparse', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p><strong>bold </strong>tail</p>'), '**bold** tail');
    assert.equal(INT.htmlToMarkdown('<p>x<em> italic</em>y</p>'), 'x *italic*y');
    assert.equal(INT.htmlToMarkdown('<p><strong> spaced both </strong>z</p>'), '**spaced both** z');
    // the produced markdown must re-parse back to the same emphasis (no silent drop)
    for (const html of ['<p><strong>bold </strong>tail</p>', '<p>x<em> italic </em>y</p>']) {
        const md = INT.htmlToMarkdown(html);
        assert.match(INT.markdownToHtml(md), /<(strong|em)>/, `edge-space emphasis lost for ${html}`);
    }
});

// --- Underline (<u> is the one inline HTML tag the format honors) ---
test('underline round-trips as <u> and renders', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p>a <u>under</u> b</p>'), 'a <u>under</u> b');
    assert.equal(INT.roundTrip('a <u>under</u> b'), 'a <u>under</u> b');
    assert.match(INT.markdownToHtml('a <u>under</u> b'), /<u>under<\/u>/);
    // emphasis nested inside underline still works and round-trips
    assert.equal(INT.roundTrip('a <u>**bold** in u</u> b'), 'a <u>**bold** in u</u> b');
    // a pasted span with text-decoration:underline serializes to <u>
    assert.equal(INT.htmlToMarkdown('<p><span style="text-decoration:underline">x</span> y</p>'), '<u>x</u> y');
});

// --- Fix 5: lists ---
test('flat lists round-trip byte-identical', { skip }, () => {
    const ul = '- one\n- two\n- three';
    const ol = '1. a\n2. b\n3. c';
    assert.equal(INT.roundTrip(ul), ul);
    assert.equal(INT.roundTrip(ol), ol);
});
test('nested lists round-trip', { skip }, () => {
    const nestU = '- one\n  - nested a\n  - nested b\n- two';
    const nestMix = '1. first\n  - sub a\n  - sub b\n2. second';
    assert.equal(INT.roundTrip(nestU), nestU);
    assert.equal(INT.roundTrip(nestMix), nestMix);
});

// --- Regression: link & footnote pills, headings, blockquotes, code, tables ---
test('links and authored footnotes round-trip', { skip }, () => {
    const link = 'See [the site](https://example.com) now.';
    assert.equal(INT.roundTrip(link), link);
    const fn = 'A claim.[^1]\n\n[^1]: the note';
    assert.equal(INT.roundTrip(fn), fn);
});
test('common blocks round-trip', { skip }, () => {
    for (const md of [
        '## Heading here',
        '> a quoted line',
        '```\ncode * not * italic\n```',
        'para one\n\npara two',
        'a **bold** and *italic* mix',
    ]) {
        assert.equal(INT.roundTrip(md), md, `round-trip changed: ${JSON.stringify(md)}`);
    }
});
test('code spans/blocks are not touched by flanking', { skip }, () => {
    assert.match(INT.markdownToHtml('use `a * b` here'), /<code>a \* b<\/code>/);
});

test('empty / degenerate headings drop instead of leaking a bare ##', { skip }, () => {
    // Left-over empty emphasis from editing must not serialize to "##" (which re-parses as
    // the literal text "##" and visibly breaks the heading apart).
    assert.equal(INT.htmlToMarkdown('<h2><strong><em></em></strong></h2>'), '');
    assert.equal(INT.htmlToMarkdown('<h2></h2>'), '');
    assert.equal(INT.htmlToMarkdown('<h3><strong><em>   </em></strong></h3>'), '');
    // headings with real content (text, emphasis, or links) are preserved
    assert.equal(INT.htmlToMarkdown('<h2>Real heading</h2>'), '## Real heading');
    assert.equal(INT.htmlToMarkdown('<h2><strong><em>Full-stitch</em></strong></h2>'), '## ***Full-stitch***');
    assert.equal(INT.htmlToMarkdown('<h2><a href="x">link</a></h2>'), '## [link](x)');
});

test('headings with bold serialize consistently and round-trip (b and strong alike)', { skip }, () => {
    // execCommand emits <b>; the round-trip re-renders as <strong>. Both must serialize
    // to the same markdown so the heading does not change on leave/return.
    assert.equal(INT.htmlToMarkdown('<h3><b>Full-stitch</b></h3>'), '### **Full-stitch**');
    assert.equal(INT.htmlToMarkdown('<h3><strong>Full-stitch</strong></h3>'), '### **Full-stitch**');
    assert.equal(INT.roundTrip('### **Full-stitch**'), '### **Full-stitch**');
    assert.equal(INT.roundTrip('### Half-stitch'), '### Half-stitch');
    assert.match(INT.markdownToHtml('### **Full-stitch**'), /<h3><strong>Full-stitch<\/strong><\/h3>/);
});

// --- Corpus: every node converges to a fixed point and never grows asterisks ---
test('corpus: all book nodes reach a fixed point, none gains asterisks', { skip }, () => {
    const books = findBooks();
    if (!books.length) { console.log('    (no book JSONs found — corpus check skipped)'); return; }
    let nodes = 0, never = 0, grew = 0, maxIters = 0;
    for (const { data } of books) {
        for (const id of Object.keys(data.nodes)) {
            const c = data.nodes[id].content || '';
            if (!c.trim()) continue;
            nodes++;
            const fp = INT.fixedPoint(c);
            if (fp.iterations < 0) never++; else maxIters = Math.max(maxIters, fp.iterations);
            const one = INT.roundTrip(c);
            if ((one.match(/\*/g) || []).length > (c.match(/\*/g) || []).length) grew++;
        }
    }
    console.log(`    corpus: ${nodes} nodes across ${books.length} books, max passes-to-fixed-point ${maxIters}`);
    assert.equal(never, 0, 'some nodes never reach a fixed point');
    assert.equal(grew, 0, 'some nodes gain asterisks on a single save');
});

// --- Font family: persisted as a whitelisted <span style="font-family: ..."> ---
test('font-family spans round-trip unchanged and render in the edit surface', { skip }, () => {
    const md = 'a <span style="font-family: Algerian">fancy</span> b';
    assert.equal(INT.roundTrip(md), md);
    assert.match(INT.markdownToHtml(md), /<span style="font-family: Algerian">fancy<\/span>/);
});
test('font-family serializes canonically: quotes stripped, names kept unquoted, order kept', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p><span style="font-family: Algerian;">x</span> y</p>'),
        '<span style="font-family: Algerian">x</span> y');
    // Chrome serializes multi-word families with quotes; they must not reach the markdown.
    assert.equal(INT.htmlToMarkdown('<p><span style=\'font-family: "Times New Roman", serif\'>x</span> y</p>'),
        '<span style="font-family: Times New Roman, serif">x</span> y');
    assert.equal(INT.htmlToMarkdown('<p><span style="color: #d64545; font-family: Garamond">x</span> y</p>'),
        '<span style="color: #d64545; font-family: Garamond">x</span> y');
});
test('font-family combines with emphasis and round-trips', { skip }, () => {
    const md = 'a <span style="font-family: Algerian">**bold** and *it*</span> b';
    assert.equal(INT.roundTrip(md), md);
    assert.match(INT.markdownToHtml(md),
        /<span style="font-family: Algerian"><strong>bold<\/strong> and <em>it<\/em><\/span>/);
});
test('unsafe or malformed font-family values are dropped and the text kept', { skip }, () => {
    for (const bad of ['url(x)', 'expression(alert(1))', 'Algerian, "', '"', '1abc', 'Alg$rian', 'a'.repeat(70)]) {
        const attr = bad.replace(/"/g, '&quot;');
        assert.equal(INT.htmlToMarkdown(`<p><span style="font-family: ${attr}">t</span> y</p>`), 't y',
            `should drop font-family ${JSON.stringify(bad)}`);
    }
    // hand-edited markdown with a rejected value stays literal text, never a live span
    assert.doesNotMatch(INT.markdownToHtml('<span style="font-family: url(x)">t</span>'), /<span style/);
    assert.match(INT.markdownToHtml('<span style="font-family: url(x)">t</span>'), /&lt;span style/);
});

// --- Leak fixes: markers never span a line break; footnote text may span lines ---
test('emphasis across a soft line break is wrapped per line and survives reload', { skip }, () => {
    // Ctrl+I over two Shift+Enter lines gives <em>a<br>b</em>; "*a\nb*" would re-read as
    // literal asterisks and the italics would be gone on the next load.
    assert.equal(INT.htmlToMarkdown('<p><em>line one<br>line two</em> tail</p>'), '*line one*\n*line two* tail');
    assert.equal(INT.htmlToMarkdown('<p><strong>a<br>b</strong></p>'), '**a**\n**b**');
    assert.equal(INT.htmlToMarkdown('<p><del>a<br>b</del></p>'), '~~a~~\n~~b~~');
    assert.equal(INT.htmlToMarkdown('<p><code>x<br>y</code></p>'), '`x`\n`y`');
    assert.equal(INT.htmlToMarkdown('<p><strong><em>a<br>b</em></strong></p>'), '***a***\n***b***');
    assert.equal(INT.htmlToMarkdown('<p><span style="font-style:italic">p<br>q</span></p>'), '*p*\n*q*');
    // blank lines stay blank; edge whitespace stays outside the markers on every line
    assert.equal(INT.htmlToMarkdown('<p><em>a<br><br>b</em></p>'), '*a*\n\n*b*');
    assert.equal(INT.htmlToMarkdown('<p><em>a <br>b</em></p>'), '*a*\n*b*');
    for (const html of ['<p><em>line one<br>line two</em></p>', '<p><strong>a<br>b</strong></p>']) {
        const md = INT.htmlToMarkdown(html);
        const back = INT.markdownToHtml(md);
        assert.doesNotMatch(back, /\*/, 'literal asterisk leaked for ' + html);
        assert.equal((back.match(/<(em|strong)>/g) || []).length, 2, 'both lines keep emphasis for ' + html);
        assert.equal(INT.roundTrip(md), md);
    }
});

test('footnote text with line breaks stays inside the note', { skip }, () => {
    const defs = { 1: 'first line\nsecond line\n\nafter a blank', 2: 'single' };
    const md = INT.appendFootnoteDefsEd('Claim.[^1] More.[^2]', defs);
    assert.equal(md, 'Claim.[^1] More.[^2]\n\n[^1]: first line\n    second line\n\n    after a blank\n[^2]: single');
    const h = INT.harvestFootnoteDefsEd(md);
    assert.deepEqual(h.defs, defs);
    assert.equal(h.bodyMd.trim(), 'Claim.[^1] More.[^2]');   // nothing leaked into the body
    assert.equal(INT.roundTrip(md), md);
    // a tab-indented continuation is accepted too; an unindented line ends the note
    const h2 = INT.harvestFootnoteDefsEd('x[^1]\n\n[^1]: a\n\tb\nnot part');
    assert.deepEqual(h2.defs, { 1: 'a\nb' });
    assert.equal(h2.bodyMd, 'x[^1]\n\nnot part');
    // trailing whitespace of a note is dropped; a single-line note is unchanged
    assert.equal(INT.appendFootnoteDefsEd('a[^1]', { 1: 'note  \n\n' }), 'a[^1]\n\n[^1]: note');
});

// --- Equations: $...$ and $$ blocks, TeX kept verbatim, dollars-as-text escaped ---------
test('inline equation renders with KaTeX on the surface and round-trips', { skip }, () => {
    const md = 'where $RP_{fu}$ is modeled on $[0,1]$.';
    const html = INT.markdownToHtml(md);
    assert.match(html, /<span class="math-pill" contenteditable="false" data-tex="RP_\{fu\}">/);
    assert.match(html, /class="katex"/);
    assert.equal(INT.roundTrip(md), md);
});
test('display equation ($$ block) renders as a block and round-trips', { skip }, () => {
    const md = 'Approximated by:\n\n$$\nf(Problem_u) = \\frac{RelationalProximity_{fu}}{spacetime^2}\n$$\n\nwhere spacetime is';
    const html = INT.markdownToHtml(md);
    assert.match(html, /<div class="math-block" contenteditable="false" data-tex="f\(Problem_u\) = \\frac\{RelationalProximity_\{fu\}\}\{spacetime\^2\}">/);
    assert.match(html, /katex-display/);
    assert.equal(INT.roundTrip(md), md);
    // one-line form normalizes to the block form, then stays put
    const one = 'a\n\n$$x^2$$\n\nb';
    const fp = INT.fixedPoint(one);
    assert.equal(fp.value, 'a\n\n$$\nx^2\n$$\n\nb');
    assert.ok(fp.iterations <= 1);
    // an unclosed $$ is ordinary text
    assert.doesNotMatch(INT.markdownToHtml('$$\nnever closed'), /math-block/);
});
test('dollar amounts and spaced dollars are not equations', { skip }, () => {
    for (const md of ['$5 and $10', 'costs $5 or $ more', 'between $ 3 and 4 $', 'a $$ b']) {
        assert.doesNotMatch(INT.markdownToHtml(md), /math-pill/, md);
        assert.equal(INT.roundTrip(md), md);
    }
});
test('TeX inside an equation is never touched by emphasis or escaping', { skip }, () => {
    const html = INT.markdownToHtml('$a*b*c$ and $x_1 < y_2$ then *it*');
    assert.doesNotMatch(html, /data-tex="[^"]*<em>/);
    assert.match(html, /data-tex="a\*b\*c"/);
    assert.match(html, /data-tex="x_1 &lt; y_2"/);
    assert.match(html, /<em>it<\/em>/);
    assert.equal(INT.roundTrip('$a*b*c$ and $x_1 < y_2$ then *it*'), '$a*b*c$ and $x_1 < y_2$ then *it*');
});
test('literal $x$ typed as text stays text (escaped), and \\$ reads as a dollar', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p>price is $x$ here</p>'), 'price is \\$x\\$ here');
    assert.doesNotMatch(INT.markdownToHtml('price is \\$x\\$ here'), /math-pill/);
    assert.match(INT.markdownToHtml('price is \\$x\\$ here'), /price is \$x\$ here/);
    assert.equal(INT.roundTrip('price is \\$x\\$ here'), 'price is \\$x\\$ here');
    // inside inline code nothing is scanned or escaped
    assert.equal(INT.htmlToMarkdown('<p><code>$x$</code></p>'), '`$x$`');
    assert.doesNotMatch(INT.markdownToHtml('use `$x$` literally'), /math-pill/);
});
test('equations serialize from data-tex, never from the rendered markup', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p>x <span class="math-pill" contenteditable="false" data-tex="a&lt;b">rendered junk</span> y</p>'), 'x $a<b$ y');
    assert.equal(INT.htmlToMarkdown('<p>p</p><div class="math-block" contenteditable="false" data-tex="\\frac{a}{b}">junk</div><p>q</p>'), 'p\n\n$$\n\\frac{a}{b}\n$$\n\nq');
});
test('without KaTeX the TeX source shows in a code span and still round-trips', { skip }, () => {
    const saved = global.window.katex;
    global.window.katex = undefined;
    try {
        const html = INT.markdownToHtml('see $x^2$');
        assert.match(html, /<span class="math-pill" contenteditable="false" data-tex="x\^2"><code class="math-src">\$x\^2\$<\/code><\/span>/);
        assert.equal(INT.roundTrip('see $x^2$'), 'see $x^2$');
    } finally {
        global.window.katex = saved;
    }
});

test('a non-breaking space left at a line end by the browser is not stored', { skip }, () => {
    assert.equal(INT.htmlToMarkdown('<p>word\u00a0<br>next</p>'), 'word\nnext');
    assert.equal(INT.htmlToMarkdown('<p>end\u00a0</p>'), 'end');
    // a non-breaking space between words is kept: it may be deliberate
    assert.equal(INT.htmlToMarkdown('<p>10\u00a0km</p>'), '10\u00a0km');
});
