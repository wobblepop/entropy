/* Test helper: load the editor's private conversion functions into a jsdom DOM.
 *
 * editor/js/editor.js is a browser IIFE (`const NodeEditor = (() => { ... })()`) that
 * does not export its conversion helpers. Rather than maintain a drifting copy, we read
 * the real source and inject a one-line global assignment just before the module's
 * `return {...}`, then eval it inside an isolated function scope. This keeps the tests
 * exercising the exact code that ships.
 */
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported by hasJsdom */ }

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EDITOR_JS = path.resolve(__dirname, '..', '..', 'js', 'editor.js');
const STATE_JS = path.resolve(__dirname, '..', '..', 'js', 'state.js');
const READER_MD_JS = path.resolve(REPO_ROOT, 'explainer', 'js', 'markdown.js');

function setupDom() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    global.CSS = dom.window.CSS;
    // editor.js references these only inside functions we don't call here.
    global.EditorState = { on() {}, getNode() { return null; } };
    global.SuggestDiff = {};
    return dom;
}

// Expose editor.js conversion internals: { markdownToHtml, htmlToMarkdown, nodeToMd,
// inlineFormat, harvestFootnoteDefsEd, appendFootnoteDefsEd }.
function loadEditorInternals() {
    if (!JSDOM) throw new Error('jsdom is not installed — run `npm install` in editor/test');
    setupDom();
    let src = fs.readFileSync(EDITOR_JS, 'utf8');
    const marker = 'return { init, toast, applyFormat';
    const at = src.indexOf(marker);
    if (at < 0) throw new Error('load-editor: could not find the module return marker in editor.js; update this helper.');
    const expose = 'globalThis.__EDITOR_INTERNALS__ = { markdownToHtml, htmlToMarkdown, nodeToMd, '
                 + 'inlineFormat, harvestFootnoteDefsEd, appendFootnoteDefsEd };\n    ';
    src = src.slice(0, at) + expose + src.slice(at);
    new Function(src)();            // isolated scope; sets the global
    const INT = globalThis.__EDITOR_INTERNALS__;

    // Faithful editor round trip: stored md -> edit surface -> serialize -> stored md.
    INT.roundTrip = (md) => {
        const h = INT.harvestFootnoteDefsEd(md || '');
        return INT.appendFootnoteDefsEd(INT.htmlToMarkdown(INT.markdownToHtml(h.bodyMd)), h.defs);
    };
    INT.fixedPoint = (md, limit = 60) => {
        let prev = md;
        for (let i = 0; i < limit; i++) {
            const next = INT.roundTrip(prev);
            if (next === prev) return { iterations: i, value: prev };
            prev = next;
        }
        return { iterations: -1, value: prev };
    };
    return INT;
}

// Expose the EditorState module object from state.js (DOM-free).
function loadEditorState() {
    const src = fs.readFileSync(STATE_JS, 'utf8');
    return new Function(src + '\n;return EditorState;')();
}

// Expose the reader's Markdown module (explainer/js/markdown.js). parse/parseInline are
// pure string functions, so no DOM is needed.
function loadReaderMarkdown() {
    const src = fs.readFileSync(READER_MD_JS, 'utf8');
    return new Function(src + '\n;return Markdown;')();
}

// Expose the reader's PrintChapter pure helpers (explainer/js/print-chapter.js). The
// module only touches the DOM inside init()/open(), so a stub State/App and the real
// Markdown module are enough to exercise the helpers without jsdom.
const READER_PRINT_JS = path.resolve(REPO_ROOT, 'explainer', 'js', 'print-chapter.js');
function loadPrintChapterInternals() {
    let src = fs.readFileSync(READER_PRINT_JS, 'utf8');
    const marker = 'return { init, open, close, isOpen, printSections };';
    const count = src.split(marker).length - 1;
    if (count !== 1) throw new Error(`load-editor: expected exactly one module return marker in print-chapter.js, found ${count}; update this helper.`);
    const expose = 'globalThis.__PRINT_INTERNALS__ = { computeDepths, subtreeIds, structureLabels, '
                 + 'pdfFileTitle, pdfIdFromHash, renderMediaForPrint, renderSection, '
                 + 'linearOrder, expandSelection, topLevelChosen, pdfTitleForSelection, renderToc };\n    ';
    src = src.replace(marker, expose + marker);
    const Markdown = loadReaderMarkdown();
    const State = { on() {}, getData() { return null; }, getCurrentNodeId() { return null; }, getLinearOrder() { return []; } };
    const App = { showToast() {} };
    new Function('State', 'Markdown', 'App', src)(State, Markdown, App);
    return globalThis.__PRINT_INTERNALS__;
}

// Expose the editor's PdfExport pure helpers (editor/js/pdf-export.js): the section
// walks and file-name rules it duplicates from the reader (cross-checked by
// pdf-export.test.js), the service error message, and the picker summary line. The
// module only touches the DOM inside init()/open()/save(), so stubbed
// EditorState/NodeEditor suffice.
const EDITOR_PDF_JS = path.resolve(__dirname, '..', '..', 'js', 'pdf-export.js');
function loadPdfExportInternals() {
    let src = fs.readFileSync(EDITOR_PDF_JS, 'utf8');
    const marker = 'return { init, open, close, isOpen };';
    const count = src.split(marker).length - 1;
    if (count !== 1) throw new Error(`load-editor: expected exactly one module return marker in pdf-export.js, found ${count}; update this helper.`);
    const expose = 'globalThis.__PDF_EXPORT_INTERNALS__ = { computeDepths, subtreeIds, structureLabels, '
                 + 'linearOrder, expandSelection, pdfFileTitle, topLevelChosen, titleForSelection, '
                 + 'summaryText, errorFromResponse, serviceUrl };\n    ';
    src = src.replace(marker, expose + marker);
    const EditorState = { getData() { return null; }, getSelectedNodeId() { return null; }, getExportData() { return null; } };
    const NodeEditor = { toast() {}, flushContent() {} };
    new Function('EditorState', 'NodeEditor', src)(EditorState, NodeEditor);
    return globalThis.__PDF_EXPORT_INTERNALS__;
}

// Opportunistically collect any *.entropy.json / book JSONs in the repo root for corpus
// tests. Returns [] when none are present (the suite's synthetic cases still run).
function findBooks() {
    if (!fs.existsSync(REPO_ROOT)) return [];
    const out = [];
    for (const f of fs.readdirSync(REPO_ROOT)) {
        if (!/\.json$/.test(f) || /\.bak$/.test(f)) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
            if (data && data.nodes && typeof data.nodes === 'object') out.push({ name: f, data });
        } catch (e) { /* not a book */ }
    }
    for (const rel of ['sample/demo-textbook.entropy.json', 'sample/entropy-guide.entropy.json']) {
        const p = path.join(REPO_ROOT, rel);
        if (fs.existsSync(p)) {
            try { const data = JSON.parse(fs.readFileSync(p, 'utf8')); if (data.nodes) out.push({ name: rel, data }); }
            catch (e) { /* skip */ }
        }
    }
    return out;
}

module.exports = { loadEditorInternals, loadEditorState, loadReaderMarkdown, loadPrintChapterInternals, loadPdfExportInternals, findBooks, hasJsdom: !!JSDOM };
