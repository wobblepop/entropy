/* ============================================
   PALETTE — Command palette (Ctrl+K)
   Quick actions, node search, commands
   ============================================ */

const Palette = (() => {
    let paletteEl, inputEl, resultsEl;
    let selectedIndex = 0;
    let currentResults = [];

    const commands = [
        { type: 'cmd', label: 'New File', action: () => document.getElementById('btn-new').click(), hint: 'Ctrl+N' },
        { type: 'cmd', label: 'Open File', action: () => document.getElementById('btn-open').click(), hint: 'Ctrl+O' },
        { type: 'cmd', label: 'Save File', action: () => saveFile(), hint: 'Ctrl+S' },
        { type: 'cmd', label: 'Add New Node', action: () => showNewNodeModal(), hint: 'Ctrl+Shift+N' },
        { type: 'cmd', label: 'Open in Viewer', action: () => openPreview(), hint: 'Ctrl+P' },
        { type: 'cmd', label: 'Show Preview Panel', action: () => switchTab('preview') },
        { type: 'cmd', label: 'Show Graph View', action: () => switchTab('graph') },
        { type: 'cmd', label: 'Show Book Metadata', action: () => switchTab('meta') },
        { type: 'cmd', label: 'Keyboard Shortcuts', action: () => showShortcuts(), hint: '?' },
    ];

    function init() {
        paletteEl = document.getElementById('command-palette');
        inputEl = document.getElementById('palette-input');
        resultsEl = document.getElementById('palette-results');

        inputEl.addEventListener('input', updateResults);
        inputEl.addEventListener('keydown', handleKeydown);
        paletteEl.querySelector('.palette-backdrop').addEventListener('click', hide);
    }

    function show() {
        paletteEl.hidden = false;
        inputEl.value = '';
        selectedIndex = 0;
        updateResults();
        requestAnimationFrame(() => inputEl.focus());
    }

    function hide() {
        paletteEl.hidden = true;
    }

    function isVisible() {
        return !paletteEl.hidden;
    }

    function updateResults() {
        const query = inputEl.value.toLowerCase().trim();
        currentResults = [];

        commands.forEach(cmd => {
            if (!query || cmd.label.toLowerCase().includes(query)) {
                currentResults.push(cmd);
            }
        });

        const allIds = EditorState.getAllNodeIds();
        allIds.forEach(id => {
            const node = EditorState.getNode(id);
            if (!node) return;
            if (!query || node.title.toLowerCase().includes(query) || id.includes(query)) {
                currentResults.push({
                    type: 'node',
                    label: node.title,
                    hint: id,
                    action: () => EditorState.selectNode(id)
                });
            }
        });

        renderResults();
    }

    function renderResults() {
        selectedIndex = Math.min(selectedIndex, currentResults.length - 1);
        if (selectedIndex < 0) selectedIndex = 0;

        resultsEl.innerHTML = currentResults.map((item, i) => `
            <li class="palette-result ${i === selectedIndex ? 'selected' : ''}" data-index="${i}" role="option">
                <span class="result-type">${item.type}</span>
                <span class="result-label">${item.label}</span>
                ${item.hint ? `<span class="result-hint">${item.hint}</span>` : ''}
            </li>
        `).join('');

        resultsEl.querySelectorAll('.palette-result').forEach(el => {
            el.addEventListener('click', () => executeResult(parseInt(el.dataset.index)));
        });
    }

    function handleKeydown(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
            renderResults();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            renderResults();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            executeResult(selectedIndex);
        } else if (e.key === 'Escape') {
            hide();
        }
    }

    function executeResult(index) {
        const item = currentResults[index];
        if (item && item.action) {
            hide();
            item.action();
        }
    }

    function switchTab(tabName) {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tabName}`));
    }

    return { init, show, hide, isVisible, switchTab };
})();

// --- Global utility functions ---

async function saveFile(silent) {
    NodeEditor.flushContent();
    const data = EditorState.getExportData();
    if (!data) {
        if (!silent) NodeEditor.toast('Nothing to save — create or open a file first', 'info');
        return;
    }
    const json = JSON.stringify(data, null, 2);
    const handle = EditorState.getFileHandle();

    if (handle) {
        try {
            const writable = await handle.createWritable();
            await writable.write(json);
            await writable.close();
            EditorState.markClean();
            if (!silent) NodeEditor.toast('Saved', 'success');
            return;
        } catch (err) {
            // Fall through to download if write fails
        }
    }

    if (window.showSaveFilePicker) {
        try {
            const newHandle = await window.showSaveFilePicker({
                suggestedName: EditorState.getFileName(),
                types: [{ description: 'Entropy JSON', accept: { 'application/json': ['.json', '.entropy.json'] } }]
            });
            const writable = await newHandle.createWritable();
            await writable.write(json);
            await writable.close();
            EditorState.setFileHandle(newHandle);
            EditorState.markClean();
            if (!silent) NodeEditor.toast('Saved', 'success');
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = EditorState.getFileName();
    a.click();
    URL.revokeObjectURL(url);
    EditorState.markClean();
    if (!silent) NodeEditor.toast('File saved', 'success');
}

function showNewNodeModal(forceAsChild) {
    const modal = document.getElementById('new-node-modal');
    const titleInput = document.getElementById('new-node-title');
    const idInput = document.getElementById('new-node-id');
    const checkbox = document.getElementById('new-node-add-as-child');

    titleInput.value = '';
    idInput.value = '';
    checkbox.checked = forceAsChild === true || !!EditorState.getSelectedNode();
    modal.hidden = false;
    requestAnimationFrame(() => titleInput.focus());

    // Auto-generate ID from title
    titleInput.oninput = () => {
        idInput.value = titleInput.value
            .toLowerCase()
            .replace(/[^a-z0-9\s_-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    };
}

function createNewNode() {
    const titleInput = document.getElementById('new-node-title');
    const idInput = document.getElementById('new-node-id');
    const checkbox = document.getElementById('new-node-add-as-child');

    const title = titleInput.value.trim();
    if (!title) {
        NodeEditor.toast('Title is required', 'error');
        return;
    }

    let id = idInput.value.trim();
    if (!id) {
        id = title.toLowerCase().replace(/[^a-z0-9\s_-]/g, '').replace(/\s+/g, '-');
    }

    if (EditorState.getNode(id)) {
        NodeEditor.toast('A node with this ID already exists', 'error');
        return;
    }

    EditorState.addNode(id, title);

    if (checkbox.checked) {
        const parent = EditorState.getSelectedNode();
        if (parent) {
            const children = [...(parent.children || []), id];
            EditorState.updateNode(parent.id, { children });
        }
    }

    EditorState.selectNode(id);
    document.getElementById('new-node-modal').hidden = true;
    NodeEditor.toast(`"${title}" created`, 'success');
}

function openPreview() {
    NodeEditor.flushContent();
    const data = EditorState.getExportData();
    if (!data) {
        NodeEditor.toast('Nothing to view — create or open a file first', 'info');
        return;
    }
    if (typeof VIEWER_TEMPLATE === 'undefined') {
        NodeEditor.toast('Viewer not built — run: py build_editor.py', 'error');
        return;
    }
    // Inject the current content into the embedded full reader, open it in a new tab.
    const jsonStr = JSON.stringify(data).replace(/<\//g, '<\\/');
    const html = VIEWER_TEMPLATE.replace('__ENTROPY_PREVIEW_DATA__', () => jsonStr);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
        NodeEditor.toast('Pop-up blocked — allow pop-ups to open the viewer', 'error');
    } else {
        NodeEditor.toast('Opened in the viewer', 'success');
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}

function showShortcuts() {
    document.getElementById('shortcuts-modal').hidden = false;
}
