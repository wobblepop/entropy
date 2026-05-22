/* ============================================
   GRAPH — Interactive node relationship map
   Canvas-based with click, hover, tooltips
   ============================================ */

const Graph = (() => {
    let canvas, ctx;
    let positions = {};
    let hoveredNode = null;
    let animFrame = null;

    function init() {
        canvas = document.getElementById('graph-canvas');
        ctx = canvas.getContext('2d');

        EditorState.on('file-loaded', scheduleRender);
        EditorState.on('node-added', scheduleRender);
        EditorState.on('node-deleted', scheduleRender);
        EditorState.on('node-updated', scheduleRender);
        EditorState.on('node-selected', scheduleRender);

        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                if (tab.dataset.tab === 'graph') {
                    setTimeout(scheduleRender, 50);
                }
            });
        });

        canvas.addEventListener('click', handleClick);
        canvas.addEventListener('mousemove', handleHover);
        canvas.addEventListener('mouseleave', () => {
            if (hoveredNode) {
                hoveredNode = null;
                canvas.style.cursor = 'default';
                scheduleRender();
            }
        });

        new ResizeObserver(scheduleRender).observe(document.getElementById('graph-container'));
    }

    function scheduleRender() {
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = requestAnimationFrame(render);
    }

    function render() {
        const data = EditorState.getData();
        if (!data) return;

        const container = document.getElementById('graph-container');
        const rect = container.getBoundingClientRect();
        const w = rect.width || 400;
        const h = Math.max(rect.height - 10, 250);

        canvas.width = w * window.devicePixelRatio;
        canvas.height = h * window.devicePixelRatio;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const nodeIds = Object.keys(data.nodes);
        positions = layoutNodes(nodeIds, data, w, h);

        ctx.clearRect(0, 0, w, h);
        const selectedId = EditorState.getSelectedNodeId();

        // Draw edges first (behind nodes)
        drawEdges(data, nodeIds, selectedId, w, h);
        // Draw nodes on top
        drawNodes(data, nodeIds, selectedId);
    }

    function drawEdges(data, nodeIds, selectedId) {
        nodeIds.forEach(id => {
            const node = data.nodes[id];
            const pos = positions[id];
            if (!pos) return;

            // Children edges (solid, with arrow)
            (node.children || []).forEach(childId => {
                const childPos = positions[childId];
                if (!childPos) return;
                const isActive = id === selectedId || childId === selectedId;
                ctx.beginPath();
                ctx.moveTo(pos.x, pos.y);
                ctx.lineTo(childPos.x, childPos.y);
                ctx.strokeStyle = isActive ? '#60a5fa' : '#3a3a3a';
                ctx.lineWidth = isActive ? 2 : 1;
                ctx.setLineDash([]);
                ctx.stroke();

                // Arrowhead
                drawArrow(pos.x, pos.y, childPos.x, childPos.y, isActive ? '#60a5fa' : '#3a3a3a', 6);
            });

            // Connection edges (dashed, colored by type)
            (node.connections || []).forEach(conn => {
                const targetPos = positions[conn.to];
                if (!targetPos) return;
                const isActive = id === selectedId || conn.to === selectedId;
                const color = connColor(conn.type, isActive);
                ctx.beginPath();
                ctx.moveTo(pos.x, pos.y);
                ctx.lineTo(targetPos.x, targetPos.y);
                ctx.strokeStyle = color;
                ctx.lineWidth = isActive ? 1.5 : 1;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
            });
        });
    }

    function drawArrow(x1, y1, x2, y2, color, size) {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const nodeRadius = 7;
        const tipX = x2 - nodeRadius * Math.cos(angle);
        const tipY = y2 - nodeRadius * Math.sin(angle);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - size * Math.cos(angle - 0.4), tipY - size * Math.sin(angle - 0.4));
        ctx.lineTo(tipX - size * Math.cos(angle + 0.4), tipY - size * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();
    }

    function drawNodes(data, nodeIds, selectedId) {
        nodeIds.forEach(id => {
            const pos = positions[id];
            if (!pos) return;
            const isSelected = id === selectedId;
            const isRoot = id === data.root;
            const isHovered = id === hoveredNode;
            const radius = isRoot ? 9 : isHovered ? 7 : 6;

            // Glow for selected
            if (isSelected) {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(96, 165, 250, 0.2)';
                ctx.fill();
            }

            // Node circle
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
            if (isSelected) {
                ctx.fillStyle = '#60a5fa';
            } else if (isRoot) {
                ctx.fillStyle = '#f59e0b';
            } else if (isHovered) {
                ctx.fillStyle = '#888';
            } else {
                ctx.fillStyle = '#555';
            }
            ctx.fill();

            // Border
            ctx.strokeStyle = isSelected ? '#93c5fd' : isHovered ? '#aaa' : '#444';
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.stroke();

            // Label
            const label = (data.nodes[id].title || id);
            const maxLen = 18;
            const displayLabel = label.length > maxLen ? label.slice(0, maxLen - 1) + '...' : label;
            ctx.fillStyle = isSelected ? '#e0e0e0' : isHovered ? '#ccc' : '#888';
            ctx.font = (isSelected || isHovered) ? 'bold 10px sans-serif' : '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(displayLabel, pos.x, pos.y + radius + 4);
        });
    }

    function connColor(type, active) {
        const colors = {
            related: active ? '#60a5fa' : '#2a4a7a',
            prerequisite: active ? '#f59e0b' : '#6b4c10',
            deeper: active ? '#8b5cf6' : '#4a2d8a',
            example: active ? '#10b981' : '#1a5c3a',
            tangent: active ? '#ec4899' : '#7a1a4a'
        };
        return colors[type] || (active ? '#60a5fa' : '#3a3a3a');
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

        // Orphans get their own row
        const orphans = nodeIds.filter(id => !visited.has(id));
        if (orphans.length) {
            const maxLevel = Math.max(...Object.keys(levels).map(Number)) + 1;
            levels[maxLevel] = orphans;
        }

        const padding = 30;
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

    function handleClick(e) {
        const id = getNodeAt(e);
        if (id) EditorState.selectNode(id);
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

        for (const [id, pos] of Object.entries(positions)) {
            const dx = x - pos.x;
            const dy = y - pos.y;
            if (dx * dx + dy * dy < 144) return id;
        }
        return null;
    }

    return { init };
})();
