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
        modal.hidden = false;

        const cleanup = () => {
            modal.hidden = true;
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
                        if (!data.nodes || !data.root) {
                            NodeEditor.toast('Invalid file format', 'error');
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
            // Escape closes things in priority order
            if (e.key === 'Escape') {
                if (Palette.isVisible()) { Palette.hide(); return; }
                const modals = document.querySelectorAll('.modal:not([hidden])');
                if (modals.length) { modals.forEach(m => m.hidden = true); return; }
                // Close inline forms
                document.querySelectorAll('.inline-add-form:not([hidden])').forEach(f => f.hidden = true);
                return;
            }

            // Command palette
            if (e.ctrlKey && e.key === 'k') {
                e.preventDefault();
                if (Palette.isVisible()) Palette.hide();
                else Palette.show();
                return;
            }

            // Don't intercept shortcuts when a modal is open
            if (document.querySelector('.modal:not([hidden])')) {
                // Enter in new node modal creates the node
                if (e.key === 'Enter' && !document.getElementById('new-node-modal').hidden) {
                    e.preventDefault();
                    createNewNode();
                }
                return;
            }

            // Undo (only global undo when NOT in contenteditable)
            if (e.ctrlKey && e.key === 'z' && !isInputFocused()) {
                e.preventDefault();
                EditorState.undo();
                return;
            }

            // File operations
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                saveFile();
            }
            if (e.ctrlKey && e.key === 'o' && !e.shiftKey) {
                e.preventDefault();
                confirmUnsavedChanges(() => openFile());
            }
            if (e.ctrlKey && e.key === 'n' && !e.shiftKey) {
                e.preventDefault();
                confirmUnsavedChanges(() => EditorState.newFile());
            }
            if (e.ctrlKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
                e.preventDefault();
                showNewNodeModal();
            }
            if (e.ctrlKey && e.key === 'p') {
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

    function setupTabs() {
        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
            });
        });
    }

    function setupModals() {
        // Shortcuts modal
        document.getElementById('btn-shortcuts').addEventListener('click', showShortcuts);
        document.getElementById('shortcuts-close').addEventListener('click', () => {
            document.getElementById('shortcuts-modal').hidden = true;
        });

        // New node modal
        document.getElementById('new-node-create').addEventListener('click', createNewNode);
        document.getElementById('new-node-cancel').addEventListener('click', () => {
            document.getElementById('new-node-modal').hidden = true;
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
            backdrop.addEventListener('click', () => {
                backdrop.closest('.modal').hidden = true;
            });
        });
    }

    function setupResize() {
        setupResizeHandle('resize-left', 'panel-left', 160, 350, false);
        setupResizeHandle('resize-right', 'panel-right', 200, 400, true);
    }

    function setupResizeHandle(handleId, panelId, min, max, reverse) {
        const handle = document.getElementById(handleId);
        const panel = document.getElementById(panelId);
        let startX, startWidth;

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            handle.classList.add('active');
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
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
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
    return {};
})();
