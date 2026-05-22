/* ============================================
   TREE — Node tree panel (left sidebar)
   Nested UL/LI structure with drag-drop reorder
   ============================================ */

const Tree = (() => {
    let treeContainer = null;
    let searchInput = null;
    let draggedId = null;

    function init() {
        treeContainer = document.getElementById('node-tree');
        searchInput = document.getElementById('node-search');

        searchInput.addEventListener('input', handleSearch);

        EditorState.on('file-loaded', render);
        EditorState.on('node-added', render);
        EditorState.on('node-deleted', render);
        EditorState.on('node-updated', render);
        EditorState.on('node-selected', highlightActive);
    }

    function render() {
        const data = EditorState.getData();
        if (!data) return;

        treeContainer.innerHTML = '';
        const rendered = new Set();
        const rootUl = document.createElement('ul');
        rootUl.className = 'tree-list';
        rootUl.setAttribute('role', 'tree');
        renderNode(rootUl, data.root, data, rendered, true);

        Object.keys(data.nodes).forEach(id => {
            if (!rendered.has(id)) {
                renderNode(rootUl, id, data, rendered, false);
            }
        });

        treeContainer.appendChild(rootUl);
        highlightActive(EditorState.getSelectedNodeId());
    }

    function renderNode(parentUl, nodeId, data, rendered, isRoot) {
        const node = data.nodes[nodeId];
        if (!node || rendered.has(nodeId)) return;
        rendered.add(nodeId);

        const li = document.createElement('li');
        li.className = 'tree-node';
        li.dataset.nodeId = nodeId;

        const row = document.createElement('div');
        row.className = 'tree-row' + (isRoot ? ' root' : '');
        row.dataset.nodeId = nodeId;
        row.setAttribute('tabindex', '0');
        row.setAttribute('draggable', isRoot ? 'false' : 'true');

        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        const hasChildren = node.children && node.children.length > 0;
        icon.textContent = hasChildren ? '▸' : '·';

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.title || nodeId;

        row.appendChild(icon);
        row.appendChild(label);

        row.addEventListener('click', e => {
            e.stopPropagation();
            EditorState.selectNode(nodeId);
        });
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                EditorState.selectNode(nodeId);
            }
        });

        if (!isRoot) {
            row.addEventListener('dragstart', onDragStart);
            row.addEventListener('dragend', onDragEnd);
        }
        row.addEventListener('dragover', onDragOver);
        row.addEventListener('dragleave', onDragLeave);
        row.addEventListener('drop', onDrop);

        li.appendChild(row);

        if (hasChildren) {
            const childUl = document.createElement('ul');
            childUl.className = 'tree-children';
            childUl.dataset.parentId = nodeId;

            childUl.addEventListener('dragover', onChildListDragOver);
            childUl.addEventListener('dragleave', onChildListDragLeave);
            childUl.addEventListener('drop', onChildListDrop);

            node.children.forEach(childId => {
                renderNode(childUl, childId, data, rendered, false);
            });
            li.appendChild(childUl);
        }

        parentUl.appendChild(li);
    }

    // --- Drag and drop ---

    function onDragStart(e) {
        const row = e.target.closest('.tree-row');
        if (!row) return;
        draggedId = row.dataset.nodeId;
        row.closest('.tree-node').classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
    }

    function onDragEnd() {
        draggedId = null;
        treeContainer.querySelectorAll('.dragging, .drag-above, .drag-below, .drag-into, .drag-end').forEach(el => {
            el.classList.remove('dragging', 'drag-above', 'drag-below', 'drag-into', 'drag-end');
        });
    }

    function onDragOver(e) {
        if (!draggedId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        const row = e.target.closest('.tree-row');
        if (!row || row.dataset.nodeId === draggedId) return;

        clearDropIndicators();

        const rect = row.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const ratio = y / rect.height;

        if (ratio < 0.25) {
            row.classList.add('drag-above');
        } else if (ratio > 0.75) {
            row.classList.add('drag-below');
        } else {
            row.classList.add('drag-into');
        }
    }

    function onDragLeave(e) {
        const row = e.target.closest('.tree-row');
        if (row) row.classList.remove('drag-above', 'drag-below', 'drag-into');
    }

    function onDrop(e) {
        if (!draggedId) return;
        e.preventDefault();
        e.stopPropagation();

        const row = e.target.closest('.tree-row');
        if (!row) return;
        const targetId = row.dataset.nodeId;
        if (targetId === draggedId) return;

        const data = EditorState.getData();
        if (isDescendant(data, draggedId, targetId)) return;

        const rect = row.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const ratio = y / rect.height;

        EditorState.pushUndo();
        removeFromAllParents(data, draggedId);

        if (ratio < 0.25) {
            insertRelativeTo(data, draggedId, targetId, 'before');
        } else if (ratio > 0.75) {
            insertRelativeTo(data, draggedId, targetId, 'after');
        } else {
            if (!data.nodes[targetId].children) data.nodes[targetId].children = [];
            data.nodes[targetId].children.push(draggedId);
        }

        EditorState.markDirty();
        EditorState.emit('node-updated', draggedId);
        clearDropIndicators();
    }

    function onChildListDragOver(e) {
        if (!draggedId) return;
        const childUl = e.target.closest('.tree-children');
        if (!childUl) return;
        if (e.target.closest('.tree-row')) return;

        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        clearDropIndicators();
        childUl.classList.add('drag-end');
    }

    function onChildListDragLeave(e) {
        const childUl = e.target.closest('.tree-children');
        if (childUl) childUl.classList.remove('drag-end');
    }

    function onChildListDrop(e) {
        if (!draggedId) return;
        const childUl = e.target.closest('.tree-children');
        if (!childUl) return;
        if (e.target.closest('.tree-row')) return;

        e.preventDefault();
        e.stopPropagation();

        const parentId = childUl.dataset.parentId;
        const data = EditorState.getData();
        if (isDescendant(data, draggedId, parentId)) return;

        EditorState.pushUndo();
        removeFromAllParents(data, draggedId);
        if (!data.nodes[parentId].children) data.nodes[parentId].children = [];
        data.nodes[parentId].children.push(draggedId);
        EditorState.markDirty();
        EditorState.emit('node-updated', draggedId);
        clearDropIndicators();
    }

    // --- Helpers ---

    function clearDropIndicators() {
        treeContainer.querySelectorAll('.drag-above, .drag-below, .drag-into, .drag-end').forEach(el => {
            el.classList.remove('drag-above', 'drag-below', 'drag-into', 'drag-end');
        });
    }

    function isDescendant(data, ancestorId, checkId) {
        const node = data.nodes[ancestorId];
        if (!node || !node.children) return false;
        for (const childId of node.children) {
            if (childId === checkId) return true;
            if (isDescendant(data, childId, checkId)) return true;
        }
        return false;
    }

    function removeFromAllParents(data, nodeId) {
        Object.values(data.nodes).forEach(node => {
            if (node.children) {
                const idx = node.children.indexOf(nodeId);
                if (idx !== -1) node.children.splice(idx, 1);
            }
        });
    }

    function findParentOf(data, nodeId) {
        for (const [id, node] of Object.entries(data.nodes)) {
            if (node.children && node.children.includes(nodeId)) return id;
        }
        return null;
    }

    function insertRelativeTo(data, draggedId, targetId, position) {
        const parentId = findParentOf(data, targetId);

        if (parentId) {
            const parent = data.nodes[parentId];
            const idx = parent.children.indexOf(targetId);
            parent.children.splice(position === 'before' ? idx : idx + 1, 0, draggedId);
        } else if (targetId === data.root) {
            const root = data.nodes[data.root];
            if (!root.children) root.children = [];
            if (position === 'before') {
                root.children.unshift(draggedId);
            } else {
                root.children.push(draggedId);
            }
        }
    }

    // --- Selection & search ---

    function highlightActive(nodeId) {
        treeContainer.querySelectorAll('.tree-row').forEach(el => {
            el.classList.toggle('active', el.dataset.nodeId === nodeId);
        });
    }

    function handleSearch() {
        const query = searchInput.value.toLowerCase().trim();
        treeContainer.querySelectorAll('.tree-node').forEach(el => {
            if (!query) {
                el.style.display = '';
                return;
            }
            const label = el.querySelector(':scope > .tree-row .tree-label');
            if (label) {
                el.style.display = label.textContent.toLowerCase().includes(query) ? '' : 'none';
            }
        });
    }

    return { init, render };
})();
