/* ============================================
   READING MODE — continuous "read all" vs single-section "focus"
   - read-all: every section rendered in linear order, scrollable
   - clicking the sidebar / a cross-link scrolls to that section
   - the sidebar highlights the section currently in view
   Owns: #reader-all container, #readmode-btn toggle.
   ============================================ */

const ReadingMode = (() => {
    let mode = localStorage.getItem('entropy-reading-mode') || 'all';
    let readerEl = null, allEl = null, toggleBtn = null;
    let observer = null, built = false, currentData = null, activeId = null;
    const inView = new Map();

    function isAll() { return mode === 'all'; }

    function init() {
        readerEl = document.getElementById('reader');
        allEl = document.getElementById('reader-all');
        toggleBtn = document.getElementById('readmode-btn');

        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => setMode(mode === 'all' ? 'focus' : 'all'));
        }
        State.on('content-loaded', onLoaded);
        State.on('navigate', onNavigate);
        updateToggleUi();
    }

    function onLoaded(data) {
        currentData = data;
        built = false;
        activeId = null;
        inView.clear();
        applyMode();
    }

    function setMode(m) {
        mode = m;
        try { localStorage.setItem('entropy-reading-mode', m); } catch (e) {}
        applyMode();
        if (mode === 'focus') {
            const id = State.getCurrentNodeId();
            if (id) Renderer.renderNode(id);   // refresh the single-section view
        } else {
            const id = State.getCurrentNodeId();
            if (id) scrollToNode(id, 'auto');
        }
    }

    function applyMode() {
        if (!allEl || !readerEl) return;
        if (mode === 'all') {
            ensureBuilt();
            readerEl.hidden = true;
            allEl.hidden = false;
            setupObserver();
        } else {
            allEl.hidden = true;
            readerEl.hidden = false;
            if (observer) { observer.disconnect(); observer = null; }
        }
        document.body.classList.toggle('mode-read-all', mode === 'all');
        updateToggleUi();
    }

    function updateToggleUi() {
        if (!toggleBtn) return;
        toggleBtn.classList.toggle('active', mode === 'all');
        toggleBtn.setAttribute('aria-pressed', mode === 'all' ? 'true' : 'false');
        const label = toggleBtn.querySelector('.readmode-label');
        if (label) label.textContent = mode === 'all' ? 'Read all' : 'Focus';
        toggleBtn.title = mode === 'all'
            ? 'Showing the whole book — click to focus one section at a time'
            : 'Showing one section — click to read the whole book continuously';
    }

    // --- build the continuous document ---

    function computeDepths(data) {
        const depths = {};
        (function walk(id, d) {
            if (depths[id] !== undefined || !data.nodes[id]) return;
            depths[id] = d;
            (data.nodes[id].children || []).forEach(c => walk(c, d + 1));
        })(data.root, 0);
        return depths;
    }

    function esc(s) { return Markdown.escapeHtml(s == null ? '' : String(s)); }

    function metaBadges(node) {
        let h = '';
        if (node.difficulty) h += `<span class="difficulty-badge difficulty-${esc(node.difficulty)}">${esc(node.difficulty)}</span>`;
        if (node.estimatedTime) h += `<span class="time-estimate">${esc(node.estimatedTime)}</span>`;
        if (node.tags && node.tags.length) h += node.tags.map(t => `<span class="meta-tag">${esc(t)}</span>`).join('');
        return h;
    }

    function renderFullNode(node, depth) {
        const data = currentData;
        const media = (node.media && node.media.length)
            ? `<div class="node-media">${node.media.map(Media.render).join('')}</div>` : '';

        const kids = (node.children || []).filter(id => data.nodes[id]);
        const conns = (node.connections || []).filter(c => data.nodes[c.to]);
        let xref = '';
        if (kids.length) {
            xref += `<div class="full-xref-group"><span class="full-xref-label">In this section</span>` +
                kids.map(id => `<a class="full-xref" href="#full-${esc(id)}" data-target="${esc(id)}">${esc(data.nodes[id].title)}</a>`).join('') +
                `</div>`;
        }
        if (conns.length) {
            xref += `<div class="full-xref-group"><span class="full-xref-label">See also</span>` +
                conns.map(c => {
                    const t = data.nodes[c.to];
                    return `<a class="full-xref conn-${esc(c.type || 'related')}" href="#full-${esc(c.to)}" data-target="${esc(c.to)}">${esc(c.label || t.title)}</a>`;
                }).join('') +
                `</div>`;
        }

        return `<section class="full-node depth-${Math.min(depth, 5)}" id="full-${esc(node.id)}" data-node-id="${esc(node.id)}">` +
            (metaBadges(node) ? `<div class="node-meta">${metaBadges(node)}</div>` : '') +
            `<h2 class="full-node-title">${esc(node.title)}</h2>` +
            (node.summary ? `<p class="node-summary">${esc(node.summary)}</p>` : '') +
            `<div class="node-body">${Markdown.renderWithFootnotes(node.content || '', node.id)}</div>` +
            media +
            (xref ? `<div class="full-xref-wrap">${xref}</div>` : '') +
            `</section>`;
    }

    function ensureBuilt() {
        if (built || !currentData || !allEl) return;
        const order = State.getLinearOrder();
        const depths = computeDepths(currentData);
        allEl.innerHTML = order
            .map(id => currentData.nodes[id] ? renderFullNode(currentData.nodes[id], depths[id] || 0) : '')
            .join('');
        built = true;
        bindAnchors();
    }

    function bindAnchors() {
        allEl.querySelectorAll('a.full-xref').forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                const id = a.dataset.target;
                if (id && currentData.nodes[id]) State.navigate(id);
            });
        });
    }

    // --- scrolling & active-section tracking ---

    function scrollToNode(id, behavior) {
        const el = document.getElementById('full-' + id);
        if (el) el.scrollIntoView({ behavior: behavior || 'smooth', block: 'start' });
    }

    function onNavigate(id) {
        if (mode === 'all') scrollToNode(id);
    }

    function setupObserver() {
        if (observer) observer.disconnect();
        inView.clear();
        // active band: a section becomes "current" when its top is 15%-25% down the viewport
        observer = new IntersectionObserver(onIntersect, { root: null, rootMargin: '-15% 0px -75% 0px', threshold: 0 });
        allEl.querySelectorAll('.full-node').forEach(s => observer.observe(s));
    }

    function onIntersect(entries) {
        entries.forEach(e => inView.set(e.target.dataset.nodeId, e.isIntersecting));
        let best = null, bestTop = Infinity;
        inView.forEach((vis, id) => {
            if (!vis) return;
            const el = document.getElementById('full-' + id);
            if (!el) return;
            const top = el.getBoundingClientRect().top;
            if (top < bestTop) { bestTop = top; best = id; }
        });
        if (best) setActive(best);
    }

    function setActive(id) {
        if (id === activeId) return;
        activeId = id;
        document.querySelectorAll('#nav-tree .nav-item-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.nodeId === id);
        });
        const btn = document.querySelector(`#nav-tree .nav-item-btn[data-node-id="${id}"]`);
        if (btn) {
            const dot = btn.querySelector('.nav-dot');
            if (dot) dot.classList.add('visited');
            btn.scrollIntoView({ block: 'nearest' });
        }
        State.markVisited(id);
    }

    return { init, isAll };
})();
