/* ============================================
   PDF EXPORT — "Generate PDF" from inside the editor

   Flow: header PDF button / palette command -> picker modal (checkbox tree of
   every section; ticking a section also ticks its sub-sections, and any tick,
   the heading included, can be removed) -> the book snapshot and the ticked
   ids are POSTed to the local PDF service (pdf_service.py on 127.0.0.1) ->
   it answers with the PDF that entropy_to_pdf_v2.py produces: real text, a
   cover, a contents page with true page numbers, one section per page -> the
   editor saves it through the browser's save picker, or as a download where
   that API is missing. No print dialog is involved, so nothing can be
   rasterized by a printer driver.

   The service has to be running (py pdf_service.py, or start_pdf_service.bat);
   the picker checks GET /health when it opens and says so when it is not.
   The service URL can be overridden with the localStorage key
   "entropy-pdf-service-url" (default http://127.0.0.1:8644).

   Owns: #btn-pdf, #pdf-modal (+ #pdf-tree, #pdf-select-all, #pdf-select-none,
   #pdf-select-current, #pdf-summary, #pdf-service-status, #pdf-service-text,
   #pdf-service-retry, #pdf-cancel, #pdf-save-btn).
   Reads EditorState, NodeEditor (flushContent, toast).
   ============================================ */

const PdfExport = (() => {
    let btn = null, modal = null, tree = null, summary = null;
    let saveBtn = null, cancelBtn = null, allBtn = null, noneBtn = null, currentBtn = null;
    let serviceBox = null, serviceText = null, retryBtn = null;
    let serviceState = 'unknown';   // 'checking' | 'ready' | 'stale' | 'down' | 'unknown'
    let busy = false;               // a PDF request is in flight
    const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8644';
    const SERVICE_URL_KEY = 'entropy-pdf-service-url';
    const HEALTH_TIMEOUT_MS = 2500;
    // What this editor can put in a book that the service's exporter must know how to
    // render; an older service answers /health without them and would drop them silently.
    const REQUIRED_FEATURES = { fonts: 'text fonts', equations: 'equations', 'footnote-lines': 'multi-line footnotes' };
    const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
    const SAVE_LABEL = 'Generate PDF';

    function toast(msg, type) {
        if (typeof NodeEditor !== 'undefined' && NodeEditor && typeof NodeEditor.toast === 'function') {
            NodeEditor.toast(msg, type || 'info');
        } else if (typeof console !== 'undefined') {
            console.warn(msg);
        }
    }

    // --- pure helpers ---
    // Deliberate copies of the walks and naming rules in explainer/js/print-chapter.js:
    // the editor bundle cannot reach inside the viewer's IIFE. editor/test/pdf-export.test.js
    // cross-checks them against the viewer's originals so the two cannot drift apart silently.

    // Depth of every node reachable from the root (root = 0). Orphans are absent.
    function computeDepths(data) {
        const depths = {};
        if (!data || !data.nodes || typeof data.nodes !== 'object' || !data.root) return depths;
        (function walk(id, d) {
            if (depths[id] !== undefined || !data.nodes[id]) return;
            depths[id] = d;
            (Array.isArray(data.nodes[id].children) ? data.nodes[id].children : []).forEach(c => walk(c, d + 1));
        })(data.root, 0);
        return depths;
    }

    // The node followed by all of its descendants in reading (pre-)order; cycles
    // and shared children are visited once.
    function subtreeIds(data, rootId) {
        const out = [];
        if (!data || !data.nodes || typeof data.nodes !== 'object' || !data.nodes[rootId]) return out;
        const seen = new Set();
        (function walk(id) {
            if (seen.has(id) || !data.nodes[id]) return;
            seen.add(id);
            out.push(id);
            (Array.isArray(data.nodes[id].children) ? data.nodes[id].children : []).forEach(walk);
        })(rootId);
        return out;
    }

    // "Chapter N" / "Epilogue" labels from meta.structure; {} when there is none.
    function structureLabels(data) {
        const out = {};
        const s = data && data.meta && data.meta.structure;
        if (!s || typeof s !== 'object') return out;
        let ch = 0;
        (Array.isArray(s.parts) ? s.parts : []).forEach(p => {
            (p && Array.isArray(p.nodes) ? p.nodes : []).forEach(nid => {
                ch += 1;
                if (typeof nid === 'string') out[nid] = 'Chapter ' + ch;
            });
        });
        (Array.isArray(s.epilogues) ? s.epilogues : []).forEach(e => {
            if (e && typeof e.node === 'string') out[e.node] = 'Epilogue';
        });
        return out;
    }

    // Reading order: the root's subtree, then orphans (same as EditorState.getLinearOrder).
    function linearOrder(data) {
        if (!data || !data.nodes || typeof data.nodes !== 'object') return [];
        const out = subtreeIds(data, data.root);
        const seen = new Set(out);
        Object.keys(data.nodes).forEach(id => {
            if (!seen.has(id)) { seen.add(id); out.push(id); }
        });
        return out;
    }

    // Ordered, de-duplicated list of what will print for a set of ticked ids.
    function expandSelection(data, ids, withChildren) {
        if (!data || !data.nodes || typeof data.nodes !== 'object' || !Array.isArray(ids)) return [];
        const wanted = new Set();
        ids.forEach(id => {
            if (typeof id !== 'string' || !data.nodes[id]) return;
            (withChildren ? subtreeIds(data, id) : [id]).forEach(x => wanted.add(x));
        });
        if (!wanted.size) return [];
        return linearOrder(data).filter(id => wanted.has(id));
    }

    // Suggested file name (without .pdf): file-name-hostile characters replaced.
    function pdfFileTitle(bookTitle, label, sectionTitle) {
        const bits = [bookTitle, label, sectionTitle]
            .map(b => (b == null ? '' : String(b)).trim())
            .filter(Boolean);
        const joined = bits.join(' - ') || 'section';
        return joined.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    // The ticked ids that are not inside another ticked id's subtree, in reading order.
    function topLevelChosen(data, ids) {
        const valid = expandSelection(data, ids, false);
        if (valid.length < 2) return valid;
        const covered = new Set();
        valid.forEach(id => subtreeIds(data, id).slice(1).forEach(x => covered.add(x)));
        return valid.filter(id => !covered.has(id));
    }

    // File name for a set of ticked sections (the ticks are the whole selection):
    // every reachable node -> the book title; one heading -> "<book> - Chapter N - Title";
    // otherwise "<book> - <first> to <last>". Same rules as the viewer's pdfTitleForSelection.
    function titleForSelection(data, ids) {
        const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : {};
        const book = typeof meta.title === 'string' ? meta.title : '';
        const valid = expandSelection(data, ids, false);
        if (!valid.length) return pdfFileTitle(book, '', '');
        if (valid.length > 1) {
            const printed = new Set(valid);
            const whole = subtreeIds(data, data.root);
            if (whole.length && whole.every(id => printed.has(id))) return pdfFileTitle(book || 'book', '', '');
        }
        const labels = structureLabels(data);
        const titleOf = id => (data.nodes[id] && data.nodes[id].title) || id;
        const top = topLevelChosen(data, ids);
        if (top.length === 1) return pdfFileTitle(book, labels[top[0]] || '', titleOf(top[0]));
        const nameOf = id => labels[id] || titleOf(id);
        return pdfFileTitle(book, '', nameOf(top[0]) + ' to ' + nameOf(top[top.length - 1]));
    }

    // Picker status line, e.g. "7 sections will print in reading order".
    function summaryText(total) {
        const n = Number.isInteger(total) && total > 0 ? total : 0;
        if (!n) return 'No sections ticked';
        return n === 1 ? '1 section will print' : n + ' sections will print in reading order';
    }

    // Reader-facing message for a failed service response.
    function errorFromResponse(status, bodyText) {
        let msg = '';
        try {
            const parsed = JSON.parse(bodyText);
            if (parsed && typeof parsed.error === 'string') msg = parsed.error;
        } catch (e) { /* not JSON */ }
        if (!msg) msg = (typeof bodyText === 'string' && bodyText.trim()) ? bodyText.trim().slice(0, 200) : ('HTTP ' + status);
        return 'PDF service: ' + msg;
    }

    function serviceUrl() {
        let url = '';
        try { url = localStorage.getItem(SERVICE_URL_KEY) || ''; } catch (e) { url = ''; }
        url = (url || DEFAULT_SERVICE_URL).trim().replace(/\/+$/, '');
        return /^https?:\/\//i.test(url) ? url : DEFAULT_SERVICE_URL;
    }

    // --- service status ---

    function setServiceState(state, message) {
        serviceState = state;
        if (!serviceBox) return;
        serviceBox.classList.toggle('ok', state === 'ready');
        serviceBox.classList.toggle('stale', state === 'stale');
        serviceBox.classList.toggle('down', state === 'down');
        serviceText.textContent = message;
        retryBtn.hidden = state !== 'down' && state !== 'stale';
        refresh();
    }

    // The folder this editor was opened from (file:// builds), lower-cased with forward
    // slashes; '' when it is served over http and the comparison does not apply.
    function editorFolder() {
        if (typeof location === 'undefined' || location.protocol !== 'file:') return '';
        try {
            const p = decodeURIComponent(location.pathname).replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1');
            return p.slice(0, p.lastIndexOf('/'));
        } catch (e) { return ''; }
    }

    // Reasons a running service would not produce what this editor shows: features its
    // exporter lacks, or an exporter loaded from a different folder than this editor.
    function serviceProblems(info) {
        const out = [];
        const have = Array.isArray(info.features) ? info.features : [];
        const missing = Object.keys(REQUIRED_FEATURES).filter(f => !have.includes(f)).map(f => REQUIRED_FEATURES[f]);
        if (missing.length) out.push('its PDFs would drop ' + missing.join(', '));
        const here = editorFolder();
        if (here && typeof info.exporter === 'string' && info.exporter) {
            const there = info.exporter.replace(/\\/g, '/').toLowerCase();
            const dir = there.slice(0, there.lastIndexOf('/'));
            if (dir && dir !== here.toLowerCase()) out.push('it runs from ' + dir + ', not from this editor\'s folder');
        }
        return out;
    }

    async function checkService() {
        const url = serviceUrl();
        setServiceState('checking', 'Checking the PDF service at ' + url + ' …');
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS) : null;
        try {
            const res = await fetch(url + '/health', { method: 'GET', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
            const info = res.ok ? await res.json() : null;
            if (info && info.ok === true && info.service === 'entropy-pdf') {
                const problems = serviceProblems(info);
                if (problems.length) {
                    const here = editorFolder();
                    setServiceState('stale', 'The PDF service at ' + url + ' is an older build: ' + problems.join('; ') +
                        '. Stop it and start it from ' + (here || 'this editor\'s folder') +
                        ' (start_pdf_service.bat or py pdf_service.py), then Retry.');
                } else {
                    setServiceState('ready', 'PDF service ready at ' + url +
                        (typeof info.exporter === 'string' && info.exporter ? ' (exporter: ' + info.exporter + ')' : ''));
                }
            } else {
                setServiceState('down', 'Something at ' + url + ' answered, but it is not the Entropy PDF service. Start it with: py pdf_service.py (or start_pdf_service.bat) in the entropy folder.');
            }
        } catch (err) {
            setServiceState('down', 'PDF service not running at ' + url + '. Start it with: py pdf_service.py (or start_pdf_service.bat) in the entropy folder, then Retry.');
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // --- picker modal ---

    function open() {
        const data = EditorState.getData();
        if (!data) { toast('Nothing to export — create or open a file first', 'info'); return; }
        if (busy) { toast('A PDF is already being generated', 'info'); return; }
        buildTree(data, EditorState.getSelectedNodeId());
        modal.hidden = false;
        checkService();
        const first = tree.querySelector('input:checked') || tree.querySelector('input');
        if (first) requestAnimationFrame(() => { first.focus(); first.scrollIntoView({ block: 'nearest' }); });
    }

    function close() {
        if (modal) modal.hidden = true;
    }

    function isOpen() {
        return modal ? !modal.hidden : false;
    }

    function buildTree(data, selectedId) {
        tree.innerHTML = '';
        const depths = computeDepths(data);
        const labels = structureLabels(data);
        // The section being edited starts ticked together with its sub-sections,
        // exactly as a click on it would leave things.
        const preticked = new Set(subtreeIds(data, selectedId));
        linearOrder(data).forEach(id => {
            const node = data.nodes[id];
            if (!node) return;
            const depth = depths[id] || 0;
            const label = document.createElement('label');
            label.className = 'pdf-item depth-' + Math.min(depth, 5);

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = 'pdf-node';
            input.value = id;
            input.checked = preticked.has(id);
            input.addEventListener('change', () => onToggle(input));

            const indent = document.createElement('span');
            indent.className = 'pdf-item-indent';
            indent.style.width = (depth * 14) + 'px';

            const title = document.createElement('span');
            title.className = 'pdf-item-title';
            title.textContent = node.title || id;

            label.appendChild(input);
            label.appendChild(indent);
            if (labels[id]) {
                const num = document.createElement('span');
                num.className = 'pdf-item-num';
                num.textContent = labels[id];
                label.appendChild(num);
            }
            label.appendChild(title);
            tree.appendChild(label);
        });
        refresh();
    }

    // Ticking a section ticks its whole subtree; unticking removes only that one
    // section, so a specific sub-section (or the heading alone) can be dropped.
    function onToggle(input) {
        if (input.checked) {
            const data = EditorState.getData();
            const ids = new Set(subtreeIds(data, input.value));
            tree.querySelectorAll('input[name="pdf-node"]').forEach(el => {
                if (ids.has(el.value)) el.checked = true;
            });
        }
        refresh();
    }

    function tickedIds() {
        return Array.prototype.map.call(tree.querySelectorAll('input[name="pdf-node"]:checked'), el => el.value);
    }

    function setAll(checked) {
        tree.querySelectorAll('input[name="pdf-node"]').forEach(el => { el.checked = checked; });
        refresh();
    }

    function selectCurrent() {
        const ids = new Set(subtreeIds(EditorState.getData(), EditorState.getSelectedNodeId()));
        tree.querySelectorAll('input[name="pdf-node"]').forEach(el => { el.checked = ids.has(el.value); });
        refresh();
    }

    function refresh() {
        const data = EditorState.getData();
        if (!data || !tree) return;
        tree.querySelectorAll('.pdf-item').forEach(item => {
            const input = item.querySelector('input');
            if (input) item.classList.toggle('selected', input.checked);
        });
        const total = expandSelection(data, tickedIds(), false).length;
        summary.textContent = summaryText(total);
        saveBtn.disabled = busy || total === 0 || (serviceState !== 'ready' && serviceState !== 'stale');
    }

    function setBusy(b) {
        busy = !!b;
        if (saveBtn) saveBtn.textContent = busy ? 'Generating…' : SAVE_LABEL;
        refresh();
    }

    // --- generating through the local service ---

    // Write the PDF where the author chooses (File System Access API), or hand it
    // to the browser as a download. Returns 'saved' | 'downloaded' | 'cancelled'.
    async function saveBlob(blob, filename) {
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return 'saved';
            } catch (err) {
                if (err && err.name === 'AbortError') return 'cancelled';
                // Picker unavailable or refused (e.g. a blocked location): fall back to a download.
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return 'downloaded';
    }

    async function save() {
        const live = EditorState.getData();
        if (!live) { toast('Nothing to export — create or open a file first', 'info'); return; }
        if (busy) return;
        const ticked = tickedIds();
        if (!expandSelection(live, ticked, false).length) { toast('Tick at least one section', 'error'); return; }
        if (serviceState !== 'ready') { toast('The PDF service is not running — start it, then Retry', 'error'); return; }

        NodeEditor.flushContent();
        const data = EditorState.getExportData();
        const filename = titleForSelection(data, ticked) + '.pdf';
        const url = serviceUrl();
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), RENDER_TIMEOUT_MS) : null;

        setBusy(true);
        toast('Generating PDF… (a few seconds per pass)', 'info');
        try {
            const res = await fetch(url + '/pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: data, sections: ticked, filename: filename }),
                signal: ctrl ? ctrl.signal : undefined
            });
            if (!res.ok) {
                toast(errorFromResponse(res.status, await res.text()), 'error');
                return;
            }
            const blob = await res.blob();
            if (!blob || !blob.size) { toast('PDF service returned an empty file', 'error'); return; }
            close();
            const how = await saveBlob(blob, filename);
            if (how === 'saved') toast('PDF saved: ' + filename, 'success');
            else if (how === 'downloaded') toast('PDF downloaded: ' + filename, 'success');
            else toast('Save cancelled — the PDF was not written', 'info');
        } catch (err) {
            const aborted = err && err.name === 'AbortError';
            toast(aborted ? 'PDF generation timed out' : ('Could not reach the PDF service: ' + (err && err.message ? err.message : err)), 'error');
            checkService();
        } finally {
            if (timer) clearTimeout(timer);
            setBusy(false);
        }
    }

    function init() {
        btn = document.getElementById('btn-pdf');
        modal = document.getElementById('pdf-modal');
        tree = document.getElementById('pdf-tree');
        summary = document.getElementById('pdf-summary');
        saveBtn = document.getElementById('pdf-save-btn');
        cancelBtn = document.getElementById('pdf-cancel');
        allBtn = document.getElementById('pdf-select-all');
        noneBtn = document.getElementById('pdf-select-none');
        currentBtn = document.getElementById('pdf-select-current');
        serviceBox = document.getElementById('pdf-service-status');
        serviceText = document.getElementById('pdf-service-text');
        retryBtn = document.getElementById('pdf-service-retry');
        if (!btn || !modal || !tree || !summary || !saveBtn || !cancelBtn || !allBtn || !noneBtn || !currentBtn ||
            !serviceBox || !serviceText || !retryBtn) {
            if (typeof console !== 'undefined') console.warn('PdfExport: markup missing; PDF export disabled.');
            if (btn) btn.hidden = true;
            return;
        }
        btn.addEventListener('click', () => open());
        saveBtn.addEventListener('click', save);
        cancelBtn.addEventListener('click', close);
        allBtn.addEventListener('click', () => setAll(true));
        noneBtn.addEventListener('click', () => setAll(false));
        currentBtn.addEventListener('click', selectCurrent);
        retryBtn.addEventListener('click', checkService);
        tree.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
    }

    return { init, open, close, isOpen };
})();
