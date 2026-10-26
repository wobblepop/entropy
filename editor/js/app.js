/* ============================================
   APP — Editor entry point
   File I/O, keyboard shortcuts, modals, init
   ============================================ */

const App = (() => {
    function init() {
        Tree.init();
        NodeEditor.init();
        Palette.init();
        Graph.init();
        PdfExport.init();
        setupFileIO();
        setupKeyboard();
        setupTabs();
        setupModals();
        setupResize();
        setupDirtyIndicator();
        setupMeta();
        setupAutosave();
    }

    function confirmUnsavedChanges(onDiscard) {
        if (!EditorState.isDirty()) { onDiscard(); return; }
        const modal = document.getElementById('unsaved-modal');
        openModal(modal, document.getElementById('unsaved-save'));

        const cleanup = () => {
            closeModal(modal);
            saveBtn.removeEventListener('click', handleSave);
            discardBtn.removeEventListener('click', handleDiscard);
            cancelBtn.removeEventListener('click', handleCancel);
        };

        const saveBtn = document.getElementById('unsaved-save');
        const discardBtn = document.getElementById('unsaved-discard');
        const cancelBtn = document.getElementById('unsaved-cancel');

        const handleSave = async () => { cleanup(); await saveFile(); onDiscard(); };
        const handleDiscard = () => { cleanup(); onDiscard(); };
        const handleCancel = () => { cleanup(); };

        saveBtn.addEventListener('click', handleSave);
        discardBtn.addEventListener('click', handleDiscard);
        cancelBtn.addEventListener('click', handleCancel);
    }

    async function openFile() {
        const fileInput = document.getElementById('file-open-input');
        if (window.showOpenFilePicker) {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{ description: 'Entropy JSON', accept: { 'application/json': ['.json'] } }]
                });
                const file = await handle.getFile();
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.nodes || !data.root || !data.meta) {
                    NodeEditor.toast('Invalid file format — needs nodes, root, and meta', 'error');
                    return;
                }
                EditorState.loadContent(data, file.name, handle);
                NodeEditor.toast('Loaded: ' + file.name, 'success');
            } catch (err) {
                if (err.name === 'AbortError') return;
                NodeEditor.toast('Error: ' + err.message, 'error');
            }
        } else {
            fileInput.click();
        }
    }

    function setupFileIO() {
        const fileInput = document.getElementById('file-open-input');

        document.getElementById('btn-new').addEventListener('click', () => {
            confirmUnsavedChanges(() => EditorState.newFile());
        });

        document.getElementById('btn-open').addEventListener('click', () => {
            confirmUnsavedChanges(() => openFile());
        });

        document.getElementById('btn-save').addEventListener('click', () => saveFile());
        document.getElementById('btn-save-as').addEventListener('click', () => saveFileAs());
        document.getElementById('btn-add-node').addEventListener('click', showNewNodeModal);
        document.getElementById('btn-preview').addEventListener('click', openPreview);

        fileInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (!data.nodes || !data.root || !data.meta) {
                        NodeEditor.toast('Invalid file format — needs nodes, root, and meta', 'error');
                        return;
                    }
                    EditorState.loadContent(data, file.name);
                    NodeEditor.toast('Loaded: ' + file.name, 'success');
                } catch (err) {
                    NodeEditor.toast('Parse error: ' + err.message, 'error');
                }
            };
            reader.readAsText(file);
            fileInput.value = '';
        });

        // Drag and drop (file loading only — ignore tree DnD)
        document.addEventListener('dragover', e => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        });
        document.addEventListener('drop', e => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.json')) {
                const reader = new FileReader();
                reader.onload = ev => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        if (!data.nodes || !data.root || !data.meta) {
                            NodeEditor.toast('Invalid file format — needs nodes, root, and meta', 'error');
                            return;
                        }
                        EditorState.loadContent(data, file.name);
                        NodeEditor.toast('Loaded: ' + file.name, 'success');
                    } catch (err) {
                        NodeEditor.toast('Parse error: ' + err.message, 'error');
                    }
                };
                reader.readAsText(file);
            }
        });
    }

    function setupKeyboard() {
        document.addEventListener('keydown', e => {
            const key = (e.key || '').toLowerCase();   // Caps Lock must not disable shortcuts

            // Escape closes things in priority order
            if (e.key === 'Escape') {
                if (Palette.isVisible()) { Palette.hide(); return; }
                const modals = document.querySelectorAll('.modal:not([hidden])');
                if (modals.length) { modals.forEach(m => closeModal(m)); return; }
                // Close inline forms
                document.querySelectorAll('.inline-add-form:not([hidden])').forEach(f => f.hidden = true);
                return;
            }

            // Command palette
            if (e.ctrlKey && !e.altKey && key === 'k') {
                e.preventDefault();
                if (Palette.isVisible()) Palette.hide();
                else Palette.show();
                return;
            }

            // Don't intercept shortcuts when a modal is open
            const openDialog = document.querySelector('.modal:not([hidden])');
            if (openDialog) {
                // Enter in the new-node title or id field creates the node (not on Cancel)
                if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('#new-node-title, #new-node-id')) {
                    e.preventDefault();
                    createNewNode();
                    return;
                }
                if (e.key === 'Tab') trapTabInModal(openDialog, e);
                return;
            }

            // Undo (only global undo when NOT in contenteditable)
            if (e.ctrlKey && !e.altKey && key === 'z' && !isInputFocused()) {
                e.preventDefault();
                EditorState.undo();
                return;
            }

            // Panels: Ctrl+Shift+[ nodes, Ctrl+Shift+] details, Ctrl+Shift+\ both (writing view)
            if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight' || e.code === 'Backslash')) {
                e.preventDefault();
                togglePanel(e.code === 'BracketLeft' ? 'left' : e.code === 'BracketRight' ? 'right' : 'both');
                return;
            }

            // File operations
            if (e.ctrlKey && e.altKey && key === 's') {   // Ctrl+Alt+S = Save As
                e.preventDefault();
                saveFileAs();
                return;
            }
            if (e.ctrlKey && !e.altKey && key === 's') {
                e.preventDefault();
                saveFile();
            }
            if (e.ctrlKey && !e.altKey && key === 'o' && !e.shiftKey) {
                e.preventDefault();
                confirmUnsavedChanges(() => openFile());
            }
            // Alt+N / Alt+Shift+N: Ctrl+N and Ctrl+Shift+N are reserved by Chromium browsers
            // (new window / incognito) and never reach the page.
            if (e.altKey && !e.ctrlKey && key === 'n' && !e.shiftKey) {
                e.preventDefault();
                confirmUnsavedChanges(() => EditorState.newFile());
            }
            if (e.altKey && !e.ctrlKey && e.shiftKey && key === 'n') {
                e.preventDefault();
                showNewNodeModal();
            }
            if (e.ctrlKey && !e.altKey && e.shiftKey && key === 'm') {
                e.preventDefault();
                NodeEditor.toggleSuggestMode();
                return;
            }
            if (e.ctrlKey && !e.altKey && key === 'p') {
                e.preventDefault();
                openPreview();
            }

            // ? for shortcuts (not when typing)
            if (e.key === '?' && !isInputFocused()) {
                e.preventDefault();
                showShortcuts();
            }
        });
    }

    // Right-panel tabs: one activator for clicks, the palette and arrow keys, keeping the
    // tab/tabpanel states in step.
    function activateTab(tabName, focusTab) {
        const tabs = Array.from(document.querySelectorAll('.panel-tab'));
        if (!tabs.some(t => t.dataset.tab === tabName)) return;
        tabs.forEach(t => {
            const on = t.dataset.tab === tabName;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.setAttribute('tabindex', on ? '0' : '-1');
            if (on && focusTab) t.focus();
        });
        document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tabName}`));
    }

    function setupTabs() {
        const tabs = Array.from(document.querySelectorAll('.panel-tab'));
        tabs.forEach(tab => {
            tab.addEventListener('click', () => activateTab(tab.dataset.tab));
            tab.addEventListener('keydown', e => {
                const i = tabs.indexOf(tab);
                let next = null;
                if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
                else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
                else if (e.key === 'Home') next = tabs[0];
                else if (e.key === 'End') next = tabs[tabs.length - 1];
                if (next) { e.preventDefault(); activateTab(next.dataset.tab, true); }
            });
        });
        const current = tabs.find(t => t.classList.contains('active')) || tabs[0];
        if (current) activateTab(current.dataset.tab);
    }

    // Modals as dialogs: focus moves in, stays in (Tab wraps), and returns on close.
    const modalOpeners = new WeakMap();
    function openModal(modal, first) {
        if (!modal) return;
        modalOpeners.set(modal, document.activeElement);
        modal.hidden = false;
        const target = first || modal.querySelector('input, textarea, select, button');
        if (target) requestAnimationFrame(() => target.focus());
    }
    function closeModal(modal) {
        if (!modal || modal.hidden) return;
        modal.hidden = true;
        const back = modalOpeners.get(modal);
        modalOpeners.delete(modal);
        if (back && back !== document.body && document.contains(back) && typeof back.focus === 'function') back.focus();
    }
    function trapTabInModal(modal, e) {
        const items = Array.from(modal.querySelectorAll('.modal-content input, .modal-content textarea, .modal-content select, .modal-content button, .modal-content a[href]'))
            .filter(el => !el.disabled && el.offsetParent !== null);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        let next;
        if (e.shiftKey) next = i <= 0 ? items[items.length - 1] : items[i - 1];
        else next = i < 0 || i === items.length - 1 ? items[0] : items[i + 1];
        e.preventDefault();
        next.focus();
    }

    function setupModals() {
        // Shortcuts modal
        document.getElementById('btn-shortcuts').addEventListener('click', showShortcuts);
        document.getElementById('shortcuts-close').addEventListener('click', () => {
            closeModal(document.getElementById('shortcuts-modal'));
        });

        // New node modal
        document.getElementById('new-node-create').addEventListener('click', createNewNode);
        document.getElementById('new-node-cancel').addEventListener('click', () => {
            closeModal(document.getElementById('new-node-modal'));
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
            backdrop.addEventListener('click', () => {
                closeModal(backdrop.closest('.modal'));
            });
        });
    }

    const panelControls = {};   // panelId -> { toggle, setCollapsed, isCollapsed }

    function setupResize() {
        setupResizeHandle('resize-left', 'panel-left', 160, 350, false, 'collapse-left', 'Nodes');
        setupResizeHandle('resize-right', 'panel-right', 220, 520, true, 'collapse-right', 'details');
    }

    // 'left' / 'right' toggle one panel; 'both' gives a full-width writing view and back.
    function togglePanel(which) {
        const left = panelControls['panel-left'];
        const right = panelControls['panel-right'];
        if (which === 'left' && left) left.toggle();
        else if (which === 'right' && right) right.toggle();
        else if (which === 'both' && left && right) {
            const anyOpen = !left.isCollapsed() || !right.isCollapsed();
            left.setCollapsed(anyOpen);
            right.setCollapsed(anyOpen);
        }
    }

    function savePanelCollapsed(panelId, collapsed) {
        try { localStorage.setItem('entropy-editor-collapsed-' + panelId, collapsed ? '1' : '0'); } catch (e) { /* storage blocked — collapse still works for this session */ }
    }

    function loadPanelCollapsed(panelId) {
        try { return localStorage.getItem('entropy-editor-collapsed-' + panelId) === '1'; } catch (e) { return false; }
    }

    function setupResizeHandle(handleId, panelId, min, max, reverse, btnId, label) {
        const handle = document.getElementById(handleId);
        const panel = document.getElementById(panelId);
        const btn = btnId ? document.getElementById(btnId) : null;
        if (!handle || !panel) return;
        let startX, startWidth;
        // Width (px) to return to when the panel is expanded; updated on every resize.
        let restoreWidth = panel.offsetWidth;

        handle.addEventListener('mousedown', e => {
            if (panel.classList.contains('collapsed')) return; // nothing to drag while collapsed
            e.preventDefault();
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            handle.classList.add('active');
            panel.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        function onMove(e) {
            const diff = reverse ? (startX - e.clientX) : (e.clientX - startX);
            const newWidth = Math.min(max, Math.max(min, startWidth + diff));
            panel.style.width = newWidth + 'px';
        }

        function onUp() {
            handle.classList.remove('active');
            panel.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            restoreWidth = panel.offsetWidth;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        function setCollapsed(collapsed) {
            const already = panel.classList.contains('collapsed');
            if (collapsed) {
                if (!already && panel.offsetWidth > 0) restoreWidth = panel.offsetWidth;
                panel.classList.add('collapsed');
                handle.classList.add('is-collapsed');
            } else {
                panel.classList.remove('collapsed');
                handle.classList.remove('is-collapsed');
                if (restoreWidth > 0) panel.style.width = restoreWidth + 'px';
                else panel.style.removeProperty('width'); // fall back to the CSS default
            }
            updateBtn(collapsed);
            savePanelCollapsed(panelId, collapsed);
        }

        function updateBtn(collapsed) {
            if (!btn) return;
            // Chevron points the direction the edge will move when clicked.
            const expandChar = reverse ? '‹' : '›';   // ‹ / ›
            const collapseChar = reverse ? '›' : '‹'; // › / ‹
            btn.textContent = collapsed ? expandChar : collapseChar;
            const verb = collapsed ? 'Expand' : 'Collapse';
            btn.title = verb + ' panel (or double-click the bar)';
            btn.setAttribute('aria-label', verb + ' ' + label + ' panel');
            btn.setAttribute('aria-expanded', String(!collapsed));
        }

        function toggle() { setCollapsed(!panel.classList.contains('collapsed')); }
        panelControls[panelId] = { toggle, setCollapsed, isCollapsed: () => panel.classList.contains('collapsed') };

        // Double-clicking the bar (but not the button itself) toggles collapse.
        handle.addEventListener('dblclick', e => {
            if (btn && (e.target === btn || btn.contains(e.target))) return;
            toggle();
        });

        if (btn) {
            // Button clicks must not start a drag or re-trigger the handle's dblclick.
            btn.addEventListener('mousedown', e => e.stopPropagation());
            btn.addEventListener('dblclick', e => e.stopPropagation());
            btn.addEventListener('click', e => { e.stopPropagation(); toggle(); });
        }

        // Restore persisted collapse state (collapsed minimizes survive a reload).
        if (loadPanelCollapsed(panelId)) setCollapsed(true);
        else updateBtn(false);
    }

    function setupDirtyIndicator() {
        const indicator = document.getElementById('save-indicator');
        const fileNameEl = document.getElementById('file-name');
        const autosaveEl = document.getElementById('autosave-indicator');

        EditorState.on('dirty-changed', dirty => {
            indicator.hidden = !dirty;
        });

        EditorState.on('file-loaded', () => {
            fileNameEl.textContent = EditorState.getFileName();
            indicator.hidden = true;
            autosaveEl.hidden = !EditorState.getFileHandle();
        });
        EditorState.on('file-renamed', name => {        // Save As picked a new file
            fileNameEl.textContent = name;
            autosaveEl.hidden = !EditorState.getFileHandle();
        });
    }

    function setupMeta() {
        const metaTitle = document.getElementById('meta-title');
        const metaSubtitle = document.getElementById('meta-subtitle');
        const metaAuthor = document.getElementById('meta-author');
        const metaDesc = document.getElementById('meta-description');
        const metaRoot = document.getElementById('meta-root');
        const metaStats = document.getElementById('meta-stats');

        EditorState.on('file-loaded', loadMeta);
        EditorState.on('node-added', updateRootSelect);
        EditorState.on('node-deleted', updateRootSelect);
        EditorState.on('node-updated', updateStats);
        EditorState.on('node-added', updateStats);
        EditorState.on('node-deleted', updateStats);

        function loadMeta() {
            const data = EditorState.getData();
            if (!data) return;
            metaTitle.value = data.meta.title || '';
            metaSubtitle.value = data.meta.subtitle || '';
            metaAuthor.value = data.meta.author || '';
            metaDesc.value = data.meta.description || '';
            updateRootSelect();
            updateStats();
        }

        [metaTitle, metaSubtitle, metaAuthor, metaDesc].forEach(el => {
            el.addEventListener('input', () => {
                EditorState.updateMeta({
                    title: metaTitle.value,
                    subtitle: metaSubtitle.value,
                    author: metaAuthor.value,
                    description: metaDesc.value
                });
            });
        });

        metaRoot.addEventListener('change', () => {
            EditorState.setRoot(metaRoot.value);
        });

        function updateRootSelect() {
            const data = EditorState.getData();
            if (!data) return;
            metaRoot.innerHTML = EditorState.getAllNodeIds()
                .map(id => {
                    const n = data.nodes[id];
                    const sel = id === data.root ? 'selected' : '';
                    return `<option value="${id}" ${sel}>${n.title} (${id})</option>`;
                }).join('');
        }

        function updateStats() {
            const data = EditorState.getData();
            if (!data) return;
            const nodes = Object.keys(data.nodes).length;
            const children = Object.values(data.nodes).reduce((s, n) => s + (n.children || []).length, 0);
            const conns = Object.values(data.nodes).reduce((s, n) => s + (n.connections || []).length, 0);
            const words = EditorState.getWordCount();
            metaStats.innerHTML = `
                <div>Nodes: <strong>${nodes}</strong></div>
                <div>Words: <strong>${words.toLocaleString()}</strong></div>
                <div>Child links: <strong>${children}</strong></div>
                <div>Cross-links: <strong>${conns}</strong></div>
                <div>Created: ${data.meta.created ? new Date(data.meta.created).toLocaleString() : '—'}</div>
                <div>Last modified: ${data.meta.modified ? new Date(data.meta.modified).toLocaleString() : '—'}</div>
            `;
        }
    }

    function setupAutosave() {
        setInterval(() => {
            if (EditorState.isDirty() && EditorState.getFileHandle()) {
                saveFile(true);
            }
        }, 30000);
    }

    function isInputFocused() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    window.addEventListener('beforeunload', e => {
        if (EditorState.isDirty()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    document.addEventListener('DOMContentLoaded', init);
    return { activateTab, togglePanel, openModal, closeModal };
})();
