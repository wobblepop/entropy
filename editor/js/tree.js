/* ============================================
   TREE — Node tree panel (left sidebar)
   Nested UL/LI structure with drag-drop reorder,
   collapsible branches, keyboard navigation and
   keyboard reordering.
   ============================================ */

const Tree = (() => {
    let treeContainer = null;
    let searchInput = null;
    let draggedId = null;
    let lastSignature = null;              // titles + structure of the last render
    const collapsed = loadCollapsed();     // node ids whose children are hidden

    function init() {
        treeContainer = document.getElementById('node-tree');
        searchInput = document.getElementById('node-search');

        searchInput.addEventListener('input', handleSearch);

        EditorState.on('file-loaded', () => { lastSignature = null; render(); });
        EditorState.on('node-added', render);
        EditorState.on('node-deleted', render);
        // Content autosave fires node-updated every 400 ms while typing; only titles or
        // structure need a rebuild (the filter and focus would otherwise be lost).
        EditorState.on('node-updated', () => { if (signature() !== lastSignature) render(); });
        EditorState.on('node-selected', highlightActive);
        treeContainer.addEventListener('keydown', onTreeKeydown);
    }

    function signature() {
        const data = EditorState.getData();
        if (!data) return '';
        return data.root + '|' + Object.keys(data.nodes).map(id => {
            const n = data.nodes[id];
            return id + ':' + (n.title || '') + ':' + ((n.children || []).join(','));
        }).join(';');
    }

    function loadCollapsed() {
        try {
            const raw = localStorage.getItem('entropy-editor-tree-collapsed');
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : []);
        } catch (e) { return new Set(); }
    }
    function saveCollapsed() {
        try { localStorage.setItem('entropy-editor-tree-collapsed', JSON.stringify(Array.from(collapsed))); }
        catch (e) { /* storage blocked: the state still holds for this session */ }
    }

    function render() {
        const data = EditorState.getData();
        if (!data) return;
        lastSignature = signature();

        treeContainer.innerHTML = '';
        const rendered = new Set();
        const rootUl = document.createElement('ul');
        rootUl.className = 'tree-list';
        rootUl.setAttribute('role', 'tree');
        rootUl.setAttribute('aria-label', 'Nodes');
        renderNode(rootUl, data.root, data, rendered, true, 1);

        Object.keys(data.nodes).forEach(id => {
            if (!rendered.has(id)) {
                renderNode(rootUl, id, data, rendered, false, 1);
            }
        });

        treeContainer.appendChild(rootUl);
        highlightActive(EditorState.getSelectedNodeId());
        if (searchInput.value.trim()) handleSearch();   // keep the filter after a rebuild
    }

    function renderNode(parentUl, nodeId, data, rendered, isRoot, level) {
        const node = data.nodes[nodeId];
        if (!node || rendered.has(nodeId)) return;
        rendered.add(nodeId);

        const hasChildren = node.children && node.children.length > 0;
        const isCollapsed = hasChildren && collapsed.has(nodeId);

        const li = document.createElement('li');
        li.className = 'tree-node' + (isCollapsed ? ' collapsed' : '');
        li.dataset.nodeId = nodeId;
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-level', String(level));
        li.setAttribute('aria-selected', 'false');
        if (hasChildren) li.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

        const row = document.createElement('div');
        row.className = 'tree-row' + (isRoot ? ' root' : '');
        row.dataset.nodeId = nodeId;
        row.setAttribute('tabindex', '-1');
        row.setAttribute('draggable', isRoot ? 'false' : 'true');

        const icon = document.createElement('span');
        icon.className = 'tree-icon' + (hasChildren ? ' tree-toggle' : '');
        icon.textContent = hasChildren ? (isCollapsed ? '▸' : '▾') : '·';
        if (hasChildren) {
            icon.title = isCollapsed ? 'Expand' : 'Collapse';
            icon.setAttribute('aria-hidden', 'true');
            icon.addEventListener('click', e => {
                e.stopPropagation();
                setCollapsed(nodeId, !collapsed.has(nodeId));
            });
        }

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.title || nodeId;

        row.appendChild(icon);
        row.appendChild(label);

        row.addEventListener('click', e => {
            e.stopPropagation();
            EditorState.selectNode(nodeId);
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
            childUl.setAttribute('role', 'group');

            childUl.addEventListener('dragover', onChildListDragOver);
            childUl.addEventListener('dragleave', onChildListDragLeave);
            childUl.addEventListener('drop', onChildListDrop);

            node.children.forEach(childId => {
                renderNode(childUl, childId, data, rendered, false, level + 1);
            });
            li.appendChild(childUl);
        }

        parentUl.appendChild(li);
    }

    // --- Collapse / expand ---

    function setCollapsed(nodeId, on) {
        if (on) collapsed.add(nodeId); else collapsed.delete(nodeId);
        saveCollapsed();
        const li = treeContainer.querySelector('.tree-node[data-node-id="' + cssEscape(nodeId) + '"]');
        if (!li) return;
        li.classList.toggle('collapsed', on);
        if (li.querySelector(':scope > .tree-children')) li.setAttribute('aria-expanded', on ? 'false' : 'true');
        const icon = li.querySelector(':scope > .tree-row .tree-icon');
        if (icon && icon.classList.contains('tree-toggle')) {
            icon.textContent = on ? '▸' : '▾';
            icon.title = on ? 'Expand' : 'Collapse';
        }
    }

    // Every ancestor of a node is opened so the node can be seen.
    function expandAncestors(nodeId) {
        const li = treeContainer.querySelector('.tree-node[data-node-id="' + cssEscape(nodeId) + '"]');
        let p = li ? li.parentElement : null;
        while (p && p !== treeContainer) {
            if (p.classList.contains('tree-node') && collapsed.has(p.dataset.nodeId)) setCollapsed(p.dataset.nodeId, false);
            p = p.parentElement;
        }
    }

    function cssEscape(s) {
        return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s);
    }

    // --- Keyboard ---

    function visibleRows() {
        return Array.from(treeContainer.querySelectorAll('.tree-row')).filter(r => r.offsetParent !== null);
    }

    function focusRow(row) {
        if (!row) return;
        treeContainer.querySelectorAll('.tree-row').forEach(r => r.setAttribute('tabindex', r === row ? '0' : '-1'));
        row.focus();
    }

    function onTreeKeydown(e) {
        const row = e.target && e.target.closest && e.target.closest('.tree-row');
        if (!row) return;
        const nodeId = row.dataset.nodeId;
        const li = row.closest('.tree-node');
        const rows = visibleRows();
        const i = rows.indexOf(row);
        const hasChildren = !!li.querySelector(':scope > .tree-children');

        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            moveByKeyboard(nodeId, e.key);
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                focusRow(rows[Math.min(i + 1, rows.length - 1)]);
                break;
            case 'ArrowUp':
                e.preventDefault();
                focusRow(rows[Math.max(i - 1, 0)]);
                break;
            case 'Home':
                e.preventDefault();
                focusRow(rows[0]);
                break;
            case 'End':
                e.preventDefault();
                focusRow(rows[rows.length - 1]);
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (hasChildren && collapsed.has(nodeId)) setCollapsed(nodeId, false);
                else if (hasChildren) focusRow(li.querySelector(':scope > .tree-children .tree-row'));
                break;
            case 'ArrowLeft': {
                e.preventDefault();
                if (hasChildren && !collapsed.has(nodeId)) { setCollapsed(nodeId, true); break; }
                const parentLi = li.parentElement && li.parentElement.closest ? li.parentElement.closest('.tree-node') : null;
                if (parentLi) focusRow(parentLi.querySelector(':scope > .tree-row'));
                break;
            }
            case 'Enter':
            case ' ':
                e.preventDefault();
                EditorState.selectNode(nodeId);
                break;
            default:
                break;
        }
    }

    // Alt+Up/Down move a node among its siblings; Alt+Left makes it follow its parent;
    // Alt+Right tucks it under the sibling above. The root never moves.
    function moveByKeyboard(nodeId, key) {
        const data = EditorState.getData();
        if (!data || nodeId === data.root) return;
        const parentId = findParentOf(data, nodeId);
        if (!parentId) return;
        const siblings = data.nodes[parentId].children;
        const idx = siblings.indexOf(nodeId);
        let done = '';
        EditorState.pushUndo();
        if (key === 'ArrowUp' && idx > 0) {
            siblings.splice(idx, 1); siblings.splice(idx - 1, 0, nodeId); done = 'Moved up';
        } else if (key === 'ArrowDown' && idx < siblings.length - 1) {
            siblings.splice(idx, 1); siblings.splice(idx + 1, 0, nodeId); done = 'Moved down';
        } else if (key === 'ArrowLeft' && parentId !== data.root) {
            removeFromAllParents(data, nodeId);
            insertRelativeTo(data, nodeId, parentId, 'after');
            done = 'Moved out, after "' + (data.nodes[parentId].title || parentId) + '"';
        } else if (key === 'ArrowRight' && idx > 0) {
            const newParent = siblings[idx - 1];
            removeFromAllParents(data, nodeId);
            if (!data.nodes[newParent].children) data.nodes[newParent].children = [];
            data.nodes[newParent].children.push(nodeId);
            collapsed.delete(newParent);
            done = 'Moved under "' + (data.nodes[newParent].title || newParent) + '"';
        }
        if (!done) return;
        EditorState.markDirty();
        EditorState.emit('node-updated', nodeId);
        const row = treeContainer.querySelector('.tree-row[data-node-id="' + cssEscape(nodeId) + '"]');
        if (row) focusRow(row);
        NodeEditor.toast(done, 'success');
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

    // The selected row is the tree's single Tab stop, is opened into view, and is
    // scrolled to when it was off-screen (palette, cross-links, graph, duplicate).
    function highlightActive(nodeId) {
        if (nodeId) expandAncestors(nodeId);
        let active = null;
        treeContainer.querySelectorAll('.tree-row').forEach(el => {
            const on = el.dataset.nodeId === nodeId;
            el.classList.toggle('active', on);
            el.setAttribute('tabindex', on ? '0' : '-1');
            const li = el.closest('.tree-node');
            if (li) li.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) active = el;
        });
        if (!active) {
            const first = treeContainer.querySelector('.tree-row');
            if (first) first.setAttribute('tabindex', '0');
            return;
        }
        if (active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
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
