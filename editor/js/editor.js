/* ============================================
   EDITOR — Rich text node editing
   Contenteditable WYSIWYG with markdown I/O
   ============================================ */

const NodeEditor = (() => {
    let editorEl, emptyState, contentEl;
    let fields = {};
    let suppressSave = false;
    let saveTimer = null;
    let loadedNodeId = null;

    function init() {
        editorEl = document.getElementById('node-editor');
        emptyState = document.getElementById('empty-state');
        contentEl = document.getElementById('edit-content');

        fields = {
            id: document.getElementById('edit-id'),
            title: document.getElementById('edit-title'),
            summary: document.getElementById('edit-summary'),
            difficulty: document.getElementById('edit-difficulty'),
            time: document.getElementById('edit-time'),
            order: document.getElementById('edit-order')
        };

        EditorState.on('node-selected', loadNode);
        EditorState.on('file-loaded', () => {
            emptyState.hidden = true;
            editorEl.hidden = false;
        });

        setupAutoSave();
        setupToolbar();
        setupContentEditor();
        setupTags();
        setupChildren();
        setupConnections();
        setupMedia();
        setupDeleteNode();
        setupDuplicate();
        setupWordCount();
    }

    // --- Rich text <-> Markdown conversion ---

    function markdownToHtml(md) {
        if (!md) return '';
        const lines = md.split('\n');
        const result = [];
        let inCode = false;
        let codeLines = [];
        let inBlockquote = false;
        let bqLines = [];
        let inExample = false;
        let exLines = [];

        function flushBlockquote() {
            if (bqLines.length > 0) {
                result.push('<blockquote>' + bqLines.map(l => '<p>' + inlineFormat(l) + '</p>').join('\n') + '</blockquote>');
                bqLines = [];
            }
            inBlockquote = false;
        }

        function flushExample() {
            if (exLines.length > 0) {
                result.push('<div class="example-block"><span class="example-label"></span>' + exLines.map(l => '<p>' + inlineFormat(l) + '</p>').join('\n') + '</div>');
                exLines = [];
            }
            inExample = false;
        }

        function inlineFormat(text) {
            return text
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g, '<em>$1</em>')
                .replace(/`(.+?)`/g, '<code>$1</code>')
                .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('```')) {
                if (inBlockquote) flushBlockquote();
                if (inExample) flushExample();
                if (inCode) {
                    result.push('<pre><code>' + codeLines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</code></pre>');
                    codeLines = [];
                    inCode = false;
                } else {
                    inCode = true;
                }
                continue;
            }
            if (inCode) { codeLines.push(line); continue; }

            if (line.match(/^:::example\s*$/i)) {
                if (inBlockquote) flushBlockquote();
                inExample = true;
                continue;
            }
            if (inExample && line.match(/^:::\s*$/)) {
                flushExample();
                continue;
            }
            if (inExample) {
                const trimmed = line.trim();
                if (trimmed) exLines.push(trimmed);
                continue;
            }

            if (line.startsWith('> ') || line === '>') {
                if (!inBlockquote) inBlockquote = true;
                const content = line.replace(/^>\s?/, '').trim();
                if (content) bqLines.push(content);
                continue;
            } else if (inBlockquote) {
                flushBlockquote();
            }

            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.match(/^#{1,3}\s/)) {
                const m = trimmed.match(/^(#{1,3})\s+(.+)/);
                const level = m[1].length;
                result.push(`<h${level}>${inlineFormat(m[2])}</h${level}>`);
            } else if (trimmed.match(/^---$/)) {
                result.push('<hr>');
            } else if (trimmed.match(/^[-*+]\s/)) {
                const items = [trimmed.replace(/^[-*+]\s+/, '')];
                while (i + 1 < lines.length && lines[i + 1].match(/^\s*[-*+]\s/)) {
                    i++;
                    items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
                }
                result.push('<ul>' + items.map(it => '<li>' + inlineFormat(it) + '</li>').join('') + '</ul>');
            } else if (trimmed.match(/^\d+\.\s/)) {
                const items = [trimmed.replace(/^\d+\.\s+/, '')];
                while (i + 1 < lines.length && lines[i + 1].match(/^\s*\d+\.\s/)) {
                    i++;
                    items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
                }
                result.push('<ol>' + items.map(it => '<li>' + inlineFormat(it) + '</li>').join('') + '</ol>');
            } else {
                result.push('<p>' + inlineFormat(trimmed) + '</p>');
            }
        }

        if (inBlockquote) flushBlockquote();
        if (inExample) flushExample();
        if (inCode) {
            result.push('<pre><code>' + codeLines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</code></pre>');
        }

        return result.join('\n');
    }

    function htmlToMarkdown(html) {
        if (!html) return '';
        const div = document.createElement('div');
        div.innerHTML = html;
        return nodeToMd(div).trim();
    }

    function nodeToMd(node) {
        let md = '';
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                md += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                const inner = nodeToMd(child);
                switch (tag) {
                    case 'h1': md += '\n# ' + inner.trim() + '\n\n'; break;
                    case 'h2': md += '\n## ' + inner.trim() + '\n\n'; break;
                    case 'h3': md += '\n### ' + inner.trim() + '\n\n'; break;
                    case 'strong': case 'b': md += '**' + inner + '**'; break;
                    case 'em': case 'i': md += '*' + inner + '*'; break;
                    case 'code': md += '`' + inner + '`'; break;
                    case 'a': md += '[' + inner + '](' + (child.getAttribute('href') || '') + ')'; break;
                    case 'blockquote': {
                        const lines = inner.trim().split(/\n+/).filter(l => l.trim());
                        md += '\n' + lines.map(l => '> ' + l.trim()).join('\n') + '\n\n';
                        break;
                    }
                    case 'pre':
                        const codeEl = child.querySelector('code');
                        md += '\n```\n' + (codeEl ? codeEl.textContent : inner) + '\n```\n\n';
                        break;
                    case 'ul': case 'ol':
                        for (const li of child.querySelectorAll(':scope > li')) {
                            md += (tag === 'ol' ? '1. ' : '- ') + nodeToMd(li).trim() + '\n';
                        }
                        md += '\n';
                        break;
                    case 'li': md += inner; break;
                    case 'p': md += inner.trim() + '\n\n'; break;
                    case 'br': md += '\n'; break;
                    case 'hr': md += '\n---\n\n'; break;
                    case 'div':
                        if (child.classList.contains('example-block')) {
                            const wrapper = child.cloneNode(true);
                            const labelEl = wrapper.querySelector('.example-label');
                            if (labelEl) labelEl.remove();
                            const exMd = nodeToMd(wrapper).trim();
                            const lines = exMd.split(/\n+/).filter(l => l.trim());
                            md += '\n:::example\n' + lines.join('\n') + '\n:::\n\n';
                        } else {
                            md += inner;
                            if (!inner.endsWith('\n')) md += '\n';
                        }
                        break;
                    default: md += inner; break;
                }
            }
        }
        return md;
    }

    // --- Node loading ---

    function loadNode(nodeId) {
        if (loadedNodeId && loadedNodeId !== nodeId && !suppressSave) {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            const prev = EditorState.getNode(loadedNodeId);
            if (prev) {
                EditorState.updateNode(loadedNodeId, {
                    title: fields.title.value,
                    summary: fields.summary.value,
                    content: htmlToMarkdown(contentEl.innerHTML),
                    difficulty: fields.difficulty.value || undefined,
                    estimatedTime: fields.time.value || undefined,
                    order: fields.order.value ? parseInt(fields.order.value) : undefined
                });
            }
        }

        const node = EditorState.getNode(nodeId);
        if (!node) return;

        loadedNodeId = nodeId;
        suppressSave = true;
        editorEl.hidden = false;
        emptyState.hidden = true;

        fields.id.value = node.id;
        fields.title.value = node.title || '';
        fields.summary.value = node.summary || '';
        fields.difficulty.value = node.difficulty || '';
        fields.time.value = node.estimatedTime || '';
        fields.order.value = node.order || '';

        contentEl.innerHTML = markdownToHtml(node.content || '');

        renderTags(node.tags || []);
        renderChildren(node.children || []);
        renderConnections(node.connections || []);
        renderMedia(node.media || []);
        updatePreview();
        updateWordCount();

        hideAllInlineForms();
        suppressSave = false;
    }

    // --- Auto-save ---

    function setupAutoSave() {
        const doSave = () => {
            saveTimer = null;
            if (suppressSave || !loadedNodeId) return;
            EditorState.updateNode(loadedNodeId, {
                title: fields.title.value,
                summary: fields.summary.value,
                content: htmlToMarkdown(contentEl.innerHTML),
                difficulty: fields.difficulty.value || undefined,
                estimatedTime: fields.time.value || undefined,
                order: fields.order.value ? parseInt(fields.order.value) : undefined
            });
            updatePreview();
            updateWordCount();
        };

        const scheduleSave = () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(doSave, 400);
        };

        Object.values(fields).forEach(el => {
            if (el === fields.id) return;
            el.addEventListener('input', scheduleSave);
            el.addEventListener('change', scheduleSave);
        });

        contentEl.addEventListener('input', scheduleSave);
    }

    function flushContent() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (suppressSave || !loadedNodeId) return;
        const node = EditorState.getNode(loadedNodeId);
        if (!node) return;
        EditorState.updateNode(loadedNodeId, {
            title: fields.title.value,
            summary: fields.summary.value,
            content: htmlToMarkdown(contentEl.innerHTML),
            difficulty: fields.difficulty.value || undefined,
            estimatedTime: fields.time.value || undefined,
            order: fields.order.value ? parseInt(fields.order.value) : undefined
        });
    }

    // --- Rich text toolbar ---

    function setupToolbar() {
        document.querySelectorAll('.toolbar-btn').forEach(btn => {
            btn.addEventListener('mousedown', e => e.preventDefault());
            btn.addEventListener('click', e => {
                e.preventDefault();
                applyFormat(btn.dataset.action);
            });
        });
    }

    function applyFormat(action) {
        contentEl.focus();
        switch (action) {
            case 'bold':
                document.execCommand('bold', false);
                break;
            case 'italic':
                document.execCommand('italic', false);
                break;
            case 'h2':
                toggleHeading('h2');
                break;
            case 'h3':
                toggleHeading('h3');
                break;
            case 'paragraph':
                document.execCommand('formatBlock', false, '<p>');
                break;
            case 'ul':
                document.execCommand('insertUnorderedList', false);
                break;
            case 'ol':
                document.execCommand('insertOrderedList', false);
                break;
            case 'quote':
                toggleQuote();
                break;
            case 'example':
                insertExampleBlock();
                break;
            case 'code':
                wrapSelectionWith('code');
                break;
            case 'link':
                showLinkInput();
                break;
            case 'hr':
                document.execCommand('insertHorizontalRule', false);
                break;
        }
        contentEl.dispatchEvent(new Event('input'));
    }

    function wrapSelectionWith(tag) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        const el = document.createElement(tag);
        try {
            range.surroundContents(el);
        } catch (e) {
            el.textContent = sel.toString();
            range.deleteContents();
            range.insertNode(el);
        }
    }

    function applyBlockquote() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const anchorNode = sel.anchorNode;
        if (!anchorNode) return;
        const anchorEl = anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
        if (!anchorEl) return;

        let block = anchorEl;
        while (block.parentElement && block.parentElement !== contentEl) {
            block = block.parentElement;
        }
        if (!block || block === contentEl) {
            document.execCommand('formatBlock', false, '<blockquote>');
            return;
        }

        const tag = block.tagName.toLowerCase();
        if (tag === 'ul' || tag === 'ol') return;

        const bq = document.createElement('blockquote');
        if (tag === 'p' || tag === 'div') {
            while (block.firstChild) bq.appendChild(block.firstChild);
            block.parentNode.replaceChild(bq, block);
        } else {
            block.parentNode.insertBefore(bq, block);
            bq.appendChild(block);
        }
    }

    function toggleHeading(tag) {
        contentEl.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const anchorEl = sel.anchorNode
            ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode)
            : null;
        if (!anchorEl) return;

        let block = anchorEl;
        while (block.parentElement && block.parentElement !== contentEl) {
            block = block.parentElement;
        }

        if (block && block.tagName && block.tagName.toLowerCase() === tag) {
            document.execCommand('formatBlock', false, '<p>');
        } else {
            document.execCommand('formatBlock', false, '<' + tag + '>');
        }
    }

    function toggleQuote() {
        contentEl.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const anchorEl = sel.anchorNode
            ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode)
            : null;
        const bq = anchorEl ? anchorEl.closest('blockquote') : null;

        if (bq) {
            const p = document.createElement('p');
            while (bq.firstChild) p.appendChild(bq.firstChild);
            bq.parentNode.replaceChild(p, bq);
        } else {
            applyBlockquote();
        }
        contentEl.dispatchEvent(new Event('input'));
    }

    function insertExampleBlock() {
        contentEl.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const anchorEl = sel.anchorNode
            ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode)
            : null;
        const existing = anchorEl ? anchorEl.closest('.example-block') : null;

        if (existing) {
            const frag = document.createDocumentFragment();
            while (existing.firstChild) {
                if (existing.firstChild.classList && existing.firstChild.classList.contains('example-label')) {
                    existing.removeChild(existing.firstChild);
                    continue;
                }
                frag.appendChild(existing.firstChild);
            }
            existing.parentNode.replaceChild(frag, existing);
        } else {
            const div = document.createElement('div');
            div.className = 'example-block';
            const label = document.createElement('span');
            label.className = 'example-label';
            label.textContent = '';
            label.contentEditable = 'false';
            div.appendChild(label);

            const range = sel.getRangeAt(0);
            const hasSelection = !range.collapsed;

            if (hasSelection) {
                const contents = range.extractContents();
                div.appendChild(contents);
            } else {
                const p = document.createElement('p');
                p.innerHTML = '<br>';
                div.appendChild(p);
            }

            let block = anchorEl;
            while (block && block.parentElement && block.parentElement !== contentEl) {
                block = block.parentElement;
            }
            if (block && block !== contentEl && !block.textContent.trim()) {
                block.parentNode.replaceChild(div, block);
            } else {
                range.insertNode(div);
            }

            const lastChild = div.lastElementChild || div.lastChild;
            if (lastChild) {
                const newRange = document.createRange();
                newRange.selectNodeContents(lastChild);
                newRange.collapse(false);
                sel.removeAllRanges();
                sel.addRange(newRange);
            }
        }
        contentEl.dispatchEvent(new Event('input'));
    }

    // --- Link insertion with inline URL input ---

    let savedRange = null;

    function showLinkInput() {
        const sel = window.getSelection();
        if (sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();

        const form = document.getElementById('link-input-form');
        const urlInput = document.getElementById('link-url-input');
        const textInput = document.getElementById('link-text-input');
        textInput.value = sel.toString() || '';
        urlInput.value = '';
        form.hidden = false;
        urlInput.focus();
    }

    function commitLink() {
        const form = document.getElementById('link-input-form');
        const url = document.getElementById('link-url-input').value.trim();
        const text = document.getElementById('link-text-input').value.trim() || url;
        form.hidden = true;

        if (!url) return;
        if (/^javascript:/i.test(url)) { toast('Invalid URL', 'error'); return; }

        contentEl.focus();
        if (savedRange) {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(savedRange);
        }
        document.execCommand('insertHTML', false, `<a href="${escHtml(url)}">${escHtml(text)}</a>`);
        savedRange = null;
        contentEl.dispatchEvent(new Event('input'));
    }

    function cancelLink() {
        document.getElementById('link-input-form').hidden = true;
        savedRange = null;
        contentEl.focus();
    }

    function setupContentEditor() {
        contentEl.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                const sel = window.getSelection();
                if (!sel.rangeCount) return;
                const node = sel.anchorNode;
                const block = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
                const tag = block.tagName ? block.tagName.toLowerCase() : '';

                if (tag === 'li' || block.closest('li')) return;

                if (['h1', 'h2', 'h3', 'h4'].includes(tag)) {
                    e.preventDefault();
                    let heading = block;
                    while (heading.parentElement && heading.parentElement !== contentEl) {
                        heading = heading.parentElement;
                    }
                    const range = sel.getRangeAt(0);
                    const afterRange = document.createRange();
                    afterRange.setStart(range.endContainer, range.endOffset);
                    afterRange.setEnd(heading, heading.childNodes.length);
                    const afterContent = afterRange.extractContents();
                    const p = document.createElement('p');
                    if (afterContent.textContent.trim()) {
                        p.appendChild(afterContent);
                    } else {
                        p.innerHTML = '<br>';
                    }
                    contentEl.insertBefore(p, heading.nextSibling);
                    const newRange = document.createRange();
                    newRange.setStart(p, 0);
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                    contentEl.dispatchEvent(new Event('input'));
                    return;
                }

                const bq = block.closest ? block.closest('blockquote') : null;
                if (bq) {
                    e.preventDefault();
                    if (!block.textContent.trim() && block !== bq) {
                        bq.removeChild(block);
                    }
                    const p = document.createElement('p');
                    p.innerHTML = '<br>';
                    bq.parentNode.insertBefore(p, bq.nextSibling);
                    const range = document.createRange();
                    range.setStart(p, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    contentEl.dispatchEvent(new Event('input'));
                    return;
                }
            }

            // Ctrl shortcuts
            if (e.ctrlKey && !e.altKey) {
                const key = e.key.toLowerCase();
                const map = { 'b': 'bold', 'i': 'italic', '2': 'h2', '3': 'h3', 'u': 'ul', 'q': 'quote', 'e': 'example', 'l': 'link', '0': 'paragraph' };
                if (map[key]) {
                    e.preventDefault();
                    applyFormat(map[key]);
                }
            }

            // Tab in lists
            if (e.key === 'Tab') {
                const sel = window.getSelection();
                if (!sel.anchorNode) return;
                const node = sel.anchorNode;
                const li = node.nodeType === Node.TEXT_NODE ? node.parentElement.closest('li') : node.closest('li');
                if (li) {
                    e.preventDefault();
                    document.execCommand(e.shiftKey ? 'outdent' : 'indent', false);
                } else {
                    // Prevent losing focus from content area
                    e.preventDefault();
                }
            }
        });

        contentEl.addEventListener('paste', e => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        });

        // Link form setup
        document.getElementById('link-confirm').addEventListener('click', commitLink);
        document.getElementById('link-cancel').addEventListener('click', cancelLink);
        document.getElementById('link-url-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); commitLink(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelLink(); }
        });
        document.getElementById('link-text-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); commitLink(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelLink(); }
        });
    }

    // --- Word count ---

    function setupWordCount() {
        EditorState.on('node-updated', updateWordCount);
        EditorState.on('node-selected', updateWordCount);
    }

    function updateWordCount() {
        const el = document.getElementById('word-count');
        if (!el) return;
        const nodeWords = EditorState.getWordCount(EditorState.getSelectedNodeId());
        const totalWords = EditorState.getWordCount();
        el.textContent = `${nodeWords} words / ${totalWords} total`;
    }

    // --- Tags ---

    function setupTags() {
        const input = document.getElementById('tag-input');
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && input.value.trim()) {
                e.preventDefault();
                const tag = input.value.trim().toLowerCase().replace(/[^a-z0-9-\s]/g, '').replace(/\s+/g, '-');
                const node = EditorState.getSelectedNode();
                if (!node) return;
                const tags = [...(node.tags || [])];
                if (!tags.includes(tag)) {
                    tags.push(tag);
                    EditorState.updateNode(node.id, { tags });
                    renderTags(tags);
                }
                input.value = '';
            }
            if (e.key === 'Backspace' && !input.value) {
                const node = EditorState.getSelectedNode();
                if (!node || !node.tags || !node.tags.length) return;
                const tags = [...node.tags];
                tags.pop();
                EditorState.updateNode(node.id, { tags });
                renderTags(tags);
            }
        });
    }

    function renderTags(tags) {
        const container = document.getElementById('tags-container');
        container.innerHTML = tags.map(tag => `
            <span class="tag-pill">
                ${escHtml(tag)}
                <span class="tag-remove" data-tag="${escHtml(tag)}" role="button" tabindex="0" aria-label="Remove ${escHtml(tag)}">×</span>
            </span>
        `).join('');

        container.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => removeTag(btn.dataset.tag));
            btn.addEventListener('keydown', e => { if (e.key === 'Enter') removeTag(btn.dataset.tag); });
        });
    }

    function removeTag(tag) {
        const node = EditorState.getSelectedNode();
        if (!node) return;
        const newTags = (node.tags || []).filter(t => t !== tag);
        EditorState.updateNode(node.id, { tags: newTags });
        renderTags(newTags);
    }

    // --- Children ---

    function setupChildren() {
        const addBtn = document.getElementById('btn-add-child');
        const form = document.getElementById('add-child-form');
        const select = document.getElementById('add-child-select');
        const confirmBtn = document.getElementById('add-child-confirm');
        const cancelBtn = document.getElementById('add-child-cancel');

        addBtn.addEventListener('click', () => {
            // Toggle behavior
            if (!form.hidden) { form.hidden = true; return; }
            const node = EditorState.getSelectedNode();
            if (!node) return;
            const allIds = EditorState.getAllNodeIds();
            const available = allIds.filter(id => id !== node.id && !(node.children || []).includes(id));
            if (available.length === 0) {
                toast('No available nodes — create a new node first', 'info');
                return;
            }
            select.innerHTML = '<option value="">Select a node...</option>' +
                available.map(id => {
                    const n = EditorState.getNode(id);
                    return `<option value="${id}">${n ? escHtml(n.title) : id} (${id})</option>`;
                }).join('');
            form.hidden = false;
            select.focus();
        });

        const doAdd = () => {
            const val = select.value;
            if (!val) return;
            const node = EditorState.getSelectedNode();
            if (!node) return;
            EditorState.pushUndo();
            const children = [...(node.children || []), val];
            EditorState.updateNode(node.id, { children });
            renderChildren(children);
            form.hidden = true;
        };

        confirmBtn.addEventListener('click', doAdd);
        select.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
        cancelBtn.addEventListener('click', () => { form.hidden = true; });

        // Quick-create child button
        document.getElementById('btn-new-child').addEventListener('click', () => {
            showNewNodeModal(true);
        });
    }

    function renderChildren(children) {
        const list = document.getElementById('children-list');
        if (!children || children.length === 0) {
            list.innerHTML = '<div class="empty-hint">No child sections yet</div>';
            return;
        }
        list.innerHTML = children.map((childId, i) => {
            const child = EditorState.getNode(childId);
            const label = child ? child.title : childId;
            return `<div class="link-item">
                <span class="link-order">${i + 1}</span>
                <span class="link-target" data-id="${childId}">${escHtml(label)}</span>
                <button class="link-move" data-dir="up" data-index="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
                <button class="link-move" data-dir="down" data-index="${i}" title="Move down" ${i === children.length - 1 ? 'disabled' : ''}>&#9660;</button>
                <button class="link-remove" data-child="${childId}" title="Remove">×</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.link-target').forEach(el => {
            el.addEventListener('click', () => EditorState.selectNode(el.dataset.id));
        });

        list.querySelectorAll('.link-remove').forEach(el => {
            el.addEventListener('click', () => {
                EditorState.pushUndo();
                const node = EditorState.getSelectedNode();
                const newChildren = (node.children || []).filter(c => c !== el.dataset.child);
                EditorState.updateNode(node.id, { children: newChildren });
                renderChildren(newChildren);
            });
        });

        list.querySelectorAll('.link-move').forEach(el => {
            el.addEventListener('click', () => {
                const node = EditorState.getSelectedNode();
                if (!node) return;
                EditorState.pushUndo();
                const arr = [...(node.children || [])];
                const idx = parseInt(el.dataset.index);
                const dir = el.dataset.dir;
                const swap = dir === 'up' ? idx - 1 : idx + 1;
                if (swap < 0 || swap >= arr.length) return;
                [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
                EditorState.updateNode(node.id, { children: arr });
                renderChildren(arr);
            });
        });
    }

    // --- Connections ---

    function setupConnections() {
        const addBtn = document.getElementById('btn-add-connection');
        const form = document.getElementById('add-conn-form');
        const targetSelect = document.getElementById('add-conn-target');
        const confirmBtn = document.getElementById('add-conn-confirm');
        const cancelBtn = document.getElementById('add-conn-cancel');

        addBtn.addEventListener('click', () => {
            if (!form.hidden) { form.hidden = true; return; }
            const node = EditorState.getSelectedNode();
            if (!node) return;
            const allIds = EditorState.getAllNodeIds().filter(id => id !== node.id);
            targetSelect.innerHTML = '<option value="">Target node...</option>' +
                allIds.map(id => {
                    const n = EditorState.getNode(id);
                    return `<option value="${id}">${n ? escHtml(n.title) : id}</option>`;
                }).join('');
            document.getElementById('add-conn-label').value = '';
            form.hidden = false;
            targetSelect.focus();
        });

        const doAddConn = () => {
            const target = targetSelect.value;
            if (!target) return;
            const node = EditorState.getSelectedNode();
            if (!node) return;
            EditorState.pushUndo();
            const type = document.getElementById('add-conn-type').value;
            const label = document.getElementById('add-conn-label').value;
            const connections = [...(node.connections || []), { to: target, type, label }];
            EditorState.updateNode(node.id, { connections });
            renderConnections(connections);
            form.hidden = true;
        };

        confirmBtn.addEventListener('click', doAddConn);
        // Enter on any field in the form submits
        [targetSelect, document.getElementById('add-conn-type'), document.getElementById('add-conn-label')].forEach(el => {
            el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAddConn(); } });
        });
        cancelBtn.addEventListener('click', () => { form.hidden = true; });
    }

    function renderConnections(connections) {
        const list = document.getElementById('connections-list');
        if (!connections || connections.length === 0) {
            list.innerHTML = '<div class="empty-hint">No cross-links yet</div>';
            return;
        }
        list.innerHTML = connections.map((conn, i) => {
            const target = EditorState.getNode(conn.to);
            const label = target ? target.title : conn.to;
            return `<div class="link-item">
                <span class="link-type-badge conn-${conn.type || 'related'}">${conn.type || 'related'}</span>
                <span class="link-target" data-id="${conn.to}">${escHtml(label)}</span>
                ${conn.label ? `<span class="link-label">${escHtml(conn.label)}</span>` : ''}
                <button class="link-remove" data-index="${i}" title="Remove">×</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.link-target').forEach(el => {
            el.addEventListener('click', () => EditorState.selectNode(el.dataset.id));
        });

        list.querySelectorAll('.link-remove').forEach(el => {
            el.addEventListener('click', () => {
                EditorState.pushUndo();
                const node = EditorState.getSelectedNode();
                const conns = [...(node.connections || [])];
                conns.splice(parseInt(el.dataset.index), 1);
                EditorState.updateNode(node.id, { connections: conns });
                renderConnections(conns);
            });
        });
    }

    // --- Media ---

    function setupMedia() {
        const addBtn = document.getElementById('btn-add-media');
        const form = document.getElementById('add-media-form');
        const confirmBtn = document.getElementById('add-media-confirm');
        const cancelBtn = document.getElementById('add-media-cancel');

        addBtn.addEventListener('click', () => {
            if (!form.hidden) { form.hidden = true; return; }
            document.getElementById('add-media-src').value = '';
            document.getElementById('add-media-alt').value = '';
            form.hidden = false;
            document.getElementById('add-media-src').focus();
        });

        const doAddMedia = () => {
            const src = document.getElementById('add-media-src').value.trim();
            if (!src) { toast('URL or path is required', 'error'); return; }
            const node = EditorState.getSelectedNode();
            if (!node) return;
            const type = document.getElementById('add-media-type').value;
            const alt = document.getElementById('add-media-alt').value;
            const media = [...(node.media || []), { type, src, alt, caption: '', position: 'inline' }];
            EditorState.updateNode(node.id, { media });
            renderMedia(media);
            form.hidden = true;
        };

        confirmBtn.addEventListener('click', doAddMedia);
        [document.getElementById('add-media-src'), document.getElementById('add-media-alt')].forEach(el => {
            el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAddMedia(); } });
        });
        cancelBtn.addEventListener('click', () => { form.hidden = true; });
    }

    function renderMedia(media) {
        const list = document.getElementById('media-list');
        if (!media || media.length === 0) {
            list.innerHTML = '<div class="empty-hint">No media attached</div>';
            return;
        }
        list.innerHTML = media.map((m, i) => `
            <div class="media-item-editor">
                <span class="media-type-badge">${m.type}</span>
                <span class="media-src" title="${escHtml(m.src)}">${escHtml(m.src)}</span>
                ${m.alt ? `<span class="media-alt">${escHtml(m.alt)}</span>` : ''}
                <button class="link-remove" data-index="${i}" title="Remove">×</button>
            </div>
        `).join('');

        list.querySelectorAll('.link-remove').forEach(el => {
            el.addEventListener('click', () => {
                const node = EditorState.getSelectedNode();
                const arr = [...(node.media || [])];
                arr.splice(parseInt(el.dataset.index), 1);
                EditorState.updateNode(node.id, { media: arr });
                renderMedia(arr);
            });
        });
    }

    // --- Delete & Duplicate ---

    function setupDeleteNode() {
        document.getElementById('btn-delete-node').addEventListener('click', () => {
            const node = EditorState.getSelectedNode();
            if (!node) return;
            if (node.id === EditorState.getData().root) {
                toast('Cannot delete the root node', 'error');
                return;
            }
            if (confirm(`Delete "${node.title}"? This cannot be undone.`)) {
                EditorState.deleteNode(node.id);
            }
        });
    }

    function setupDuplicate() {
        document.getElementById('btn-duplicate-node').addEventListener('click', () => {
            const node = EditorState.getSelectedNode();
            if (!node) return;
            const newId = EditorState.duplicateNode(node.id);
            if (newId) {
                EditorState.selectNode(newId);
                toast('Duplicated as "' + EditorState.getNode(newId).title + '"', 'success');
            }
        });
    }

    // --- Preview ---

    function updatePreview() {
        const pane = document.getElementById('preview-pane');
        const node = EditorState.getSelectedNode();
        if (!node || !pane) return;

        let html = `<h2 style="margin-bottom:4px">${escHtml(node.title)}</h2>`;
        if (node.summary) html += `<p style="color:var(--text-dim);font-style:italic;margin-bottom:12px">${escHtml(node.summary)}</p>`;
        html += contentEl.innerHTML;

        if (node.children && node.children.length > 0) {
            html += '<div style="margin-top:16px;padding-top:8px;border-top:1px solid var(--border)">';
            html += '<p style="font-size:11px;color:var(--text-faint);text-transform:uppercase">Sub-sections:</p>';
            node.children.forEach(id => {
                const c = EditorState.getNode(id);
                if (c) html += `<div style="padding:4px 0;color:var(--accent)">${escHtml(c.title)}</div>`;
            });
            html += '</div>';
        }

        pane.innerHTML = html;
    }

    // --- Utilities ---

    function hideAllInlineForms() {
        document.querySelectorAll('.inline-add-form').forEach(f => f.hidden = true);
    }

    function escHtml(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function toast(msg, type) {
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        el.classList.add('toast', type || 'info');
        el.textContent = msg;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 200);
        }, 3000);
    }

    return { init, toast, applyFormat, updatePreview, commitLink, cancelLink, flushContent };
})();
