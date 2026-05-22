/* ============================================
   NAVIGATION — Sidebar tree and breadcrumbs
   Builds nav from content, handles search
   ============================================ */

const Navigation = (() => {
    let navTree = null;
    let searchInput = null;

    function init() {
        navTree = document.getElementById('nav-tree');
        searchInput = document.getElementById('nav-search');

        searchInput.addEventListener('input', handleSearch);
        State.on('content-loaded', buildTree);
        State.on('navigate', updateActive);
    }

    function buildTree(data) {
        navTree.innerHTML = '';
        const rootNode = data.nodes[data.root];
        if (!rootNode) return;

        const fragment = document.createDocumentFragment();
        addNodeToTree(fragment, data.root, data, 0);
        navTree.appendChild(fragment);
    }

    function addNodeToTree(parent, nodeId, data, depth) {
        const node = data.nodes[nodeId];
        if (!node) return;

        const li = document.createElement('li');
        li.classList.add('nav-item');
        li.setAttribute('role', 'treeitem');

        const btn = document.createElement('button');
        btn.classList.add('nav-item-btn');
        btn.dataset.nodeId = nodeId;
        btn.setAttribute('aria-label', node.title);

        if (depth > 0) {
            const indent = document.createElement('span');
            indent.classList.add('nav-indent');
            indent.style.width = (depth * 12) + 'px';
            btn.appendChild(indent);
        }

        const dot = document.createElement('span');
        dot.classList.add('nav-dot');
        if (State.isVisited(nodeId)) dot.classList.add('visited');
        btn.appendChild(dot);

        const text = document.createElement('span');
        text.textContent = node.title;
        btn.appendChild(text);

        btn.addEventListener('click', () => State.navigate(nodeId));
        li.appendChild(btn);
        parent.appendChild(li);

        if (node.children && node.children.length > 0) {
            node.children.forEach(childId => {
                addNodeToTree(parent, childId, data, depth + 1);
            });
        }
    }

    function updateActive(nodeId) {
        const buttons = navTree.querySelectorAll('.nav-item-btn');
        buttons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.nodeId === nodeId);
            const dot = btn.querySelector('.nav-dot');
            if (dot && State.isVisited(btn.dataset.nodeId)) dot.classList.add('visited');
        });
        updateBreadcrumb(nodeId);
    }

    function updateBreadcrumb(nodeId) {
        const breadcrumb = document.getElementById('breadcrumb');
        const path = findPath(nodeId);
        breadcrumb.innerHTML = '';

        path.forEach((id, i) => {
            const node = State.getNode(id);
            if (!node) return;

            if (i > 0) {
                const sep = document.createElement('span');
                sep.classList.add('breadcrumb-sep');
                sep.textContent = '/';
                sep.setAttribute('aria-hidden', 'true');
                breadcrumb.appendChild(sep);
            }

            const item = document.createElement('span');
            item.classList.add('breadcrumb-item');
            item.textContent = node.title;
            item.setAttribute('role', 'link');
            item.setAttribute('tabindex', '0');
            item.addEventListener('click', () => State.navigate(id));
            item.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') State.navigate(id);
            });
            breadcrumb.appendChild(item);
        });
    }

    function findPath(targetId) {
        const data = State.getData();
        if (!data) return [targetId];

        const path = [];
        function search(nodeId, currentPath) {
            currentPath.push(nodeId);
            if (nodeId === targetId) {
                path.push(...currentPath);
                return true;
            }
            const node = data.nodes[nodeId];
            if (node && node.children) {
                for (const childId of node.children) {
                    if (search(childId, [...currentPath])) return true;
                }
            }
            return false;
        }
        search(data.root, []);
        return path.length > 0 ? path : [targetId];
    }

    function handleSearch() {
        const query = searchInput.value.toLowerCase().trim();
        const items = navTree.querySelectorAll('.nav-item');

        if (!query) {
            items.forEach(item => item.style.display = '');
            return;
        }

        items.forEach(item => {
            const btn = item.querySelector('.nav-item-btn');
            const text = btn.textContent.toLowerCase();
            item.style.display = text.includes(query) ? '' : 'none';
        });
    }

    return { init };
})();
