/* ============================================
   STATE — Application state management
   Centralized state with event dispatch
   ============================================ */

const State = (() => {
    let data = null;
    let currentNodeId = null;
    let history = [];
    let visited = new Set();
    let theme = localStorage.getItem('entropy-theme') || 'clean';
    let fontSize = parseInt(localStorage.getItem('entropy-font-size')) || 17;
    let lineHeight = parseFloat(localStorage.getItem('entropy-line-height')) || 1.7;
    let contentWidth = parseInt(localStorage.getItem('entropy-content-width')) || 700;
    let sidebarOpen = true;

    const listeners = {};

    function on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
    }

    function emit(event, payload) {
        (listeners[event] || []).forEach(fn => fn(payload));
    }

    function loadContent(json) {
        data = json;
        const savedPos = localStorage.getItem('entropy-position-' + slugify(json.meta.title));
        currentNodeId = (savedPos && json.nodes[savedPos]) ? savedPos : json.root;
        history = [currentNodeId];
        visited = new Set(JSON.parse(localStorage.getItem('entropy-visited-' + slugify(json.meta.title)) || '[]'));
        visited.add(currentNodeId);
        saveVisited();
        emit('content-loaded', data);
        emit('navigate', currentNodeId);
    }

    function navigate(nodeId) {
        if (!data || !data.nodes[nodeId]) return;
        currentNodeId = nodeId;
        history.push(nodeId);
        visited.add(nodeId);
        saveVisited();
        savePosition();
        emit('navigate', nodeId);
    }

    function goBack() {
        if (history.length <= 1) return;
        history.pop();
        currentNodeId = history[history.length - 1];
        savePosition();
        emit('navigate', currentNodeId);
    }

    function goHome() {
        if (!data) return;
        currentNodeId = data.root;
        history = [data.root];
        savePosition();
        emit('navigate', currentNodeId);
    }

    function getCurrentNode() {
        if (!data || !currentNodeId) return null;
        return data.nodes[currentNodeId];
    }

    function getNode(id) {
        if (!data) return null;
        return data.nodes[id];
    }

    function isVisited(id) {
        return visited.has(id);
    }

    // Mark a node visited WITHOUT navigating to it (used by the continuous
    // read-all view as sections scroll past — no history push, no scroll).
    function markVisited(id) {
        if (!data || !data.nodes[id] || visited.has(id)) return;
        visited.add(id);
        saveVisited();
        emit('progress-changed');
    }

    function getCurrentNodeId() {
        return currentNodeId;
    }

    function getProgress() {
        if (!data) return 0;
        const total = Object.keys(data.nodes).length;
        return total > 0 ? visited.size / total : 0;
    }

    function setTheme(t) {
        theme = t;
        localStorage.setItem('entropy-theme', t);
        emit('theme-changed', t);
    }

    function setFontSize(s) {
        fontSize = s;
        localStorage.setItem('entropy-font-size', s);
        emit('settings-changed', { fontSize, lineHeight, contentWidth });
    }

    function setLineHeight(h) {
        lineHeight = h;
        localStorage.setItem('entropy-line-height', h);
        emit('settings-changed', { fontSize, lineHeight, contentWidth });
    }

    function setContentWidth(w) {
        contentWidth = w;
        localStorage.setItem('entropy-content-width', w);
        emit('settings-changed', { fontSize, lineHeight, contentWidth });
    }

    function toggleSidebar() {
        sidebarOpen = !sidebarOpen;
        emit('sidebar-toggled', sidebarOpen);
    }

    function getHistory() {
        return [...history];
    }

    function getData() {
        return data;
    }

    function getTheme() { return theme; }
    function getFontSize() { return fontSize; }
    function getLineHeight() { return lineHeight; }
    function getContentWidth() { return contentWidth; }
    function isSidebarOpen() { return sidebarOpen; }

    function saveVisited() {
        if (!data) return;
        localStorage.setItem('entropy-visited-' + slugify(data.meta.title), JSON.stringify([...visited]));
    }

    function savePosition() {
        if (!data || !currentNodeId) return;
        localStorage.setItem('entropy-position-' + slugify(data.meta.title), currentNodeId);
    }

    function getLinearOrder() {
        if (!data) return [];
        const order = [];
        const seen = new Set();
        function walk(id) {
            if (seen.has(id) || !data.nodes[id]) return;
            seen.add(id);
            order.push(id);
            (data.nodes[id].children || []).forEach(walk);
        }
        walk(data.root);
        Object.keys(data.nodes).forEach(id => { if (!seen.has(id)) order.push(id); });
        return order;
    }

    function getNextNode() {
        const order = getLinearOrder();
        const idx = order.indexOf(currentNodeId);
        return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
    }

    function getPrevNode() {
        const order = getLinearOrder();
        const idx = order.indexOf(currentNodeId);
        return idx > 0 ? order[idx - 1] : null;
    }

    function slugify(text) {
        return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    return {
        on, emit, loadContent, navigate, goBack, goHome,
        getCurrentNode, getCurrentNodeId, getNode, isVisited, markVisited, getProgress,
        setTheme, setFontSize, setLineHeight, setContentWidth,
        toggleSidebar, getHistory, getData,
        getTheme, getFontSize, getLineHeight, getContentWidth, isSidebarOpen,
        getLinearOrder, getNextNode, getPrevNode
    };
})();
