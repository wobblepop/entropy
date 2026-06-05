/* ============================================
   RENDERER — Content rendering engine
   Takes node data, produces DOM updates
   ============================================ */

const Renderer = (() => {
    let reader = null;
    let landing = null;

    function onContentLoaded(data) {
        landing.hidden = true;
        reader.hidden = false;
        document.getElementById('book-title').textContent = data.meta.title;
        document.title = `${data.meta.title} — EntropyExplainer`;
    }

    function renderNode(nodeId) {
        // In continuous read-all mode the single-node view is hidden and the
        // ReadingMode module handles scrolling — skip rendering (and its scrollTo).
        if (typeof ReadingMode !== 'undefined' && ReadingMode.isAll && ReadingMode.isAll()) return;
        const node = State.getNode(nodeId);
        if (!node) return;

        const content = document.getElementById('node-content');
        content.classList.remove('fade-in');
        void content.offsetWidth;
        content.classList.add('fade-in');

        renderMeta(node);
        renderTitle(node);
        renderSummary(node);
        renderBody(node);
        renderMedia(node);
        renderChildren(node);
        renderConnections(node);
        updateNav();

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function renderMeta(node) {
        const meta = document.getElementById('node-meta');
        let html = '';

        if (node.difficulty) {
            html += `<span class="difficulty-badge difficulty-${node.difficulty}">${node.difficulty}</span>`;
        }
        if (node.estimatedTime) {
            html += `<span class="time-estimate">${node.estimatedTime}</span>`;
        }
        if (node.tags && node.tags.length) {
            html += node.tags.map(t => `<span class="meta-tag">${t}</span>`).join('');
        }

        meta.innerHTML = html;
    }

    function renderTitle(node) {
        document.getElementById('node-title').textContent = node.title;
    }

    function renderSummary(node) {
        const el = document.getElementById('node-summary');
        if (node.summary) {
            el.textContent = node.summary;
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    function renderBody(node) {
        document.getElementById('node-body').innerHTML =
            Markdown.renderWithFootnotes(node.content, node.id);
    }

    function renderMedia(node) {
        const container = document.getElementById('node-media');
        if (!node.media || node.media.length === 0) {
            container.innerHTML = '';
            container.hidden = true;
            return;
        }
        container.hidden = false;
        container.innerHTML = node.media.map(m => Media.render(m)).join('');
    }

    function renderChildren(node) {
        const section = document.getElementById('children-section');
        const list = document.getElementById('children-list');

        if (!node.children || node.children.length === 0) {
            section.hidden = true;
            return;
        }

        section.hidden = false;
        list.innerHTML = '';

        node.children.forEach(childId => {
            const child = State.getNode(childId);
            if (!child) return;

            const card = document.createElement('div');
            card.classList.add('child-card');
            card.setAttribute('role', 'link');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `Navigate to ${child.title}`);
            if (State.isVisited(childId)) card.dataset.visited = 'true';

            let metaHtml = '';
            if (child.difficulty) {
                metaHtml += `<span class="difficulty-badge difficulty-${child.difficulty}">${child.difficulty}</span>`;
            }
            if (child.estimatedTime) {
                metaHtml += `<span class="time-estimate">${child.estimatedTime}</span>`;
            }

            card.innerHTML = `
                <div class="child-card-title">${Markdown.escapeHtml(child.title)}</div>
                ${child.summary ? `<div class="child-card-summary">${Markdown.escapeHtml(child.summary)}</div>` : ''}
                ${metaHtml ? `<div class="child-card-meta">${metaHtml}</div>` : ''}
            `;

            card.addEventListener('click', () => State.navigate(childId));
            card.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    State.navigate(childId);
                }
            });

            list.appendChild(card);
        });
    }

    function renderConnections(node) {
        const section = document.getElementById('connections-section');
        const list = document.getElementById('connections-list');

        if (!node.connections || node.connections.length === 0) {
            section.hidden = true;
            return;
        }

        section.hidden = false;
        list.innerHTML = '';

        node.connections.forEach(conn => {
            const target = State.getNode(conn.to);
            if (!target) return;

            const link = document.createElement('button');
            link.classList.add('connection-link');
            if (conn.type) link.classList.add(`conn-type-${conn.type}`);
            link.setAttribute('aria-label', `${conn.label || target.title} (${conn.type || 'related'})`);

            let html = '';
            if (conn.type) {
                html += `<span class="connection-type">${conn.type}</span>`;
            }
            html += `<span>${Markdown.escapeHtml(conn.label || target.title)}</span>`;
            link.innerHTML = html;

            link.addEventListener('click', () => State.navigate(conn.to));
            list.appendChild(link);
        });
    }

    function updateNav() {
        const history = State.getHistory();
        document.getElementById('back-btn').disabled = history.length <= 1;

        const prevId = State.getPrevNode();
        const nextId = State.getNextNode();
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');

        prevBtn.disabled = !prevId;
        nextBtn.disabled = !nextId;

        if (prevId) {
            const prevNode = State.getNode(prevId);
            prevBtn.setAttribute('aria-label', `Previous: ${prevNode ? prevNode.title : prevId}`);
        }
        if (nextId) {
            const nextNode = State.getNode(nextId);
            nextBtn.setAttribute('aria-label', `Next: ${nextNode ? nextNode.title : nextId}`);
        }
    }

    function initNavButtons() {
        document.getElementById('prev-btn').addEventListener('click', () => {
            const prevId = State.getPrevNode();
            if (prevId) State.navigate(prevId);
        });
        document.getElementById('next-btn').addEventListener('click', () => {
            const nextId = State.getNextNode();
            if (nextId) State.navigate(nextId);
        });
    }

    function init() {
        reader = document.getElementById('reader');
        landing = document.getElementById('landing');

        State.on('content-loaded', onContentLoaded);
        State.on('navigate', renderNode);
        initNavButtons();
    }

    return { init, renderNode };
})();
