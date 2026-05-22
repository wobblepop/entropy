/* ============================================
   GRAPH — Interactive node graph for reader
   Canvas-based with click navigation
   ============================================ */

const ExplainerGraph = (() => {
    let canvas, ctx;
    let positions = {};
    let hoveredNode = null;
    let visible = false;
    let animFrame = null;

    function init() {
        canvas = document.getElementById('explainer-graph-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');

        canvas.addEventListener('click', handleClick);
        canvas.addEventListener('mousemove', handleHover);
        canvas.addEventListener('mouseleave', () => {
            if (hoveredNode) { hoveredNode = null; canvas.style.cursor = 'default'; scheduleRender(); }
        });

        State.on('navigate', () => { if (visible) scheduleRender(); });
        window.addEventListener('resize', () => { if (visible) scheduleRender(); });
    }

    function show() {
        visible = true;
        document.getElementById('graph-view').hidden = false;
        document.getElementById('reader').hidden = true;
        scheduleRender();
    }

    function hide() {
        visible = false;
        document.getElementById('graph-view').hidden = true;
        document.getElementById('reader').hidden = false;
    }

    function toggle() {
        if (visible) hide(); else show();
    }

    function isVisible() { return visible; }

    function scheduleRender() {
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = requestAnimationFrame(render);
    }

    function render() {
        const data = State.getData();
        if (!data || !canvas) return;

        const container = canvas.parentElement;
        const rect = container.getBoundingClientRect();
        const w = rect.width || 800;
        const h = Math.max(rect.height - 40, 400);

        canvas.width = w * window.devicePixelRatio;
        canvas.height = h * window.devicePixelRatio;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const nodeIds = Object.keys(data.nodes);
        positions = layoutNodes(nodeIds, data, w, h);

        ctx.clearRect(0, 0, w, h);

        const currentId = State.getCurrentNode() ? State.getCurrentNode().id : null;

        drawEdges(data, nodeIds, currentId);
        drawNodes(data, nodeIds, currentId);
    }

    function layoutNodes(nodeIds, data, w, h) {
        const pos = {};
        const levels = {};
        const visited = new Set();

        function assignLevel(id, level) {
            if (visited.has(id)) return;
            visited.add(id);
            if (!levels[level]) levels[level] = [];
            levels[level].push(id);
            const node = data.nodes[id];
            if (node && node.children) {
                node.children.forEach(cid => assignLevel(cid, level + 1));
            }
        }

        assignLevel(data.root, 0);

        const orphans = nodeIds.filter(id => !visited.has(id));
        if (orphans.length) {
            const maxLevel = Math.max(...Object.keys(levels).map(Number)) + 1;
            levels[maxLevel] = orphans;
        }

        const padding = 40;
        const levelCount = Object.keys(levels).length;
        const levelHeight = (h - padding * 2) / Math.max(levelCount - 1, 1);

        Object.entries(levels).forEach(([level, ids]) => {
            const y = padding + parseInt(level) * levelHeight;
            const spacing = (w - padding * 2) / (ids.length + 1);
            ids.forEach((id, i) => {
                pos[id] = { x: padding + spacing * (i + 1), y };
            });
        });

        return pos;
    }

    function drawEdges(data, nodeIds, currentId) {
        nodeIds.forEach(id => {
            const node = data.nodes[id];
            const pos = positions[id];
            if (!pos) return;

            (node.children || []).forEach(childId => {
                const cp = positions[childId];
                if (!cp) return;
                const active = id === currentId || childId === currentId;
                ctx.beginPath();
                ctx.moveTo(pos.x, pos.y);
                ctx.lineTo(cp.x, cp.y);
                ctx.strokeStyle = active ? '#2563eb' : '#ccc';
                ctx.lineWidth = active ? 2 : 1;
                ctx.setLineDash([]);
                ctx.stroke();

                const angle = Math.atan2(cp.y - pos.y, cp.x - pos.x);
                const r = 8;
                const tx = cp.x - r * Math.cos(angle);
                const ty = cp.y - r * Math.sin(angle);
                ctx.fillStyle = ctx.strokeStyle;
                ctx.beginPath();
                ctx.moveTo(tx, ty);
                ctx.lineTo(tx - 6 * Math.cos(angle - 0.4), ty - 6 * Math.sin(angle - 0.4));
                ctx.lineTo(tx - 6 * Math.cos(angle + 0.4), ty - 6 * Math.sin(angle + 0.4));
                ctx.fill();
            });

            (node.connections || []).forEach(conn => {
                const tp = positions[conn.to];
                if (!tp) return;
                const active = id === currentId || conn.to === currentId;
                ctx.beginPath();
                ctx.moveTo(pos.x, pos.y);
                ctx.lineTo(tp.x, tp.y);
                ctx.strokeStyle = active ? connColor(conn.type) : '#ddd';
                ctx.lineWidth = active ? 1.5 : 0.8;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
            });
        });
    }

    function drawNodes(data, nodeIds, currentId) {
        nodeIds.forEach(id => {
            const pos = positions[id];
            if (!pos) return;
            const isCurrent = id === currentId;
            const isRoot = id === data.root;
            const isHover = id === hoveredNode;
            const isVisited = State.isVisited(id);
            const radius = isRoot ? 10 : isHover ? 8 : 7;

            if (isCurrent) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius + 5, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
            if (isCurrent) ctx.fillStyle = '#2563eb';
            else if (isRoot) ctx.fillStyle = '#f59e0b';
            else if (isHover) ctx.fillStyle = '#666';
            else if (isVisited) ctx.fillStyle = '#60a5fa';
            else ctx.fillStyle = '#ccc';
            ctx.fill();

            ctx.strokeStyle = isCurrent ? '#1d4ed8' : isHover ? '#888' : '#ddd';
            ctx.lineWidth = isCurrent ? 2 : 1;
            ctx.stroke();

            const label = (data.nodes[id].title || id);
            const maxLen = 20;
            const displayLabel = label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;
            ctx.fillStyle = isCurrent ? '#1a1a1a' : isHover ? '#333' : '#666';
            ctx.font = (isCurrent || isHover) ? 'bold 11px sans-serif' : '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(displayLabel, pos.x, pos.y + radius + 4);
        });
    }

    function connColor(type) {
        const map = { related: '#2563eb', prerequisite: '#d97706', deeper: '#7c3aed', example: '#059669', tangent: '#db2777' };
        return map[type] || '#2563eb';
    }

    function handleClick(e) {
        const id = getNodeAt(e);
        if (id) State.navigate(id);
    }

    function handleHover(e) {
        const id = getNodeAt(e);
        if (id !== hoveredNode) {
            hoveredNode = id;
            canvas.style.cursor = id ? 'pointer' : 'default';
            scheduleRender();
        }
    }

    function getNodeAt(e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        for (const [id, p] of Object.entries(positions)) {
            const dx = x - p.x, dy = y - p.y;
            if (dx * dx + dy * dy < 144) return id;
        }
        return null;
    }

    return { init, show, hide, toggle, isVisible };
})();
