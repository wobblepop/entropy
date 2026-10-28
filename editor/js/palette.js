/* ============================================
   PALETTE — Command palette (Ctrl+K)
   Quick actions, node search, commands
   ============================================ */

const Palette = (() => {
    let paletteEl, inputEl, resultsEl;
    let selectedIndex = 0;
    let currentResults = [];

    const commands = [
        { type: 'cmd', label: 'New File', action: () => document.getElementById('btn-new').click(), hint: 'Alt+N' },
        { type: 'cmd', label: 'Open File', action: () => document.getElementById('btn-open').click(), hint: 'Ctrl+O' },
        { type: 'cmd', label: 'Save File', action: () => saveFile(), hint: 'Ctrl+S' },
        { type: 'cmd', label: 'Save As…', action: () => saveFileAs(), hint: 'Ctrl+Alt+S' },
        { type: 'cmd', label: 'Add New Node', action: () => showNewNodeModal(), hint: 'Alt+Shift+N' },
        { type: 'cmd', label: 'View in reader (new tab)', action: () => openPreview(), hint: 'Ctrl+P' },
        { type: 'cmd', label: 'Toggle Nodes panel', action: () => App.togglePanel('left'), hint: 'Ctrl+Shift+[' },
        { type: 'cmd', label: 'Toggle details panel', action: () => App.togglePanel('right'), hint: 'Ctrl+Shift+]' },
        { type: 'cmd', label: 'Writing view (hide / show both panels)', action: () => App.togglePanel('both'), hint: 'Ctrl+Shift+\\' },
        { type: 'cmd', label: 'Toggle justified text (this editor only)', action: () => NodeEditor.applyFormat('justify-toggle') },
        { type: 'cmd', label: 'Column width: default', action: () => App.setColumnWidth(null) },
        { type: 'cmd', label: 'Column width: fill the panel', action: () => App.setColumnWidth(Infinity) },
        { type: 'cmd', label: 'Generate PDF…', action: () => PdfExport.open() },
        { type: 'cmd', label: 'Toggle Suggesting Mode', action: () => NodeEditor.toggleSuggestMode(), hint: 'Ctrl+Shift+M' },
        { type: 'cmd', label: 'Review Suggested Changes', action: () => NodeEditor.enterReview() },
        { type: 'cmd', label: 'Insert Footnote', action: () => NodeEditor.applyFormat('footnote'), hint: 'Ctrl+Shift+F' },
        { type: 'cmd', label: 'Insert Equation', action: () => NodeEditor.applyFormat('equation'), hint: 'Ctrl+Shift+E' },
        { type: 'cmd', label: 'Show Node Details', action: () => switchTab('node') },
        { type: 'cmd', label: 'Show Preview Panel', action: () => switchTab('preview') },
        { type: 'cmd', label: 'Show Graph View', action: () => switchTab('graph') },
        { type: 'cmd', label: 'Show Book Metadata', action: () => switchTab('meta') },
        { type: 'cmd', label: 'Keyboard Shortcuts', action: () => showShortcuts(), hint: '?' },
    ];

    let savedRange = null;     // caret in the text when the palette opened
    let openerEl = null;       // element focused when the palette opened

    function init() {
        paletteEl = document.getElementById('command-palette');
        inputEl = document.getElementById('palette-input');
        resultsEl = document.getElementById('palette-results');

        inputEl.setAttribute('role', 'combobox');
        inputEl.setAttribute('aria-autocomplete', 'list');
        inputEl.setAttribute('aria-controls', 'palette-results');
        inputEl.setAttribute('aria-expanded', 'false');
        resultsEl.setAttribute('role', 'listbox');

        inputEl.addEventListener('input', updateResults);
        inputEl.addEventListener('keydown', handleKeydown);
        paletteEl.querySelector('.palette-backdrop').addEventListener('click', hide);
    }

    function show() {
        // Remember where the author was: a command such as Insert Footnote acts at the
        // caret it finds, and opening the palette would otherwise move it.
        const contentEl = document.getElementById('edit-content');
        const sel = window.getSelection();
        savedRange = (contentEl && sel && sel.rangeCount && contentEl.contains(sel.getRangeAt(0).commonAncestorContainer))
            ? sel.getRangeAt(0).cloneRange() : null;
        openerEl = document.activeElement;
        paletteEl.hidden = false;
        inputEl.setAttribute('aria-expanded', 'true');
        inputEl.value = '';
        selectedIndex = 0;
        updateResults();
        requestAnimationFrame(() => inputEl.focus());
    }

    function hide() {
        paletteEl.hidden = true;
        inputEl.setAttribute('aria-expanded', 'false');
        const back = openerEl;
        openerEl = null;
        if (back && back !== document.body && document.contains(back) && typeof back.focus === 'function') back.focus();
    }

    function isVisible() {
        return !paletteEl.hidden;
    }

    function updateResults() {
        const query = inputEl.value.toLowerCase().trim();
        currentResults = [];

        // Sections first: hopping between chapters is the common case. Commands follow.
        const allIds = EditorState.getAllNodeIds();
        allIds.forEach(id => {
            const node = EditorState.getNode(id);
            if (!node) return;
            if (!query || node.title.toLowerCase().includes(query) || id.includes(query)) {
                currentResults.push({
                    type: 'node',
                    label: node.title,
                    hint: id,
                    action: () => { EditorState.selectNode(id); NodeEditor.focusContent(); }
                });
            }
        });

        commands.forEach(cmd => {
            if (!query || cmd.label.toLowerCase().includes(query)) {
                currentResults.push(cmd);
            }
        });

        renderResults();
    }

    function renderResults() {
        selectedIndex = Math.min(selectedIndex, currentResults.length - 1);
        if (selectedIndex < 0) selectedIndex = 0;

        resultsEl.innerHTML = currentResults.map((item, i) => `
            <li class="palette-result ${i === selectedIndex ? 'selected' : ''}" data-index="${i}" id="palette-opt-${i}" role="option" aria-selected="${i === selectedIndex ? 'true' : 'false'}">
                <span class="result-type">${item.type}</span>
                <span class="result-label">${item.label}</span>
                ${item.hint ? `<span class="result-hint">${item.hint}</span>` : ''}
            </li>
        `).join('');
        inputEl.setAttribute('aria-activedescendant', currentResults.length ? ('palette-opt-' + selectedIndex) : '');
        const sel = resultsEl.querySelector('.palette-result.selected');
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });

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
            const range = savedRange;
            savedRange = null;
            hide();
            // Restore the caret the author had in the text before the command runs.
            if (range) {
                const contentEl = document.getElementById('edit-content');
                if (contentEl && contentEl.contains(range.commonAncestorContainer)) {
                    contentEl.focus();
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
            item.action();
        }
    }

    function switchTab(tabName) {
        App.activateTab(tabName);
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
            NodeEditor.toast('Save to ' + EditorState.getFileName() + ' failed: ' + err.message, 'error');
            // Autosave has no user gesture, so the picker/download fallbacks
            // below would fail or drop a stray copy in Downloads — stop here.
            if (silent) return;
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

// Save As: write a new file chosen in the save picker and keep editing that file (it
// becomes the autosave target and the header shows its name). Without the picker
// (e.g. Firefox) the copy is downloaded under a name the user types.
async function saveFileAs() {
    NodeEditor.flushContent();
    const data = EditorState.getExportData();
    if (!data) {
        NodeEditor.toast('Nothing to save — create or open a file first', 'info');
        return;
    }
    const json = JSON.stringify(data, null, 2);
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
            EditorState.setFileName(newHandle.name || EditorState.getFileName());
            EditorState.markClean();
            NodeEditor.toast('Saved as ' + EditorState.getFileName(), 'success');
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            NodeEditor.toast('Save As failed: ' + (err && err.message ? err.message : err), 'error');
        }
        return;
    }
    const typed = window.prompt('File name for the copy', EditorState.getFileName());
    if (typed === null) return;
    const safe = (typed.trim() || EditorState.getFileName()).replace(/[\\/:*?"<>|]+/g, '-');
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safe;
    a.click();
    URL.revokeObjectURL(url);
    EditorState.setFileName(safe);
    EditorState.markClean();
    NodeEditor.toast('Downloaded ' + safe, 'success');
}

function showNewNodeModal(forceAsChild) {
    const modal = document.getElementById('new-node-modal');
    const titleInput = document.getElementById('new-node-title');
    const idInput = document.getElementById('new-node-id');
    const checkbox = document.getElementById('new-node-add-as-child');

    titleInput.value = '';
    idInput.value = '';
    checkbox.checked = forceAsChild === true || !!EditorState.getSelectedNode();
    App.openModal(modal, titleInput);

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
    App.closeModal(document.getElementById('new-node-modal'));
    NodeEditor.toast(`"${title}" created`, 'success');
    NodeEditor.focusContent();   // start writing at once
}

function openPreview(opts) {
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
    // Optional deep link into the viewer's "Save as PDF" picker (#pdf=<nodeId>).
    // Type-guard everything: the header View button passes a MouseEvent as `opts`.
    const wantPdf = !!(opts && typeof opts === 'object' && opts.pdf === true);
    const pdfNodeId = wantPdf && typeof opts.pdfNodeId === 'string' && data.nodes && data.nodes[opts.pdfNodeId]
        ? opts.pdfNodeId : null;
    // Inject the current content into the embedded full reader, open it in a new tab.
    const jsonStr = JSON.stringify(data).replace(/<\//g, '<\\/');
    const html = VIEWER_TEMPLATE.replace('__ENTROPY_PREVIEW_DATA__', () => jsonStr);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const target = wantPdf ? url + '#pdf' + (pdfNodeId ? '=' + encodeURIComponent(pdfNodeId) : '') : url;
    const win = window.open(target, '_blank');
    if (!win) {
        NodeEditor.toast('Pop-up blocked — allow pop-ups to open the viewer', 'error');
    } else if (wantPdf) {
        NodeEditor.toast('Opened in the viewer — pick the section, then choose Save as PDF in the print dialog', 'success');
    } else {
        NodeEditor.toast('Opened in the viewer', 'success');
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}

function showShortcuts() {
    const modal = document.getElementById('shortcuts-modal');
    App.openModal(modal, document.getElementById('shortcuts-close'));
}
