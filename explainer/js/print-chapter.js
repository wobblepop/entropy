/* ============================================
   PRINT CHAPTER — "Save as PDF" for one section (+ its sub-sections)

   Flow: header button -> picker modal (tree of sections, current one
   preselected) -> the chosen section and, optionally, its descendants are
   rendered into #print-chapter -> <html class="printing-chapter"> hides the
   rest of the reader (css/pdf-export.css) -> window.print(). The reader
   chooses "Save as PDF" as the print destination; document.title is set to
   "<book> - <chapter>" for the duration so that becomes the suggested file
   name. Everything is restored on afterprint.

   Deep link: opening the reader with #pdf=<nodeId> in the URL opens the
   picker with that section preselected (#pdf alone preselects the current
   section).

   Programmatic: PrintChapter.printSections(ids, { withChildren }) prints an
   explicit list of sections (any number, in reading order) with no picker.
   The editor hosts this reader in a hidden same-origin iframe and calls it
   through window.PrintChapter, so its own picker can offer every section.

   Output: a Contents page (when more than one section prints) followed by
   every section on its own page; contents entries link to section anchors.

   Owns: #pdf-btn, #pdf-modal (+ #pdf-tree, #pdf-include-children,
   #pdf-save-btn), #print-chapter. Reads State and Markdown.
   ============================================ */

const PrintChapter = (() => {
    let btn = null, modal = null, tree = null, includeKids = null, saveBtn = null, container = null;
    let printing = false;
    let savedTitle = null;

    function esc(s) { return Markdown.escapeHtml(s == null ? '' : String(s)); }

    function toast(msg) {
        if (typeof App !== 'undefined' && App && typeof App.showToast === 'function') App.showToast(msg);
        else if (typeof console !== 'undefined') console.warn(msg);
    }

    // --- pure helpers (exercised by editor/test/print-chapter.test.js) ---

    // Depth of every node reachable from the root (root = 0). Unreachable nodes
    // are absent; callers treat that as depth 0.
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

    // The node followed by all of its descendants in reading (pre-)order.
    // A `seen` set guards against cycles and shared children.
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

    // "Chapter N" / "Epilogue" labels from meta.structure (same numbering the
    // Python exporters use). Empty object when the book has no structure.
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

    // Suggested PDF file name (browsers take it from document.title).
    function pdfFileTitle(bookTitle, label, sectionTitle) {
        const bits = [bookTitle, label, sectionTitle]
            .map(b => (b == null ? '' : String(b)).trim())
            .filter(Boolean);
        const joined = bits.join(' - ') || 'section';
        return joined.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    // Parse the deep link. Returns: null when the hash has no pdf param,
    // '' for a bare "#pdf" (open the picker, default selection), else the id.
    function pdfIdFromHash(hash) {
        if (typeof hash !== 'string' || !hash) return null;
        const m = hash.replace(/^#/, '').match(/(?:^|&)pdf(?:=([^&]*))?(?=&|$)/);
        if (!m) return null;
        if (m[1] === undefined || m[1] === '') return '';
        try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
    }

    // Reading order for the whole book: the root's subtree, then any orphans
    // (nodes unreachable from the root). Same walk as State.getLinearOrder, but
    // pure so it can run on a snapshot without State.
    function linearOrder(data) {
        if (!data || !data.nodes || typeof data.nodes !== 'object') return [];
        const out = subtreeIds(data, data.root);
        const seen = new Set(out);
        Object.keys(data.nodes).forEach(id => {
            if (!seen.has(id)) { seen.add(id); out.push(id); }
        });
        return out;
    }

    // Turn a pick of section ids into the ordered, de-duplicated list that gets
    // printed: unknown and repeated ids are dropped, each survivor is expanded to
    // its subtree when withChildren is true, and the result follows reading order
    // regardless of the order the ids were picked in.
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

    // The picked ids that are not inside another picked id's subtree, in reading
    // order: the headings that describe a selection (a ticked chapter plus its
    // ticked sub-sections is described by the chapter alone).
    function topLevelChosen(data, ids) {
        const valid = expandSelection(data, ids, false);
        if (valid.length < 2) return valid;
        const covered = new Set();
        valid.forEach(id => subtreeIds(data, id).slice(1).forEach(x => covered.add(x)));
        return valid.filter(id => !covered.has(id));
    }

    // Suggested file name for a selection. Several picks that together cover the
    // whole book (every node reachable from the root) give just the book title;
    // one heading keeps the single-section form ("<book> - Chapter 2 - Title");
    // anything else is "<book> - <first> to <last>", using chapter labels when
    // the book has them.
    function pdfTitleForSelection(data, ids, withChildren) {
        const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : {};
        const book = typeof meta.title === 'string' ? meta.title : '';
        const valid = expandSelection(data, ids, false);
        if (!valid.length) return pdfFileTitle(book, '', '');
        if (valid.length > 1) {
            const printed = new Set(expandSelection(data, ids, withChildren));
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

    // --- rendering ---

    function metaBadges(node) {
        let h = '';
        if (node.difficulty) h += `<span class="difficulty-badge difficulty-${esc(node.difficulty)}">${esc(node.difficulty)}</span>`;
        if (node.estimatedTime) h += `<span class="time-estimate">${esc(node.estimatedTime)}</span>`;
        if (Array.isArray(node.tags) && node.tags.length) h += node.tags.map(t => `<span class="meta-tag">${esc(t)}</span>`).join('');
        return h;
    }

    // Images print inline; video/audio/embeds become a labelled link line
    // (mirrors entropy_to_html.py's _media_html: nothing playable survives on paper).
    function renderMediaForPrint(m) {
        if (!m || typeof m !== 'object') return '';
        const type = typeof m.type === 'string' ? m.type : '';
        const src = typeof m.src === 'string' ? m.src : '';
        const caption = m.caption || m.alt || '';
        if (type === 'image' || type === 'diagram') {
            if (!src) return '';
            return `<figure class="media-item"><img src="${esc(src)}" alt="${esc(m.alt || '')}">` +
                (caption ? `<figcaption class="media-caption">${esc(caption)}</figcaption>` : '') +
                `</figure>`;
        }
        if (type === 'video' || type === 'audio' || type === 'embed') {
            const label = caption || src;
            if (!label) return '';
            const isHttp = /^https?:\/\//i.test(src);
            const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
            return `<div class="print-media-link"><span class="mtype">${esc(typeLabel)}</span>` +
                (isHttp ? `<a href="${esc(src)}">${esc(label)}</a>` : esc(label)) +
                `</div>`;
        }
        return '';
    }

    function renderSection(node, relDepth, label) {
        const media = Array.isArray(node.media) ? node.media.map(renderMediaForPrint).join('') : '';
        const badges = metaBadges(node);
        const depth = Math.min(Math.max(relDepth, 0), 5);
        return `<section class="print-node depth-${depth}" data-node-id="${esc(node.id)}" id="print-sec-${esc(node.id)}">` +
            (label ? `<div class="print-chapter-num">${esc(label)}</div>` : '') +
            `<h2 class="print-node-title">${esc(node.title || node.id)}</h2>` +
            (badges ? `<div class="node-meta">${badges}</div>` : '') +
            (node.summary ? `<p class="node-summary">${esc(node.summary)}</p>` : '') +
            `<div class="node-body">${Markdown.renderWithFootnotes(node.content || '', 'pdf-' + node.id)}</div>` +
            (media ? `<div class="node-media">${media}</div>` : '') +
            `</section>`;
    }

    // Relative depth: the shallowest printed section gets the top-level title
    // size, so a chapter looks the same whether printed alone or with others.
    function baseDepthOf(data, ids, depths) {
        let base = Infinity;
        ids.forEach(id => { if (data.nodes[id]) base = Math.min(base, depths[id] || 0); });
        return isFinite(base) ? base : 0;
    }

    // Contents page: every printed section in print order, indented by relative
    // depth, each linking to its section anchor. Empty when fewer than two
    // sections print, since a one-line contents page would only waste paper.
    function renderToc(data, ids) {
        if (!data || !data.nodes || typeof data.nodes !== 'object' || !Array.isArray(ids)) return '';
        const valid = ids.filter(id => typeof id === 'string' && !!data.nodes[id]);
        if (valid.length < 2) return '';
        const depths = computeDepths(data);
        const labels = structureLabels(data);
        const base = baseDepthOf(data, valid, depths);
        const items = valid.map(id => {
            const depth = Math.min(Math.max((depths[id] || 0) - base, 0), 5);
            return `<li class="depth-${depth}"><a href="#print-sec-${encodeURIComponent(id)}">` +
                (labels[id] ? `<span class="print-toc-num">${esc(labels[id])}</span>` : '') +
                `<span class="print-toc-text">${esc(data.nodes[id].title || id)}</span></a></li>`;
        }).join('');
        return `<nav class="print-toc" aria-label="Contents"><h2 class="print-toc-title">Contents</h2>` +
            `<ul class="print-toc-list">${items}</ul></nav>`;
    }

    function renderIntoContainer(data, ids) {
        const depths = computeDepths(data);
        const labels = structureLabels(data);
        const baseDepth = baseDepthOf(data, ids, depths);
        const meta = data.meta || {};
        let html = `<header class="print-book-line"><span class="print-book-title">${esc(meta.title || '')}</span>` +
            (meta.author ? ` &middot; ${esc(meta.author)}` : '') + `</header>`;
        html += renderToc(data, ids);
        let rendered = 0;
        ids.forEach(id => {
            const node = data.nodes[id];
            if (!node) return;
            html += renderSection(node, (depths[id] || 0) - baseDepth, labels[id] || '');
            rendered += 1;
        });
        container.innerHTML = html;
        return rendered;
    }

    // --- picker modal ---

    function open(preselect) {
        const data = State.getData();
        if (!data) { toast('Load a file first'); return; }
        const wanted = typeof preselect === 'string' && data.nodes[preselect] ? preselect : State.getCurrentNodeId();
        buildTree(data, wanted);
        modal.classList.add('visible');
        modal.setAttribute('aria-hidden', 'false');
        const checked = tree.querySelector('input:checked');
        if (checked) requestAnimationFrame(() => { checked.focus(); checked.scrollIntoView({ block: 'nearest' }); });
    }

    function close() {
        modal.classList.remove('visible');
        modal.setAttribute('aria-hidden', 'true');
    }

    function isOpen() { return modal ? modal.classList.contains('visible') : false; }

    function buildTree(data, selectedId) {
        tree.innerHTML = '';
        const order = State.getLinearOrder();
        const depths = computeDepths(data);
        const labels = structureLabels(data);
        order.forEach(id => {
            const node = data.nodes[id];
            if (!node) return;
            const depth = depths[id] || 0;
            const label = document.createElement('label');
            label.className = 'pdf-item depth-' + Math.min(depth, 5);

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'pdf-node';
            input.value = id;
            input.checked = id === selectedId;
            input.addEventListener('change', markSelected);

            const indent = document.createElement('span');
            indent.className = 'pdf-item-indent';
            indent.style.width = (depth * 14) + 'px';

            const title = document.createElement('span');
            title.className = 'pdf-item-title';
            title.textContent = node.title || id;

            const count = document.createElement('span');
            count.className = 'pdf-item-count';
            count.dataset.nodeId = id;

            label.appendChild(input);
            label.appendChild(indent);
            if (labels[id]) {
                const num = document.createElement('span');
                num.className = 'pdf-item-num';
                num.textContent = labels[id];
                label.appendChild(num);
            }
            label.appendChild(title);
            label.appendChild(count);
            tree.appendChild(label);
        });
        if (!tree.querySelector('input:checked')) {
            const first = tree.querySelector('input');
            if (first) first.checked = true;
        }
        markSelected();
        updateCounts();
    }

    function markSelected() {
        tree.querySelectorAll('.pdf-item').forEach(item => {
            const input = item.querySelector('input');
            item.classList.toggle('selected', !!(input && input.checked));
        });
    }

    function updateCounts() {
        const data = State.getData();
        if (!data) return;
        const withKids = includeKids.checked;
        tree.querySelectorAll('.pdf-item-count').forEach(el => {
            const n = withKids ? subtreeIds(data, el.dataset.nodeId).length - 1 : 0;
            el.textContent = n > 0 ? `+${n} sub-section${n === 1 ? '' : 's'}` : '';
        });
    }

    // --- printing ---

    function waitForImages(root, timeoutMs) {
        const imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
        const pending = imgs.filter(img => !img.complete).map(img => new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        }));
        if (!pending.length) return Promise.resolve();
        return Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, timeoutMs))]);
    }

    // Core print used by both the picker and printSections(): validate and expand
    // the picked ids, render them, retitle the document, print. Resolves
    // { printed, title } once window.print() has returned; rejects with an Error
    // whose message is safe to show the reader when there is nothing to print.
    function printSelection(ids, withChildren) {
        const data = State.getData();
        if (!data) return Promise.reject(new Error('Load a file first'));
        const printIds = expandSelection(data, ids, withChildren);
        if (!printIds.length) return Promise.reject(new Error('Choose at least one section that exists in this book'));

        // A previous print whose afterprint never arrived must not wedge the button.
        cleanup();

        const rendered = renderIntoContainer(data, printIds);
        if (!rendered) return Promise.reject(new Error('Nothing to print for that selection'));

        if (isOpen()) close();
        const title = pdfTitleForSelection(data, ids, withChildren);
        savedTitle = document.title;
        document.title = title;
        document.documentElement.classList.add('printing-chapter');
        printing = true;

        return waitForImages(container, 3000).then(() => {
            try {
                window.print();
            } catch (err) {
                cleanup();
                throw new Error('Print failed: ' + (err && err.message ? err.message : err));
            }
            return { printed: rendered, title: title };
        });
    }

    function onSave() {
        const sel = tree.querySelector('input[name="pdf-node"]:checked');
        if (!sel) { toast('Choose a section first'); return; }
        printSelection([sel.value], !!includeKids.checked)
            .catch(err => toast(err && err.message ? err.message : 'Print failed'));
    }

    // Programmatic entry point: print an explicit list of section ids (any number;
    // they print in reading order). opts.withChildren (default true) also prints
    // each id's sub-sections. Returns the printSelection promise.
    function printSections(ids, opts) {
        const withChildren = !(opts && typeof opts === 'object' && opts.withChildren === false);
        return printSelection(Array.isArray(ids) ? ids : [], withChildren);
    }

    function cleanup() {
        if (!printing) return;
        printing = false;
        document.documentElement.classList.remove('printing-chapter');
        if (savedTitle !== null) { document.title = savedTitle; savedTitle = null; }
        container.innerHTML = '';
    }

    function onLoaded() {
        const id = pdfIdFromHash(typeof location !== 'undefined' ? location.hash : '');
        if (id === null) return;
        const data = State.getData();
        if (!data) return;
        if (id && !data.nodes[id]) toast('Section "' + id + '" is not in this book — choose one from the list');
        open(id && data.nodes[id] ? id : undefined);
    }

    function init() {
        btn = document.getElementById('pdf-btn');
        modal = document.getElementById('pdf-modal');
        tree = document.getElementById('pdf-tree');
        includeKids = document.getElementById('pdf-include-children');
        saveBtn = document.getElementById('pdf-save-btn');
        container = document.getElementById('print-chapter');
        if (!btn || !modal || !tree || !includeKids || !saveBtn || !container) {
            if (typeof console !== 'undefined') console.warn('PrintChapter: markup missing; PDF export disabled.');
            if (btn) btn.hidden = true;
            return;
        }

        btn.addEventListener('click', () => open());
        saveBtn.addEventListener('click', onSave);
        includeKids.addEventListener('change', updateCounts);
        modal.querySelector('.modal-close').addEventListener('click', close);
        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.classList.contains('modal-backdrop')) close();
        });
        tree.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
        });

        window.addEventListener('afterprint', cleanup);
        // Some Safari versions fire no afterprint; the print media query flipping back does.
        if (window.matchMedia) {
            const mq = window.matchMedia('print');
            const onChange = ev => { if (!ev.matches) cleanup(); };
            if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
            else if (typeof mq.addListener === 'function') mq.addListener(onChange);
        }

        State.on('content-loaded', onLoaded);
    }

    return { init, open, close, isOpen, printSections };
})();

// A top-level `const` is not a window property, so expose the module explicitly:
// the editor drives this reader inside a hidden iframe via window.PrintChapter.
if (typeof window !== 'undefined') window.PrintChapter = PrintChapter;
