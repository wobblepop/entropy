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
    let contentDirty = false;  // true once the user actually edits content (guards lossy re-serialization)

    function init() {
        editorEl = document.getElementById('node-editor');
        emptyState = document.getElementById('empty-state');
        contentEl = document.getElementById('edit-content');

        fields = {
            id: document.getElementById('edit-id'),
            title: document.getElementById('edit-title'),
            summary: document.getElementById('edit-summary'),
            notes: document.getElementById('edit-notes'),
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
        setupLinkPopup();
        setupTags();
        setupChildren();
        setupConnections();
        setupMedia();
        setupDeleteNode();
        setupDuplicate();
        setupWordCount();
    }

    // --- Rich text <-> Markdown conversion ---

    function escHtmlText(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Footnote/reference collection for the read-only Preview pane. When _fnEd is
    // a live array, inline links render as numbered superscripts (and are gathered
    // into a References list, mirroring the Viewer). When null — which is always
    // the case while writing the contenteditable surface — links instead render as
    // atomic "link pills" that are edited via a hover popup. Keeping the editing
    // surface in pill mode means the markdown round-trip is never altered.
    let _fnEd = null;
    let _fnPrefixEd = '';

    function fnSanitizeId(s) {
        return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '-') || 'fn';
    }

    // Inline markdown -> HTML. Escapes first so <, >, & can never corrupt markup.
    function inlineFormat(text) {
        let t = escHtmlText(text);
        // images first (before links, since ![]() contains []())
        t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => `<img src="${src.replace(/"/g, '&quot;')}" alt="${alt}">`);
        t = t.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
        t = t.replace(/`(.+?)`/g, '<code>$1</code>');
        t = t.replace(/~~(.+?)~~/g, '<del>$1</del>');
        t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
            if (_fnEd) {
                const n = _fnEd.length + 1;
                _fnEd.push({ n, txt, url });
                // Preview mirrors the Viewer: keep the clickable link AND add the
                // superscript reference marker.
                return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">${txt}</a>` +
                    `<sup class="footnote-ref" id="fnref-${_fnPrefixEd}-${n}">` +
                    `<a href="#fn-${_fnPrefixEd}-${n}">${n}</a></sup>`;
            }
            return `<a href="${url.replace(/"/g, '&quot;')}" class="link-pill" contenteditable="false">${txt}</a>`;
        });
        return t;
    }

    // Markdown -> HTML for the contenteditable surface.
    // Block-aware (multi-line code/blockquote/table/list), heading levels 1-6,
    // blank line = paragraph break (so structure round-trips cleanly).
    function markdownToHtml(md) {
        if (!md) return '';
        const lines = md.split('\n');
        const result = [];
        let para = [];

        function flushPara() {
            if (para.length) {
                result.push('<p>' + para.map(inlineFormat).join('<br>') + '</p>');
                para = [];
            }
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // fenced code block
            if (line.startsWith('```')) {
                flushPara();
                const code = [];
                i++;
                while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
                result.push('<pre><code>' + escHtmlText(code.join('\n')) + '</code></pre>');
                continue;
            }

            // example block — inner is parsed as full markdown (nested code, lists, etc.)
            if (/^:::example\s*$/i.test(line)) {
                flushPara();
                const ex = [];
                i++;
                while (i < lines.length && !/^:::\s*$/.test(lines[i])) { ex.push(lines[i]); i++; }
                const inner = markdownToHtml(ex.join('\n'));
                result.push('<div class="example-block"><span class="example-label" contenteditable="false"></span>' + inner + '</div>');
                continue;
            }

            const trimmed = line.trim();

            // blank line ends a paragraph
            if (!trimmed) { flushPara(); continue; }

            // headings 1-6
            let m = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (m) { flushPara(); const lvl = m[1].length; result.push(`<h${lvl}>${inlineFormat(m[2])}</h${lvl}>`); continue; }

            // horizontal rule
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); result.push('<hr>'); continue; }

            // blockquote (consecutive > lines)
            if (/^>\s?/.test(line) || line === '>') {
                flushPara();
                const bq = [];
                while (i < lines.length && (/^>\s?/.test(lines[i]) || lines[i] === '>')) {
                    const c = lines[i].replace(/^>\s?/, '').trim();
                    if (c) bq.push(c);
                    i++;
                }
                i--;
                result.push('<blockquote>' + bq.map(l => '<p>' + inlineFormat(l) + '</p>').join('') + '</blockquote>');
                continue;
            }

            // table (consecutive pipe rows)
            if (trimmed.startsWith('|')) {
                flushPara();
                const tbl = [];
                while (i < lines.length && lines[i].trim().startsWith('|')) { tbl.push(lines[i].trim()); i++; }
                i--;
                const rows = tbl.map(r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
                let html = '<table>';
                let bodyStart = 0;
                if (rows.length >= 2 && rows[1].every(c => /^:?-+:?$/.test(c) || c === '')) {
                    html += '<thead><tr>' + rows[0].map(c => '<th>' + inlineFormat(c) + '</th>').join('') + '</tr></thead>';
                    bodyStart = 2;
                }
                html += '<tbody>';
                for (let r = bodyStart; r < rows.length; r++) {
                    html += '<tr>' + rows[r].map(c => '<td>' + inlineFormat(c) + '</td>').join('') + '</tr>';
                }
                html += '</tbody></table>';
                result.push(html);
                continue;
            }

            // unordered list
            if (/^[-*+]\s/.test(trimmed)) {
                flushPara();
                const items = [];
                while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
                i--;
                result.push('<ul>' + items.map(it => '<li>' + inlineFormat(it) + '</li>').join('') + '</ul>');
                continue;
            }

            // ordered list
            if (/^\d+\.\s/.test(trimmed)) {
                flushPara();
                const items = [];
                while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
                i--;
                result.push('<ol>' + items.map(it => '<li>' + inlineFormat(it) + '</li>').join('') + '</ol>');
                continue;
            }

            // accumulate paragraph line
            para.push(line);
        }

        flushPara();
        return result.join('\n');
    }

    function htmlToMarkdown(html) {
        if (!html) return '';
        const div = document.createElement('div');
        div.innerHTML = html;
        let md = nodeToMd(div);
        // normalize: strip trailing spaces, collapse 3+ blank lines to one, trim
        md = md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        return md;
    }

    function tableToMd(table) {
        const rows = [];
        table.querySelectorAll('tr').forEach(tr => {
            const cells = [...tr.children].map(c =>
                nodeToMd(c).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'));
            rows.push(cells);
        });
        if (!rows.length) return '';
        const headerCount = table.querySelector('thead') ? table.querySelectorAll('thead tr').length : 0;
        const out = [];
        rows.forEach((cells, idx) => {
            out.push('| ' + cells.join(' | ') + ' |');
            if (idx === headerCount - 1 || (headerCount === 0 && idx === 0)) {
                out.push('| ' + cells.map(() => '---').join(' | ') + ' |');
            }
        });
        return out.join('\n');
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
                    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
                        md += '\n' + '#'.repeat(parseInt(tag[1])) + ' ' + inner.trim() + '\n\n';
                        break;
                    case 'strong': case 'b': md += '**' + inner + '**'; break;
                    case 'em': case 'i': md += '*' + inner + '*'; break;
                    case 'del': case 's': case 'strike': md += '~~' + inner + '~~'; break;
                    case 'code':
                        // bare inline code only; code inside <pre> is handled by the 'pre' case
                        md += child.closest('pre') ? inner : '`' + inner + '`';
                        break;
                    case 'a': md += '[' + inner + '](' + (child.getAttribute('href') || '') + ')'; break;
                    case 'img': md += '![' + (child.getAttribute('alt') || '') + '](' + (child.getAttribute('src') || '') + ')'; break;
                    case 'br': md += '\n'; break;
                    case 'blockquote': {
                        const lines = inner.trim().split('\n').filter(l => l.trim());
                        md += '\n' + lines.map(l => '> ' + l.trim()).join('\n') + '\n\n';
                        break;
                    }
                    case 'pre': {
                        const codeEl = child.querySelector('code');
                        const codeText = (codeEl ? codeEl.textContent : child.textContent).replace(/\n$/, '');
                        md += '\n```\n' + codeText + '\n```\n\n';
                        break;
                    }
                    case 'ul': case 'ol': {
                        let n = 1;
                        for (const li of child.querySelectorAll(':scope > li')) {
                            const liMd = nodeToMd(li).trim().replace(/\s*\n\s*/g, ' ');
                            md += (tag === 'ol' ? (n++) + '. ' : '- ') + liMd + '\n';
                        }
                        md += '\n';
                        break;
                    }
                    case 'li': md += inner; break;
                    case 'hr': md += '\n---\n\n'; break;
                    case 'table': md += '\n' + tableToMd(child) + '\n\n'; break;
                    case 'thead': case 'tbody': case 'tr': case 'th': case 'td':
                        md += inner; break;
                    case 'p':
                    case 'div': {
                        if (child.classList && child.classList.contains('example-block')) {
                            const wrapper = child.cloneNode(true);
                            wrapper.querySelectorAll('.example-label').forEach(e => e.remove());
                            // keep the inner markdown structure intact (don't flatten
                            // blank lines — code blocks and paragraphs depend on them)
                            const exMd = nodeToMd(wrapper).replace(/\n{3,}/g, '\n\n').trim();
                            md += '\n:::example\n' + exMd + '\n:::\n\n';
                        } else {
                            const t = inner.trim();
                            if (t) md += t + '\n\n';
                        }
                        break;
                    }
                    case 'span':
                        if (!(child.classList && child.classList.contains('example-label'))) md += inner;
                        break;
                    default: md += inner; break;
                }
            }
        }
        return md;
    }

    // --- Content collection ---

    // The markdown for the node currently being edited. If the editor surface
    // was never touched, returns the stored markdown verbatim — so merely
    // viewing a node never re-serializes (and never corrupts) its content.
    function readActiveContent() {
        if (contentDirty) return htmlToMarkdown(contentEl.innerHTML);
        const node = loadedNodeId ? EditorState.getNode(loadedNodeId) : null;
        return node ? (node.content || '') : '';
    }

    // True if the collected changes actually differ from the stored node —
    // used to avoid marking the file dirty just by navigating between nodes.
    function nodeChanged(node, c) {
        if (!node) return true;
        const norm = v => (v === undefined || v === null) ? '' : v;
        return norm(node.title) !== norm(c.title)
            || norm(node.summary) !== norm(c.summary)
            || norm(node.notes) !== norm(c.notes)
            || norm(node.content) !== norm(c.content)
            || norm(node.difficulty) !== norm(c.difficulty)
            || norm(node.estimatedTime) !== norm(c.estimatedTime)
            || norm(node.order) !== norm(c.order);
    }

    function collectChanges() {
        return {
            title: fields.title.value,
            summary: fields.summary.value,
            notes: fields.notes.value || undefined,
            content: readActiveContent(),
            difficulty: fields.difficulty.value || undefined,
            estimatedTime: fields.time.value || undefined,
            order: fields.order.value ? parseInt(fields.order.value) : undefined
        };
    }

    // --- Node loading ---

    function loadNode(nodeId) {
        if (loadedNodeId && loadedNodeId !== nodeId && !suppressSave) {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            const prev = EditorState.getNode(loadedNodeId);
            if (prev) {
                const changes = collectChanges();
                if (nodeChanged(prev, changes)) {
                    EditorState.updateNode(loadedNodeId, changes);
                }
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
        fields.notes.value = node.notes || '';
        fields.difficulty.value = node.difficulty || '';
        fields.time.value = node.estimatedTime || '';
        fields.order.value = node.order || '';

        contentEl.innerHTML = markdownToHtml(node.content || '');
        contentDirty = false;

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
            EditorState.updateNode(loadedNodeId, collectChanges());
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

        contentEl.addEventListener('input', () => { contentDirty = true; scheduleSave(); });
    }

    function flushContent() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (suppressSave || !loadedNodeId) return;
        const node = EditorState.getNode(loadedNodeId);
        if (!node) return;
        EditorState.updateNode(loadedNodeId, collectChanges());
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
            case 'strikethrough':
                document.execCommand('strikeThrough', false);
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
                toggleInlineCode();
                break;
            case 'codeblock':
                insertCodeBlock();
                break;
            case 'link':
                showLinkInput();
                break;
            case 'hr':
                document.execCommand('insertHorizontalRule', false);
                break;
            case 'clear':
                clearFormatting();
                break;
        }
        contentEl.dispatchEvent(new Event('input'));
    }

    // Inline code: toggle on a plain selection, or off when the caret is in a `code`.
    function toggleInlineCode() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const anchorEl = sel.anchorNode
            ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode)
            : null;
        const existing = anchorEl ? anchorEl.closest('code') : null;
        if (existing && !existing.closest('pre')) {
            const parent = existing.parentNode;
            while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
            parent.removeChild(existing);
            contentEl.normalize();
            return;
        }
        if (sel.isCollapsed) return;
        wrapSelectionWith('code');
    }

    // Fenced code block: wraps the selection (or an empty block to type/paste into).
    function insertCodeBlock() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const anchorEl = sel.anchorNode
            ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode)
            : null;
        if (anchorEl && anchorEl.closest('pre')) return;  // already in a code block

        const range = sel.getRangeAt(0);
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = sel.toString();
        pre.appendChild(code);

        let block = anchorEl;
        while (block && block.parentElement && block.parentElement !== contentEl) block = block.parentElement;

        if (block && block !== contentEl && !block.textContent.trim()) {
            block.parentNode.replaceChild(pre, block);
        } else if (!range.collapsed) {
            range.deleteContents();
            range.insertNode(pre);
        } else if (block && block !== contentEl) {
            block.parentNode.insertBefore(pre, block.nextSibling);
        } else {
            range.insertNode(pre);
        }
        const r = document.createRange();
        r.selectNodeContents(code);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // Strip inline formatting (bold/italic/code/strike/link/etc.) from the selection,
    // leaving plain text. Block structure (headings, lists, code blocks) is preserved.
    function clearFormatting() {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) {
            toast('Select some text first', 'info');
            return;
        }
        const range = sel.getRangeAt(0);
        const INLINE = 'code, strong, b, em, i, del, s, strike, u, a, font, span, sub, sup, mark';
        const toUnwrap = [];
        contentEl.querySelectorAll(INLINE).forEach(el => {
            if (el.classList && el.classList.contains('example-label')) return;
            if (el.closest('pre')) return;            // leave code blocks intact
            if (range.intersectsNode(el)) toUnwrap.push(el);
        });
        if (!toUnwrap.length) {
            toast('No inline formatting in the selection', 'info');
            return;
        }
        toUnwrap.reverse().forEach(el => {          // innermost first
            const parent = el.parentNode;
            if (!parent) return;
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
        });
        contentEl.normalize();
        contentDirty = true;
        contentEl.dispatchEvent(new Event('input'));
        toast('Formatting cleared', 'success');
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
        const sel = window.getSelection();
        if (savedRange) {
            sel.removeAllRanges();
            sel.addRange(savedRange);
        }
        savedRange = null;
        if (!sel.rangeCount) return;

        // Insert the pill with the Range API rather than execCommand('insertHTML').
        // Chrome's insertHTML wraps/splits the block around a contenteditable=false
        // island, which dropped the new link onto its own line with large gaps until
        // a reload re-rendered it from markdown. Direct DOM insertion stays inline.
        const range = sel.getRangeAt(0);
        if (!contentEl.contains(range.commonAncestorContainer)) return;
        range.deleteContents();

        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.className = 'link-pill';
        a.setAttribute('contenteditable', 'false');
        a.textContent = text;

        // A trailing space gives the caret an editable slot after the atomic pill.
        const trailing = document.createTextNode(' ');
        range.insertNode(a);
        a.after(trailing);

        const after = document.createRange();
        after.setStartAfter(trailing);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);

        contentDirty = true;
        contentEl.dispatchEvent(new Event('input'));
    }

    function cancelLink() {
        document.getElementById('link-input-form').hidden = true;
        savedRange = null;
        contentEl.focus();
    }

    // Hover/click popup for editing an existing link in place. Links in the
    // editing surface are atomic "pills" (contenteditable=false); this popup is
    // the only way to change their text/URL, so the raw markdown is never typed
    // over by hand. The popup lives on <body>, outside the contenteditable, so
    // typing in its inputs never mutates node content directly.
    function setupLinkPopup() {
        const popup = document.createElement('div');
        popup.className = 'link-popup';
        popup.hidden = true;
        popup.innerHTML =
            '<div class="link-popup-title">Edit link</div>' +
            '<div class="link-popup-row"><label for="lp-text">Text</label>' +
            '<input id="lp-text" class="link-popup-text" type="text" autocomplete="off"></div>' +
            '<div class="link-popup-row"><label for="lp-url">URL</label>' +
            '<input id="lp-url" class="link-popup-url" type="text" autocomplete="off"></div>' +
            '<div class="link-popup-actions">' +
            '<button type="button" class="link-popup-save">Save</button>' +
            '<button type="button" class="link-popup-remove">Remove link</button>' +
            '<a class="link-popup-open" target="_blank" rel="noopener">Open ↗</a>' +
            '</div>';
        document.body.appendChild(popup);

        const textInput = popup.querySelector('.link-popup-text');
        const urlInput = popup.querySelector('.link-popup-url');
        const saveBtn = popup.querySelector('.link-popup-save');
        const removeBtn = popup.querySelector('.link-popup-remove');
        const openLink = popup.querySelector('.link-popup-open');
        const titleEl = popup.querySelector('.link-popup-title');

        let currentPill = null;
        let hideTimer = null;
        let pinned = false;

        function place(pill) {
            popup.hidden = false; // unhide so we can measure
            const r = pill.getBoundingClientRect();
            const pw = popup.offsetWidth, ph = popup.offsetHeight;
            let left = Math.max(12, Math.min(r.left, window.innerWidth - pw - 12));
            let top = r.bottom + 6;
            if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
            if (top < 8) top = 8;
            popup.style.left = left + 'px';
            popup.style.top = top + 'px';
        }

        function open(pill) {
            currentPill = pill;
            const pills = Array.from(contentEl.querySelectorAll('.link-pill'));
            const idx = pills.indexOf(pill) + 1;
            titleEl.textContent = idx > 0 ? ('Edit link — reference ' + idx) : 'Edit link';
            textInput.value = pill.textContent;
            const href = pill.getAttribute('href') || '';
            urlInput.value = href;
            openLink.href = href;
            place(pill);
        }

        function close() {
            pinned = false;
            popup.hidden = true;
            currentPill = null;
        }
        function hide() { if (!pinned) close(); }
        function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 250); }
        function cancelHide() { clearTimeout(hideTimer); }

        function save() {
            if (!currentPill) return;
            const url = urlInput.value.trim();
            const txt = textInput.value.trim();
            if (!url) { toast('URL cannot be empty', 'error'); return; }
            if (/^\s*javascript:/i.test(url)) { toast('Invalid URL', 'error'); return; }
            currentPill.setAttribute('href', url);
            currentPill.textContent = txt || url;
            close();
            contentDirty = true;
            contentEl.dispatchEvent(new Event('input'));
            toast('Link updated', 'success');
        }

        function removeLink() {
            if (!currentPill) return;
            currentPill.replaceWith(document.createTextNode(currentPill.textContent));
            close();
            contentDirty = true;
            contentEl.dispatchEvent(new Event('input'));
            toast('Link removed', 'success');
        }

        contentEl.addEventListener('mouseover', e => {
            const pill = e.target && e.target.closest && e.target.closest('.link-pill');
            if (pill && contentEl.contains(pill)) {
                cancelHide();
                if (pill !== currentPill || popup.hidden) open(pill);
            }
        });
        contentEl.addEventListener('mouseout', e => {
            const pill = e.target && e.target.closest && e.target.closest('.link-pill');
            if (pill) scheduleHide();
        });
        // A pill is contenteditable=false, so a click won't place a caret — use it
        // to pin the popup open for deliberate editing.
        contentEl.addEventListener('click', e => {
            const pill = e.target && e.target.closest && e.target.closest('.link-pill');
            if (pill && contentEl.contains(pill)) { e.preventDefault(); cancelHide(); open(pill); pinned = true; }
        });

        popup.addEventListener('mouseenter', cancelHide);
        popup.addEventListener('mouseleave', () => { if (!pinned) scheduleHide(); });
        popup.addEventListener('focusin', () => { pinned = true; cancelHide(); });

        saveBtn.addEventListener('click', save);
        removeBtn.addEventListener('click', removeLink);
        [textInput, urlInput].forEach(inp => {
            inp.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); contentEl.focus(); }
            });
        });

        // Click anywhere outside the popup (and not on a pill) closes it.
        document.addEventListener('mousedown', e => {
            if (popup.hidden) return;
            if (popup.contains(e.target)) return;
            if (e.target.closest && e.target.closest('.link-pill')) return;
            close();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !popup.hidden) close();
        });
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
                if (e.shiftKey && key === 's') {   // Ctrl+Shift+S = strikethrough
                    e.preventDefault();
                    applyFormat('strikethrough');
                    return;
                }
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

        // Paste: embed an image from the clipboard as an inline data-URI image,
        // otherwise fall back to plain text (strips foreign rich-text markup).
        const MAX_IMG_BYTES = 8 * 1024 * 1024;

        function clipboardImage(dt) {
            if (!dt) return null;
            const items = dt.items ? Array.from(dt.items) : [];
            for (const it of items) {
                if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) return it.getAsFile();
            }
            const files = dt.files ? Array.from(dt.files) : [];
            for (const f of files) {
                if (f.type && f.type.indexOf('image/') === 0) return f;
            }
            return null;
        }

        function withImageDataUri(file, cb) {
            if (!file) return;
            if (file.size > MAX_IMG_BYTES) { toast('Image too large (max 8 MB)', 'error'); return; }
            const r = new FileReader();
            r.onload = () => cb(r.result);
            r.onerror = () => toast('Could not read image', 'error');
            r.readAsDataURL(file);
        }

        contentEl.addEventListener('paste', e => {
            const img = clipboardImage(e.clipboardData);
            if (img) {
                e.preventDefault();
                withImageDataUri(img, uri => {
                    contentEl.focus();
                    document.execCommand('insertHTML', false, `<img src="${uri}" alt="">`);
                    contentDirty = true;
                    contentEl.dispatchEvent(new Event('input'));
                    toast('Image embedded', 'success');
                });
                return;
            }
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
        el.textContent = `${nodeWords.toLocaleString()} words · ${totalWords.toLocaleString()} total`;
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

    // Render node markdown for the read-only Preview pane with links turned into
    // numbered references + a "References" list (same presentation as the Viewer).
    function renderPreviewWithFootnotes(md, prefix) {
        const pf = fnSanitizeId(prefix);
        const prevFn = _fnEd, prevPf = _fnPrefixEd;
        _fnEd = [];
        _fnPrefixEd = pf;
        let body, collected;
        try {
            body = markdownToHtml(md);
        } finally {
            collected = _fnEd;
            _fnEd = prevFn;
            _fnPrefixEd = prevPf;
        }
        if (!collected.length) return body;
        let refs = '<section class="footnotes" aria-label="References">' +
            '<h2 class="footnotes-title">References</h2><ol class="footnotes-list">';
        collected.forEach(f => {
            const href = f.url.replace(/"/g, '&quot;');
            refs += `<li id="fn-${pf}-${f.n}" class="footnote-item">` +
                `<span class="footnote-text">${f.txt}</span> ` +
                `<a class="footnote-url" href="${href}" target="_blank" rel="noopener">${f.url}</a> ` +
                `<a class="footnote-backref" href="#fnref-${pf}-${f.n}" aria-label="Back to reference ${f.n}">↩</a></li>`;
        });
        refs += '</ol></section>';
        return body + refs;
    }

    function updatePreview() {
        const pane = document.getElementById('preview-pane');
        const node = EditorState.getSelectedNode();
        if (!node || !pane) return;

        let html = `<h2 style="margin-bottom:4px">${escHtml(node.title)}</h2>`;
        if (node.summary) html += `<p style="color:var(--text-dim);font-style:italic;margin-bottom:12px">${escHtml(node.summary)}</p>`;
        html += renderPreviewWithFootnotes(readActiveContent(), node.id);

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
