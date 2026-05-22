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
        { type: 'cmd', label: 'Open File', action: () => document.getElementById('file-open-input').click(), hint: 'Ctrl+O' },
        { type: 'cmd', label: 'Save File', action: () => saveFile(), hint: 'Ctrl+S' },
        { type: 'cmd', label: 'Add New Node', action: () => showNewNodeModal(), hint: 'Ctrl+Shift+N' },
        { type: 'cmd', label: 'Preview in New Tab', action: () => openPreview(), hint: 'Ctrl+P' },
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
        NodeEditor.toast('Nothing to preview — create or open a file first', 'info');
        return;
    }

    // Build a self-contained preview page
    const jsonStr = JSON.stringify(data);
    const previewHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Preview: ${data.meta.title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;line-height:1.7;max-width:700px;margin:0 auto;padding:40px 24px;background:#fafafa;color:#1a1a1a}
h1{font-size:1.8rem;margin-bottom:8px}
h2{font-size:1.4rem;margin:24px 0 8px;color:#2563eb}
h3{font-size:1.15rem;margin:16px 0 6px}
p{margin-bottom:12px}
.meta{font-size:0.8rem;color:#888;margin-bottom:24px}
.summary{font-style:italic;color:#555;margin-bottom:20px;font-size:1.05rem}
ul,ol{margin:0 0 12px 24px}
li{margin-bottom:4px}
strong{font-weight:600}
blockquote{border-left:3px solid #2563eb;padding:8px 16px;margin:16px 0;background:#f7f7f7;color:#555;border-radius:0 4px 4px 0}
.example-block{border:1px solid #2563eb;padding:12px 18px;margin:16px 0;background:#eff6ff;border-radius:8px}
.example-label{display:inline-block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:#2563eb;background:rgba(37,99,235,0.1);padding:1px 8px;border-radius:3px;margin-bottom:8px}
.example-label::before{content:'Example'}
code{font-family:monospace;font-size:0.85em;padding:2px 5px;background:#f4f4f5;border-radius:3px}
hr{border:none;border-top:1px solid #e5e5e5;margin:24px 0}
.card{display:block;padding:16px 20px;border:1px solid #e5e5e5;border-radius:8px;margin:8px 0;cursor:pointer;transition:border-color 0.15s}
.card:hover{border-color:#2563eb}
.card-title{font-weight:600;margin-bottom:2px}
.card-summary{font-size:0.85rem;color:#555}
.conn{display:inline-block;padding:6px 14px;border:1px solid #e5e5e5;border-radius:20px;margin:4px;font-size:0.85rem;cursor:pointer;transition:all 0.15s}
.conn:hover{border-color:#2563eb;color:#2563eb}
.conn-type{font-size:0.7rem;text-transform:uppercase;opacity:0.5;margin-right:4px}
.nav{margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;display:flex;gap:8px}
.nav button{padding:6px 14px;border:1px solid #e5e5e5;border-radius:4px;background:white;cursor:pointer;font-size:0.85rem}
.nav button:hover{border-color:#2563eb;color:#2563eb}
.section-label{font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;color:#888;margin:32px 0 12px;padding-top:16px;border-top:1px solid #e5e5e5}
.badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:0.7rem;text-transform:uppercase}
.badge-intro{background:#dcfce7;color:#166534}
.badge-intermediate{background:#fef3c7;color:#92400e}
.badge-advanced{background:#fee2e2;color:#991b1b}
.badge-expert{background:#ede9fe;color:#5b21b6}
</style></head><body>
<div id="app"></div>
<script>
const DATA = ${jsonStr};
const START_NODE = '${EditorState.getSelectedNodeId() || data.root}';
let history = [START_NODE];
function go(id){history.push(id);render(id);window.scrollTo(0,0)}
function back(){if(history.length>1){history.pop();render(history[history.length-1]);window.scrollTo(0,0)}}
function home(){history=[DATA.root];render(DATA.root);window.scrollTo(0,0)}
function md(t){
if(!t)return'';
var r=t
.replace(/:::example\\n([\\s\\S]*?):::/g,function(m,c){return '<div class="example-block"><span class="example-label"></span>'+c.trim().split('\\n').map(function(l){return '<p>'+l+'</p>'}).join('')+'</div>'})
.replace(/^### (.+)$/gm,'<h3>$1</h3>')
.replace(/^## (.+)$/gm,'<h2>$1</h2>')
.replace(/^# (.+)$/gm,'<h1>$1</h1>')
.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
.replace(/\\*(.+?)\\*/g,'<em>$1</em>')
.replace(/\`(.+?)\`/g,'<code>$1</code>')
.replace(/\\[(.+?)\\]\\((.+?)\\)/g,'<a href="$2">$1</a>')
.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>')
.replace(/^- (.+)$/gm,'<li>$1</li>')
.replace(/((<li>.*<\\/li>\\n?)+)/g,'<ul>$1</ul>')
.replace(/\\n\\n/g,'</p><p>')
.replace(/^([^<].+)$/gm,'<p>$1</p>');
return r;
}
function render(id){
const n=DATA.nodes[id];if(!n)return;
let h='';
if(n.difficulty)h+='<span class="badge badge-'+n.difficulty+'">'+n.difficulty+'</span> ';
if(n.estimatedTime)h+='<span style="font-size:0.8rem;color:#888">'+n.estimatedTime+'</span>';
h+='<h1>'+esc(n.title)+'</h1>';
if(n.summary)h+='<p class="summary">'+esc(n.summary)+'</p>';
h+=md(n.content);
if(n.children&&n.children.length){
h+='<div class="section-label">Explore Further</div>';
n.children.forEach(cid=>{
const c=DATA.nodes[cid];if(!c)return;
h+='<div class="card" onclick="go(\\''+cid+'\\')">';
h+='<div class="card-title">'+esc(c.title)+'</div>';
if(c.summary)h+='<div class="card-summary">'+esc(c.summary)+'</div>';
h+='</div>';
});}
if(n.connections&&n.connections.length){
h+='<div class="section-label">Connected Topics</div>';
n.connections.forEach(c=>{
const t=DATA.nodes[c.to];if(!t)return;
h+='<span class="conn" onclick="go(\\''+c.to+'\\')">';
if(c.type)h+='<span class="conn-type">'+c.type+'</span>';
h+=(c.label||t.title)+'</span>';
});}
h+='<div class="nav">';
h+='<button onclick="back()" '+(history.length<=1?'disabled':'')+'>Back</button>';
h+='<button onclick="home()">Home</button>';
h+='</div>';
document.getElementById('app').innerHTML=h;
}
function esc(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}
render(START_NODE);
<\/script></body></html>`;

    const blob = new Blob([previewHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    NodeEditor.toast('Preview opened in new tab', 'success');
}

function showShortcuts() {
    document.getElementById('shortcuts-modal').hidden = false;
}
