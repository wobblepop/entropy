/* ============================================
   STATE — Editor state management
   Content data, selection, dirty tracking, undo
   ============================================ */

const EditorState = (() => {
    let data = null;
    let selectedNodeId = null;
    let dirty = false;
    let fileName = '';
    let fileHandle = null;
    const listeners = {};

    // Undo stack: stores snapshots of the full data
    const undoStack = [];
    const MAX_UNDO = 30;

    function on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
    }

    function emit(event, payload) {
        (listeners[event] || []).forEach(fn => fn(payload));
    }

    function pushUndo() {
        if (!data) return;
        undoStack.push(JSON.stringify(data));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
    }

    function undo() {
        if (undoStack.length === 0) return;
        const snapshot = JSON.parse(undoStack.pop());
        data = snapshot;
        dirty = true;
        emit('dirty-changed', true);
        if (!data.nodes[selectedNodeId]) {
            selectedNodeId = data.root;
        }
        emit('file-loaded', data);
        emit('node-selected', selectedNodeId);
    }

    function canUndo() {
        return undoStack.length > 0;
    }

    function newFile() {
        data = {
            meta: {
                title: 'New Textbook',
                subtitle: '',
                author: '',
                version: '1.0.0',
                created: new Date().toISOString(),
                modified: new Date().toISOString(),
                description: '',
                tags: []
            },
            root: 'intro',
            nodes: {
                'intro': {
                    id: 'intro',
                    title: 'Introduction',
                    summary: '',
                    content: '',
                    children: [],
                    connections: [],
                    media: [],
                    tags: [],
                    order: 1
                }
            },
            themes: {
                default: 'clean',
                available: ['clean', 'academic', 'dark', 'high-contrast']
            }
        };
        selectedNodeId = 'intro';
        dirty = false;
        undoStack.length = 0;
        fileName = 'untitled.entropy.json';
        fileHandle = null;
        emit('file-loaded', data);
        emit('node-selected', selectedNodeId);
    }

    function loadContent(json, name, handle) {
        data = json;
        fileName = name || 'content.entropy.json';
        fileHandle = handle || null;
        selectedNodeId = json.root;
        dirty = false;
        undoStack.length = 0;
        emit('file-loaded', data);
        emit('node-selected', selectedNodeId);
    }

    function getData() { return data; }
    function getFileName() { return fileName; }
    function getFileHandle() { return fileHandle; }
    function setFileHandle(handle) { fileHandle = handle; }
    function isDirty() { return dirty; }
    function getSelectedNodeId() { return selectedNodeId; }

    function getNode(id) {
        return data ? data.nodes[id] : null;
    }

    function getSelectedNode() {
        return data && selectedNodeId ? data.nodes[selectedNodeId] : null;
    }

    function selectNode(id) {
        if (!data || !data.nodes[id]) return;
        selectedNodeId = id;
        emit('node-selected', id);
    }

    function markDirty() {
        if (!dirty) {
            dirty = true;
            emit('dirty-changed', true);
        }
    }

    function markClean() {
        if (dirty) {
            dirty = false;
            emit('dirty-changed', false);
        }
    }

    function updateNode(id, changes) {
        if (!data || !data.nodes[id]) return;
        Object.assign(data.nodes[id], changes);
        data.meta.modified = new Date().toISOString();
        markDirty();
        emit('node-updated', id);
    }

    function updateMeta(changes) {
        if (!data) return;
        Object.assign(data.meta, changes);
        markDirty();
        emit('meta-updated');
    }

    function setRoot(nodeId) {
        if (!data || !data.nodes[nodeId]) return;
        pushUndo();
        data.root = nodeId;
        markDirty();
        emit('meta-updated');
    }

    function addNode(id, title) {
        if (!data) return;
        if (data.nodes[id]) return null;
        pushUndo();
        data.nodes[id] = {
            id: id,
            title: title || 'New Node',
            summary: '',
            content: '',
            children: [],
            connections: [],
            media: [],
            tags: [],
            order: Object.keys(data.nodes).length + 1
        };
        markDirty();
        emit('node-added', id);
        return data.nodes[id];
    }

    function duplicateNode(sourceId) {
        if (!data || !data.nodes[sourceId]) return null;
        const source = data.nodes[sourceId];
        let newId = sourceId + '-copy';
        let counter = 1;
        while (data.nodes[newId]) {
            newId = sourceId + '-copy-' + counter;
            counter++;
        }
        pushUndo();
        data.nodes[newId] = JSON.parse(JSON.stringify(source));
        data.nodes[newId].id = newId;
        data.nodes[newId].title = source.title + ' (copy)';
        markDirty();
        emit('node-added', newId);
        return newId;
    }

    function deleteNode(id) {
        if (!data || !data.nodes[id]) return;
        if (data.root === id) return;
        pushUndo();

        Object.values(data.nodes).forEach(node => {
            node.children = (node.children || []).filter(c => c !== id);
            node.connections = (node.connections || []).filter(c => c.to !== id);
        });

        delete data.nodes[id];
        markDirty();

        if (selectedNodeId === id) {
            selectedNodeId = data.root;
            emit('node-selected', selectedNodeId);
        }
        emit('node-deleted', id);
    }

    function getAllNodeIds() {
        return data ? Object.keys(data.nodes) : [];
    }

    function getExportData() {
        if (!data) return null;
        data.meta.modified = new Date().toISOString();
        return JSON.parse(JSON.stringify(data));
    }

    // Get total word count across all nodes
    function getWordCount(nodeId) {
        if (!data) return 0;
        if (nodeId) {
            const node = data.nodes[nodeId];
            if (!node) return 0;
            const text = (node.title || '') + ' ' + (node.summary || '') + ' ' + (node.content || '');
            return countWords(text);
        }
        let total = 0;
        Object.values(data.nodes).forEach(node => {
            const text = (node.title || '') + ' ' + (node.summary || '') + ' ' + (node.content || '');
            total += countWords(text);
        });
        return total;
    }

    function countWords(text) {
        return text.trim().split(/\s+/).filter(w => w.length > 0).length;
    }

    // Get ordered flat list of all node IDs following the tree structure
    function getLinearOrder() {
        if (!data) return [];
        const order = [];
        const visited = new Set();
        function walk(id) {
            if (visited.has(id) || !data.nodes[id]) return;
            visited.add(id);
            order.push(id);
            (data.nodes[id].children || []).forEach(walk);
        }
        walk(data.root);
        // Append orphans
        Object.keys(data.nodes).forEach(id => {
            if (!visited.has(id)) order.push(id);
        });
        return order;
    }

    return {
        on, emit, newFile, loadContent, getData, getFileName, getFileHandle, setFileHandle, isDirty,
        getSelectedNodeId, getNode, getSelectedNode, selectNode,
        markDirty, markClean, updateNode, updateMeta, setRoot,
        addNode, duplicateNode, deleteNode, getAllNodeIds, getExportData,
        getWordCount, getLinearOrder, undo, canUndo, pushUndo
    };
})();
