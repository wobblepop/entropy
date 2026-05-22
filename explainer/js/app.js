/* ============================================
   APP — Main entry point, file loading, glue
   Initializes all modules, handles file I/O
   ============================================ */

const App = (() => {
    function init() {
        Navigation.init();
        Renderer.init();
        Themes.init();
        Accessibility.init();
        ExplainerGraph.init();
        setupFileLoading();
        setupNavButtons();
        setupSidebar();
        setupDragDrop();
        setupProgress();
        setupGraphToggle();
        setupExportPdf();
        setupStandaloneExport();
    }

    function setupFileLoading() {
        const input = document.getElementById('file-input');
        input.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) loadFile(file);
        });
    }

    function loadFile(file) {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.nodes || !data.root || !data.meta) {
                    showToast('Invalid file: missing required fields (nodes, root, meta)');
                    return;
                }
                State.loadContent(data);
            } catch (err) {
                showToast('Error parsing file: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    function setupNavButtons() {
        document.getElementById('back-btn').addEventListener('click', () => State.goBack());
        document.getElementById('home-btn').addEventListener('click', () => State.goHome());
    }

    function setupSidebar() {
        const sidebar = document.getElementById('sidebar');
        const content = document.getElementById('main-content');
        const toggle = document.getElementById('sidebar-toggle');

        toggle.addEventListener('click', () => State.toggleSidebar());

        State.on('sidebar-toggled', open => {
            sidebar.classList.toggle('collapsed', !open);
            sidebar.classList.toggle('open', open);
            content.classList.toggle('full-width', !open);
            toggle.setAttribute('aria-expanded', open);
        });
    }

    function setupDragDrop() {
        const overlay = document.createElement('div');
        overlay.classList.add('drag-overlay');
        overlay.innerHTML = '<span class="drag-overlay-text">Drop .entropy.json file here</span>';
        document.body.appendChild(overlay);

        let dragCounter = 0;

        document.addEventListener('dragenter', e => {
            e.preventDefault();
            dragCounter++;
            overlay.classList.add('visible');
        });

        document.addEventListener('dragleave', e => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                overlay.classList.remove('visible');
            }
        });

        document.addEventListener('dragover', e => {
            e.preventDefault();
        });

        document.addEventListener('drop', e => {
            e.preventDefault();
            dragCounter = 0;
            overlay.classList.remove('visible');

            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.json')) {
                loadFile(file);
            } else {
                showToast('Please drop a .entropy.json file');
            }
        });
    }

    function setupProgress() {
        State.on('navigate', () => {
            const progress = State.getProgress();
            const arc = document.getElementById('progress-arc');
            const angle = progress * 360;
            const rad = angle * Math.PI / 180;
            const x = 10 + 8 * Math.sin(rad);
            const y = 10 - 8 * Math.cos(rad);
            const largeArc = angle > 180 ? 1 : 0;

            if (angle === 0) {
                arc.setAttribute('d', '');
            } else if (angle >= 360) {
                arc.setAttribute('d', 'M10 2 A8 8 0 1 1 9.99 2');
            } else {
                arc.setAttribute('d', `M10 2 A8 8 0 ${largeArc} 1 ${x} ${y}`);
            }

            const data = State.getData();
            if (!data) return;
            const totalNodes = Object.keys(data.nodes).length;
            document.getElementById('progress-btn').title =
                `Progress: ${Math.round(progress * 100)}% (${Math.round(progress * totalNodes)}/${totalNodes} sections)`;
        });
    }

    function setupExportPdf() {
        const btn = document.getElementById('export-pdf-btn');
        if (!btn) return;
        btn.addEventListener('click', exportPdf);
    }

    function exportPdf() {
        const data = State.getData();
        if (!data) { showToast('Load a file first'); return; }
        showToast('Generating PDF…');
        loadJsPdf().then(() => {
            try { generatePdf(data); }
            catch (err) { showToast('PDF error: ' + err.message); }
        }).catch(() => showToast('Failed to load PDF library'));
    }

    function loadJsPdf() {
        if (window.jspdf) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    function generatePdf(data) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'letter' });
        const ML = 54, MR = 54, MT = 54, MB = 54;
        const PW = doc.internal.pageSize.getWidth();
        const PH = doc.internal.pageSize.getHeight();
        const CW = PW - ML - MR;
        let y = MT;

        function need(h) { if (y + h > PH - MB) { doc.addPage(); y = MT; } }

        // --- Cover page ---
        y = PH * 0.3;
        doc.setFontSize(26); doc.setFont('times', 'bold');
        doc.splitTextToSize(data.meta.title, CW).forEach(l => {
            doc.text(l, PW / 2, y, { align: 'center' }); y += 32;
        });
        if (data.meta.subtitle) {
            y += 8; doc.setFontSize(14); doc.setFont('times', 'normal');
            doc.text(data.meta.subtitle, PW / 2, y, { align: 'center' }); y += 20;
        }
        if (data.meta.author) {
            y += 12; doc.setFontSize(12); doc.setFont('times', 'italic');
            doc.text(data.meta.author, PW / 2, y, { align: 'center' }); y += 18;
        }
        if (data.meta.description) {
            y += 24; doc.setFontSize(10); doc.setFont('times', 'normal');
            doc.splitTextToSize(data.meta.description, CW - 100).forEach(l => {
                doc.text(l, PW / 2, y, { align: 'center' }); y += 14;
            });
        }

        // --- Depth map ---
        const order = State.getLinearOrder();
        const depths = {};
        (function walk(id, d) {
            if (depths[id] !== undefined) return;
            depths[id] = d;
            const n = data.nodes[id];
            if (n && n.children) n.children.forEach(c => walk(c, d + 1));
        })(data.root, 0);

        // --- Table of contents ---
        doc.addPage(); y = MT;
        doc.setFontSize(18); doc.setFont('times', 'bold');
        doc.text('Table of Contents', ML, y); y += 28;

        order.forEach(id => {
            const n = data.nodes[id]; if (!n) return;
            const d = depths[id] || 0;
            need(14);
            doc.setFontSize(d === 0 ? 11 : 10);
            doc.setFont('times', d === 0 ? 'bold' : 'normal');
            const t = n.title.length > 70 ? n.title.slice(0, 67) + '…' : n.title;
            doc.text(t, ML + d * 16, y);
            y += d === 0 ? 16 : 13;
        });

        // --- Content ---
        doc.addPage(); y = MT;

        order.forEach(id => {
            const node = data.nodes[id]; if (!node) return;
            const d = depths[id] || 0;
            const indent = Math.min(d, 3) * 16;
            const hSz = [17, 14, 12, 11][Math.min(d, 3)];

            need(hSz * 2 + 8);
            if (d === 0 && y > MT + 10) {
                y += 8; doc.setDrawColor(0); doc.setLineWidth(0.5);
                doc.line(ML, y, ML + CW, y); y += 12;
            } else { y += 6; }

            doc.setFontSize(hSz); doc.setFont('times', 'bold');
            doc.splitTextToSize(node.title, CW - indent).forEach(l => {
                need(hSz * 1.4); doc.text(l, ML + indent, y); y += hSz * 1.4;
            });

            if (node.difficulty || node.estimatedTime) {
                doc.setFontSize(8); doc.setFont('helvetica', 'normal');
                doc.text([node.difficulty, node.estimatedTime].filter(Boolean).join(' • ').toUpperCase(), ML + indent, y);
                y += 12;
            }
            if (node.summary) {
                doc.setFontSize(10); doc.setFont('times', 'italic');
                doc.splitTextToSize(node.summary, CW - indent).forEach(l => {
                    need(14); doc.text(l, ML + indent, y); y += 14;
                });
                y += 4;
            }
            if (node.content) renderMd(node.content, indent);
            if (node.connections && node.connections.length) {
                y += 4; doc.setFontSize(9); doc.setFont('times', 'italic');
                const ct = 'See also: ' + node.connections.map(c => {
                    const t = data.nodes[c.to]; return c.label || (t ? t.title : c.to);
                }).join(', ');
                doc.splitTextToSize(ct, CW - indent).forEach(l => {
                    need(13); doc.text(l, ML + indent, y); y += 13;
                });
            }
            y += 8;
        });

        // --- Page numbers ---
        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i); doc.setFontSize(9); doc.setFont('times', 'normal');
            doc.text(String(i), PW / 2, PH - 30, { align: 'center' });
        }

        const safeName = (data.meta.title || 'export').replace(/[^a-zA-Z0-9 _-]/g, '');
        doc.save(safeName + '.pdf');
        showToast('PDF downloaded');

        // --- Markdown block renderer ---
        function renderMd(md, baseIndent) {
            const lines = md.split('\n');
            let inCode = false, inExample = false, bqBuf = [];

            function flushBq() {
                if (!bqBuf.length) return;
                const qi = baseIndent + 14;
                const sy = y;
                bqBuf.forEach(bql => {
                    doc.setFontSize(10.5); doc.setFont('times', 'italic');
                    doc.splitTextToSize(stripInline(bql), CW - qi - 4).forEach(wl => {
                        need(14); doc.text(wl, ML + qi, y); y += 14;
                    });
                });
                doc.setDrawColor(100); doc.setLineWidth(1.5);
                doc.line(ML + baseIndent + 8, sy - 10, ML + baseIndent + 8, y - 4);
                y += 4; bqBuf = [];
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                if (line.startsWith('```')) {
                    if (bqBuf.length) flushBq();
                    inCode = !inCode;
                    if (!inCode) y += 4;
                    continue;
                }
                if (inCode) {
                    need(11); doc.setFontSize(8.5); doc.setFont('courier', 'normal');
                    doc.text(line || ' ', ML + baseIndent + 8, y); y += 11;
                    continue;
                }
                if (line.match(/^:::example\s*$/i)) {
                    if (bqBuf.length) flushBq();
                    inExample = true; need(14);
                    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold');
                    doc.text('EXAMPLE', ML + baseIndent + 10, y); y += 12;
                    continue;
                }
                if (inExample && line.match(/^:::\s*$/)) { inExample = false; y += 6; continue; }
                if (inExample) { const t = line.trim(); if (t) richPara(t, 10.5, baseIndent + 10); continue; }

                if (line.startsWith('> ') || line === '>') {
                    bqBuf.push(line.replace(/^>\s?/, '').trim()); continue;
                }
                if (bqBuf.length) flushBq();

                const trimmed = line.trim();
                if (!trimmed) continue;

                const hm = trimmed.match(/^(#{1,3})\s+(.+)/);
                if (hm) {
                    const sz = [13, 12, 11][Math.min(hm[1].length - 1, 2)];
                    need(sz * 2); doc.setFontSize(sz); doc.setFont('times', 'bold');
                    doc.splitTextToSize(stripInline(hm[2]), CW - baseIndent).forEach(l => {
                        need(sz * 1.4); doc.text(l, ML + baseIndent, y); y += sz * 1.4;
                    });
                    y += 2; continue;
                }
                if (trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
                    y += 6; doc.setDrawColor(180); doc.setLineWidth(0.5);
                    doc.line(ML + baseIndent, y, ML + CW, y); y += 10; continue;
                }
                if (trimmed.match(/^[-*+]\s/)) {
                    const text = trimmed.replace(/^[-*+]\s+/, '');
                    need(15); doc.setFontSize(11); doc.setFont('times', 'normal');
                    doc.text('•', ML + baseIndent + 10, y);
                    richPara(text, 11, baseIndent + 22); continue;
                }
                const olm = trimmed.match(/^(\d+)\.\s+(.+)/);
                if (olm) {
                    need(15); doc.setFontSize(11); doc.setFont('times', 'normal');
                    doc.text(olm[1] + '.', ML + baseIndent + 10, y);
                    richPara(olm[2], 11, baseIndent + 26); continue;
                }
                richPara(trimmed, 11, baseIndent);
            }
            if (bqBuf.length) flushBq();
        }

        // --- Inline-formatted paragraph ---
        function richPara(text, fontSize, indent) {
            renderSegs(parseSegs(text), fontSize, indent);
            y += 4;
        }

        function parseSegs(text) {
            text = text.replace(/\[(.+?)\]\(.+?\)/g, '$1');
            const segs = [];
            const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
            let last = 0, m;
            while ((m = re.exec(text)) !== null) {
                if (m.index > last) segs.push({ t: text.slice(last, m.index), s: 'normal' });
                if (m[2]) segs.push({ t: m[2], s: 'bold' });
                else if (m[3]) segs.push({ t: m[3], s: 'italic' });
                else if (m[4]) segs.push({ t: m[4], s: 'code' });
                last = re.lastIndex;
            }
            if (last < text.length) segs.push({ t: text.slice(last), s: 'normal' });
            return segs;
        }

        function renderSegs(segs, fontSize, indent) {
            const x0 = ML + indent;
            const maxX = ML + CW;
            let cx = x0;
            const lh = fontSize * 1.5;
            need(lh);

            segs.forEach(seg => {
                if (seg.s === 'code') {
                    doc.setFont('courier', 'normal'); doc.setFontSize(fontSize * 0.9);
                } else {
                    doc.setFont('times', seg.s); doc.setFontSize(fontSize);
                }
                const words = seg.t.split(' ');
                for (let i = 0; i < words.length; i++) {
                    const w = words[i]; if (!w) continue;
                    const ww = doc.getTextWidth(w);
                    const sw = cx > x0 ? doc.getTextWidth(' ') : 0;
                    if (cx + sw + ww > maxX && cx > x0) {
                        y += lh; need(lh); cx = x0;
                        doc.text(w, cx, y); cx += ww;
                    } else {
                        doc.text(w, cx + sw, y); cx += sw + ww;
                    }
                }
            });
            y += lh;
        }

        function stripInline(text) {
            return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
                .replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\(.+?\)/g, '$1');
        }
    }

    function setupStandaloneExport() {
        const btn = document.getElementById('standalone-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const data = State.getData();
            if (!data) { showToast('Load a file first'); return; }
            showToast('Building standalone file…');
            try {
                Standalone.exportToHtml(data, showToast);
            } catch (err) {
                showToast('Export failed: ' + err.message);
            }
        });
    }

    function setupGraphToggle() {
        const btn = document.getElementById('graph-toggle-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            ExplainerGraph.toggle();
            btn.classList.toggle('active', ExplainerGraph.isVisible());
        });
    }

    function showToast(message) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.classList.add('toast');
        toast.textContent = message;
        toast.setAttribute('role', 'alert');
        document.body.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    document.addEventListener('DOMContentLoaded', init);

    return { loadFile, showToast };
})();
