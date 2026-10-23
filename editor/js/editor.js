/* ============================================
   EDITOR — Rich text node editing
   Contenteditable WYSIWYG with markdown I/O
   ============================================ */

const NodeEditor = (() => {
    let editorEl, emptyState, contentEl, reviewEl, suggestBtn, reviewBtn;
    let fields = {};
    let modifiedEl = null;   // read-only "Edited" stamp in the meta bar
    let createdEl = null;    // read-only "Created" stamp in the meta bar
    let suppressSave = false;
    let saveTimer = null;
    let loadedNodeId = null;
    let contentDirty = false;  // true once the user actually edits content (guards lossy re-serialization)

    function init() {
        editorEl = document.getElementById('node-editor');
        emptyState = document.getElementById('empty-state');
        contentEl = document.getElementById('edit-content');
        reviewEl = document.getElementById('review-content');

        fields = {
            id: document.getElementById('edit-id'),
            title: document.getElementById('edit-title'),
            summary: document.getElementById('edit-summary'),
            notes: document.getElementById('edit-notes'),
            difficulty: document.getElementById('edit-difficulty'),
            time: document.getElementById('edit-time'),
            order: document.getElementById('edit-order')
        };
        modifiedEl = document.getElementById('edit-modified');
        createdEl = document.getElementById('edit-created');

        EditorState.on('node-selected', loadNode);
        EditorState.on('file-loaded', () => {
            emptyState.hidden = true;
            editorEl.hidden = false;
        });
        // Keep the read-only "Edited" stamp current after autosave bumps it.
        EditorState.on('node-updated', id => { if (id === loadedNodeId) updateStampDisplay(); });

        setupAutoSave();
        setupToolbar();
        setupFormatMenu();
        setupContentEditor();
        setupLinkPopup();
        setupFootnotePopup();
        setupSuggestUI();
        setupTags();
        setupChildren();
        setupConnections();
        setupMedia();
        setupDeleteNode();
        setupDuplicate();
        setupWordCount();
    }

    // --- Per-node "last edited" stamp (editor-only, read-only display) ---

    // ISO date-time -> human-readable local string; '—' when missing/unparseable
    // (older books carry no per-node stamps until their first edit).
    function formatStamp(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    // Refresh the meta-bar stamp from the currently loaded node.
    function updateStampDisplay() {
        const node = loadedNodeId ? EditorState.getNode(loadedNodeId) : null;
        if (modifiedEl) modifiedEl.textContent = formatStamp(node && node.modified);
        if (createdEl) createdEl.textContent = formatStamp(node && node.created);
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

    // Authored-footnote collectors for the Preview pane (parallel to _fnEd/links).
    // When _fnNotesEd is live, [^id] markers render as numbered [n] superscripts and
    // are gathered into a Notes list. When null (the editing surface), [^id] renders
    // as an atomic "fn-pill" whose text is edited through a popup — so the markdown
    // round-trip is never disturbed. _fnDefs holds the current surface's footnote
    // text (id -> text), harvested on load and reattached on save.
    let _fnNotesEd = null;
    let _fnNotesSeenEd = null;
    let _fnNotesDefsEd = null;
    let _fnDefs = {};

    function fnSanitizeId(s) {
        return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '-') || 'fn';
    }

    // Pull `[^id]: text` definition lines out of markdown (skipping fenced code).
    function harvestFootnoteDefsEd(md) {
        const defs = {};
        if (!md) return { bodyMd: md || '', defs };
        const lines = md.split('\n');
        const body = [];
        let inCode = false;
        const defRe = /^\[\^([A-Za-z0-9_-]+)\]:\s?(.*)$/;
        for (const line of lines) {
            if (/^```/.test(line)) { inCode = !inCode; body.push(line); continue; }
            if (!inCode) {
                const m = line.match(defRe);
                if (m) { if (!(m[1] in defs)) defs[m[1]] = m[2]; continue; }
            }
            body.push(line);
        }
        return { bodyMd: body.join('\n'), defs };
    }

    // Reattach `[^id]: text` definitions for every footnote marker present in the
    // serialized body, in first-appearance order. Markers whose pill was deleted
    // drop their definition automatically (delete-pill = delete-note).
    function appendFootnoteDefsEd(body, defs) {
        if (!defs) return body;
        const ids = [];
        const seen = {};
        const re = /\[\^([A-Za-z0-9_-]+)\]/g;
        let m;
        while ((m = re.exec(body)) !== null) {
            if (!seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
        }
        const defLines = ids
            .filter(id => Object.prototype.hasOwnProperty.call(defs, id))
            .map(id => '[^' + id + ']: ' + (defs[id] == null ? '' : defs[id]));
        if (!defLines.length) return body;
        return body.replace(/\s+$/, '') + '\n\n' + defLines.join('\n');
    }

    // Render markdown into the editing surface: footnote definitions are stripped
    // and stashed in _fnDefs, markers become pills (numbered after insertion).
    function setSurfaceFromMarkdown(md) {
        const harvested = harvestFootnoteDefsEd(md || '');
        _fnDefs = harvested.defs;
        contentEl.innerHTML = markdownToHtml(harvested.bodyMd);
        renumberFootnotePills();
    }

    // Walk fn-pills in DOM order and set each [n] by first-appearance; repeated ids
    // share a number. Returns the count of distinct footnotes.
    function renumberFootnotePills() {
        const seen = {};
        let next = 1;
        contentEl.querySelectorAll('.fn-pill').forEach(pill => {
            const id = pill.getAttribute('data-fnid') || '';
            let n = seen[id];
            if (n === undefined) { n = next++; seen[id] = n; }
            pill.textContent = '[' + n + ']';
        });
        return next - 1;
    }

    // Whitelist filter for inline style attributes that we persist as raw HTML in the
    // markdown (text color, highlight, relative font size). Only these three properties
    // are honored and each value is constrained to a safe character set, so a hand-edited
    // or pasted style string can never inject script/url()/arbitrary CSS. Returns the
    // canonicalized "prop: value; ..." string, or '' when nothing is allowed.
    const SAFE_STYLE_PROPS = { 'color': 1, 'background-color': 1, 'font-size': 1 };
    function sanitizeInlineStyle(style) {
        if (typeof style !== 'string' || !style || style.length > 200) return '';
        const out = [];
        for (const decl of style.split(';')) {
            const idx = decl.indexOf(':');
            if (idx < 0) continue;
            const prop = decl.slice(0, idx).trim().toLowerCase();
            const val = decl.slice(idx + 1).trim();
            if (!SAFE_STYLE_PROPS[prop]) continue;
            if (!val || val.length > 64) continue;
            if (!/^[#a-z0-9.,%()\s-]+$/i.test(val)) continue;     // safe chars only
            if (/url|expression|javascript|@import/i.test(val)) continue;
            out.push(prop + ': ' + val);
        }
        return out.join('; ');
    }

    // Inline markdown -> HTML. Escapes first so <, >, & can never corrupt markup.
    function inlineFormat(text) {
        let t = escHtmlText(text);
        // A small set of inline HTML tags have no markdown marker, so we honor them by
        // restoring the specific escaped forms our serializer emits (everything else stays
        // escaped literal text). Emphasis inside them is still processed by the rules below.
        //   <u>            underline
        //   <sup>/<sub>    super-/subscript
        //   <span style>   text color / highlight / relative font size (style is whitelisted)
        // escHtmlText escapes only & < > (not quotes), so attribute quotes survive verbatim.
        t = t.replace(/&lt;(\/?)u&gt;/g, '<$1u>');
        t = t.replace(/&lt;(\/?)(sup|sub)&gt;/g, '<$1$2>');
        t = t.replace(/&lt;span style="([^"]*)"&gt;/g, (m, style) => {
            const safe = sanitizeInlineStyle(style);
            return safe ? '<span style="' + safe + '">' : m;
        });
        t = t.replace(/&lt;\/span&gt;/g, '</span>');
        // images first (before links, since ![]() contains []())
        t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => `<img src="${src.replace(/"/g, '&quot;')}" alt="${alt}">`);
        // Emphasis requires non-space flanking (opener not followed by whitespace,
        // closer not preceded by whitespace). This keeps tight markers (**bold**,
        // *italic*) working while leaving space-flanked runs (e.g. "3 * 4 * 5", or a
        // stray "***** " divider) as literal text — which is what makes the markdown
        // round-trip idempotent and stops asterisk runs from growing on every save.
        t = t.replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<strong><em>$1</em></strong>');
        t = t.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/\*(?!\s)(.+?)(?<!\s)\*/g, '<em>$1</em>');
        t = t.replace(/`(.+?)`/g, '<code>$1</code>');
        t = t.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<del>$1</del>');
        // authored footnote markers [^id] — before links so they aren't read as labels
        t = t.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (m, id) => {
            if (_fnNotesEd) {
                let n = _fnNotesSeenEd[id];
                if (n === undefined) { n = _fnNotesEd.length + 1; _fnNotesSeenEd[id] = n; _fnNotesEd.push({ n, id }); }
                return `<sup class="fn-marker" id="fnref-${_fnPrefixEd}-note-${n}">` +
                    `<a href="#fn-${_fnPrefixEd}-note-${n}">[${n}]</a></sup>`;
            }
            // editing surface: atomic pill (number filled in by renumberFootnotePills)
            return `<sup class="fn-pill" contenteditable="false" data-fnid="${id}">[?]</sup>`;
        });
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

    // Parse a run of list lines into (possibly nested) <ul>/<ol>, using 2-space
    // indentation for depth. Flat lists (no indent) produce exactly one level, byte-for-byte
    // as before; a deeper-indented run becomes a nested list inside the preceding <li>.
    // Returns { html, next } where next is the index of the first non-list line.
    function parseListBlock(lines, start) {
        const info = s => {
            const m = s.match(/^([ \t]*)([-*+]|\d+\.)[ \t]+(.*)$/);
            if (!m) return null;
            return { indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] };
        };
        function build(idx) {
            const base = info(lines[idx]);
            const myIndent = base.indent, ordered = base.ordered;
            const items = [];
            while (idx < lines.length) {
                const it = info(lines[idx]);
                if (!it || it.indent < myIndent) break;
                if (it.indent > myIndent && items.length) {
                    const nested = build(idx);
                    items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, nested.html + '</li>');
                    idx = nested.next;
                    continue;
                }
                if (it.indent === myIndent && it.ordered !== ordered) break;  // type switch -> separate list
                items.push('<li>' + inlineFormat(it.text) + '</li>');
                idx++;
            }
            return { html: (ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'), next: idx };
        }
        return build(start);
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

            // list (unordered or ordered), with nesting by 2-space indentation
            if (/^[ \t]*([-*+]|\d+\.)\s/.test(line)) {
                flushPara();
                const parsed = parseListBlock(lines, i);
                result.push(parsed.html);
                i = parsed.next - 1;
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
        // Unwrap empty / whitespace-only inline wrappers before serializing. Toggling a
        // format off (or deleting through one) can leave an empty <strong></strong> behind;
        // serialized verbatim that becomes orphan markers like "****" or "** **" that then
        // reappear as literal text. Unwrap (keep any inner text) rather than delete so a
        // meaningful space is preserved. Code inside <pre> is left untouched.
        div.querySelectorAll('strong, b, em, i, del, s, strike, code, u, sup, sub').forEach(el => {
            if (el.closest('pre')) return;
            if (el.classList && el.classList.contains('fn-pill')) return;  // pills carry [n], never strip
            if (el.textContent.trim() === '') {
                const parent = el.parentNode;
                if (!parent) return;
                while (el.firstChild) parent.insertBefore(el.firstChild, el);
                parent.removeChild(el);
            }
        });
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

    // Serialize a <ul>/<ol> (recursively) to markdown list lines. A nested list inside an
    // <li> is emitted on its own lines indented 2 spaces per level — mirroring
    // parseListBlock — so nesting round-trips instead of gluing ("one- nested"). Flat lists
    // emit unindented lines exactly as before.
    function listToMd(listEl, depth) {
        const ordered = listEl.tagName.toLowerCase() === 'ol';
        const indent = '  '.repeat(depth);
        let out = '';
        let n = 1;
        for (const li of listEl.querySelectorAll(':scope > li')) {
            const nested = [...li.children].filter(c => /^(ul|ol)$/i.test(c.tagName));
            const clone = li.cloneNode(true);
            [...clone.children].forEach(c => { if (/^(ul|ol)$/i.test(c.tagName)) clone.removeChild(c); });
            const text = nodeToMd(clone).trim().replace(/\s*\n\s*/g, ' ');
            out += indent + (ordered ? (n++) + '. ' : '- ') + text + '\n';
            for (const nl of nested) out += listToMd(nl, depth + 1);
        }
        return out;
    }

    // Wrap inline text in emphasis markers, keeping the markers hugging the text: any
    // leading/trailing whitespace is moved OUTSIDE the markers. Required because the
    // emphasis parser only treats non-space-flanked markers as emphasis — emitting
    // "**bold **" (space inside) would fail to re-parse and silently drop the formatting
    // on the next load. All-whitespace content is left unwrapped (empty-tag cleanup and
    // the caller already guard those).
    function wrapEmphasis(inner, marker) {
        const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (!m || !m[2]) return inner;
        return m[1] + marker + m[2] + marker + m[3];
    }

    function nodeToMd(node) {
        let md = '';
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                md += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                // Atomic footnote pill serializes back to its [^id] marker.
                if (child.classList && child.classList.contains('fn-pill')) {
                    md += '[^' + (child.getAttribute('data-fnid') || '') + ']';
                    continue;
                }
                const inner = nodeToMd(child);
                switch (tag) {
                    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
                        // Backstop: a heading must serialize to a single "# text" line.
                        // Collapse any stray newlines and strip a leading blockquote marker
                        // so a quote-nested-in-heading can't leak back as "## > text".
                        const htext = inner.trim().replace(/\s*\n\s*/g, ' ').replace(/^>\s*/, '');
                        // Only emit when there is real content. An empty/degenerate heading
                        // (e.g. left-over empty <strong><em></em></strong> from editing) would
                        // otherwise serialize to a bare "##", which re-parses as the literal
                        // text "##" — the heading visibly breaks apart. Drop it instead.
                        if (htext) md += '\n' + '#'.repeat(parseInt(tag[1])) + ' ' + htext + '\n\n';
                        break;
                    }
                    case 'strong': case 'b': md += wrapEmphasis(inner, '**'); break;
                    case 'em': case 'i': md += wrapEmphasis(inner, '*'); break;
                    case 'del': case 's': case 'strike': md += wrapEmphasis(inner, '~~'); break;
                    case 'u': md += '<u>' + inner + '</u>'; break;   // underline has no markdown marker; keep the tag
                    case 'sup': md += '<sup>' + inner + '</sup>'; break;  // super/subscript: no marker, keep the tag
                    case 'sub': md += '<sub>' + inner + '</sub>'; break;
                    case 'code':
                        // bare inline code only; code inside <pre> is handled by the 'pre' case
                        md += child.closest('pre') ? inner : '`' + inner + '`';
                        break;
                    case 'a': md += '[' + inner + '](' + (child.getAttribute('href') || '') + ')'; break;
                    case 'img': md += '![' + (child.getAttribute('alt') || '') + '](' + (child.getAttribute('src') || '') + ')'; break;
                    case 'br': md += '\n'; break;
                    case 'blockquote': {
                        // Backstop: strip a leading heading marker from each quoted line so a
                        // heading-nested-in-quote can't leak back as "> ## text".
                        const lines = inner.trim().split('\n').filter(l => l.trim());
                        md += '\n' + lines.map(l => '> ' + l.trim().replace(/^#{1,6}\s+/, '')).join('\n') + '\n\n';
                        break;
                    }
                    case 'pre': {
                        const codeEl = child.querySelector('code');
                        const codeText = (codeEl ? codeEl.textContent : child.textContent).replace(/\n$/, '');
                        md += '\n```\n' + codeText + '\n```\n\n';
                        break;
                    }
                    case 'ul': case 'ol':
                        md += listToMd(child, 0) + '\n';
                        break;
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
                    case 'span': {
                        if (child.classList && child.classList.contains('example-label')) break;
                        // Honor inline-styled emphasis (e.g. <span style="font-weight:bold">
                        // from execCommand with styleWithCSS on, or pasted styling) so bold/
                        // italic/strike aren't silently dropped on save. Only wrap non-empty
                        // text to avoid emitting orphan "** **" markers.
                        const st = child.style || {};
                        const fw = String(st.fontWeight || '');
                        const bold = fw === 'bold' || fw === 'bolder' || (parseInt(fw, 10) >= 600);
                        const italic = st.fontStyle === 'italic';
                        const deco = String(st.textDecoration || st.textDecorationLine || '');
                        const strike = /line-through/.test(deco);
                        const underline = /underline/.test(deco);
                        // Visual styles with no markdown equivalent (color / highlight / relative
                        // font size) are persisted as a raw <span style="..."> wrapper, mirroring
                        // how <u> is kept. The attribute is whitelist-filtered so only safe
                        // declarations round-trip.
                        const styleStr = sanitizeInlineStyle(child.getAttribute('style'));
                        if (inner.trim() && (bold || italic || strike || underline || styleStr)) {
                            // Keep markers hugging the text (edge whitespace stays outside),
                            // matching wrapEmphasis, so the result re-parses cleanly.
                            const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
                            let core = m[2];
                            if (underline) core = '<u>' + core + '</u>';
                            if (strike) core = '~~' + core + '~~';
                            if (italic) core = '*' + core + '*';
                            if (bold) core = '**' + core + '**';
                            if (styleStr) core = '<span style="' + styleStr + '">' + core + '</span>';
                            md += m[1] + core + m[3];
                        } else {
                            md += inner;
                        }
                        break;
                    }
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
        if (contentDirty) return appendFootnoteDefsEd(htmlToMarkdown(contentEl.innerHTML), _fnDefs);
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
        // Leaving a node closes any open review view (its hunks belong to the old node).
        if (reviewMode && loadedNodeId !== nodeId) {
            reviewMode = false;
            if (reviewEl) reviewEl.hidden = true;
            contentEl.hidden = false;
            if (hunkPopupEl) hunkPopupEl.hidden = true;
        }
        if (loadedNodeId && loadedNodeId !== nodeId && !suppressSave) {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            const prev = EditorState.getNode(loadedNodeId);
            if (prev) {
                const changes = collectChangesSuggestAware();
                // 'suggestions' is only present when we actually recaptured the diff;
                // save when content/meta changed OR new suggestions were captured.
                if (nodeChanged(prev, changes) || 'suggestions' in changes) {
                    persistChanges(loadedNodeId, changes);
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

        // In Suggesting mode the surface shows the proposed text (baseline + hunks);
        // otherwise it shows the clean accepted content exactly as before.
        baselineContent = node.content || '';
        const sHunks = (suggestMode && Array.isArray(node.suggestions)) ? node.suggestions : null;
        const surfaceMd = (sHunks && sHunks.length) ? proposedText(baselineContent, sHunks) : (node.content || '');
        setSurfaceFromMarkdown(surfaceMd);
        contentDirty = false;

        renderTags(node.tags || []);
        renderChildren(node.children || []);
        renderConnections(node.connections || []);
        renderMedia(node.media || []);
        updateStampDisplay();
        updatePreview();
        updateWordCount();
        updateSuggestUI();

        hideAllInlineForms();
        suppressSave = false;
    }

    // --- Auto-save ---

    function setupAutoSave() {
        const doSave = () => {
            saveTimer = null;
            if (suppressSave || !loadedNodeId) return;
            persistChanges(loadedNodeId, collectChangesSuggestAware());
            updatePreview();
            updateWordCount();
            updateSuggestUI();
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
        persistChanges(loadedNodeId, collectChangesSuggestAware());
        updateSuggestUI();
    }

    // --- Suggestions (track-changes / suggesting mode) ---
    //
    // Model: node.content stays the clean, accepted markdown, so the exporters and
    // the reader never see suggestions (they read content by key and ignore unknown
    // fields). Pending suggestions live in node.suggestions as diff hunks (see
    // suggest-diff.js). With Suggesting ON, the editing surface shows the PROPOSED
    // text (baseline + all suggestions applied); on flush we re-diff the surface
    // against the clean baseline to regenerate the hunks, leaving node.content
    // untouched. The Review view renders the hunks as accept/reject-able cards.
    // Suggesting OFF reproduces the original editor behavior byte-for-byte (all of
    // this is gated behind suggestMode).

    let suggestMode = false;
    let reviewMode = false;
    let baselineContent = '';        // clean accepted markdown for the loaded node
    let hunkPopupEl = null;
    let hunkPopupTarget = null;

    function currentSuggestions() {
        const node = loadedNodeId ? EditorState.getNode(loadedNodeId) : null;
        return (node && Array.isArray(node.suggestions)) ? node.suggestions : [];
    }

    // Baseline with all locatable suggestions applied — the text the author edits
    // while suggesting. Falls back to the baseline if anything fails to apply.
    function proposedText(baseline, hunks) {
        if (!hunks || !hunks.length) return baseline;
        try {
            SuggestDiff.validateHunks(baseline, hunks);
            return SuggestDiff.applyAllHunks(baseline, hunks.filter(h => !h.orphaned));
        } catch (e) {
            console.warn('Suggestions: could not render proposed text:', e);
            return baseline;
        }
    }

    // Save-time fork. OFF (or when the surface was untouched / in review) behaves
    // exactly like collectChanges(). ON + dirty: keep content clean and capture the
    // diff against the baseline as hunks.
    function collectChangesSuggestAware() {
        const changes = collectChanges();
        if (!suggestMode || reviewMode || !contentDirty) return changes;
        const workingMd = changes.content;
        let hunks;
        try {
            hunks = SuggestDiff.diffToHunks(baselineContent, workingMd);
        } catch (e) {
            toast('Could not compute suggestions: ' + e.message, 'error');
            return changes;  // fall back to a normal save rather than dropping edits
        }
        changes.content = baselineContent;   // never write suggested text into content
        changes.suggestions = hunks;          // possibly [] (cleared by persistChanges)
        return changes;
    }

    // updateNode + drop an emptied suggestions array so clean nodes carry no field.
    function persistChanges(id, changes) {
        EditorState.updateNode(id, changes);
        if (Array.isArray(changes.suggestions) && changes.suggestions.length === 0) {
            const node = EditorState.getNode(id);
            if (node && 'suggestions' in node) delete node.suggestions;
        }
    }

    function updateSuggestUI() {
        if (suggestBtn) suggestBtn.classList.toggle('active', suggestMode);
        if (reviewBtn) {
            const n = currentSuggestions().length;
            reviewBtn.textContent = n ? ('Review (' + n + ')') : 'Review';
            reviewBtn.classList.toggle('active', reviewMode);
            reviewBtn.classList.toggle('has-suggestions', n > 0);
        }
    }

    // Re-render the editing surface for the current mode (clean vs proposed)
    // without triggering a save.
    function refreshSurface() {
        if (!loadedNodeId) return;
        const node = EditorState.getNode(loadedNodeId);
        baselineContent = node ? (node.content || '') : '';
        const hunks = suggestMode ? currentSuggestions() : null;
        const md = (hunks && hunks.length) ? proposedText(baselineContent, hunks) : baselineContent;
        suppressSave = true;
        setSurfaceFromMarkdown(md);
        contentDirty = false;
        suppressSave = false;
    }

    function toggleSuggestMode() {
        if (!loadedNodeId) { toast('Open a node to start suggesting', 'info'); return; }
        if (reviewMode) exitReview();
        flushContent();          // capture/preserve current state before switching modes
        suggestMode = !suggestMode;
        refreshSurface();
        updateSuggestUI();
        updatePreview();
        toast(suggestMode ? 'Suggesting on — edits are tracked as suggestions'
                          : 'Suggesting off', 'success');
    }

    function enterReview() {
        if (!loadedNodeId) return;
        flushContent();
        if (!currentSuggestions().length) { toast('No pending suggestions', 'info'); return; }
        reviewMode = true;
        renderReview();
        contentEl.hidden = true;
        reviewEl.hidden = false;
        if (hunkPopupEl) hunkPopupEl.hidden = true;
        updateSuggestUI();
    }

    function exitReview() {
        if (!reviewMode) return;
        reviewMode = false;
        reviewEl.hidden = true;
        contentEl.hidden = false;
        if (hunkPopupEl) hunkPopupEl.hidden = true;
        refreshSurface();
        updateSuggestUI();
        updatePreview();
    }

    function renderReview() {
        if (!reviewEl) return;
        const node = EditorState.getNode(loadedNodeId);
        baselineContent = node ? (node.content || '') : '';
        const hunks = currentSuggestions();
        SuggestDiff.validateHunks(baselineContent, hunks);
        const n = hunks.length;
        let html = '<div class="sg-review-head">' +
            '<span class="sg-review-count">' + n + ' suggested change' + (n === 1 ? '' : 's') + '</span>' +
            '<span class="sg-review-buttons">' +
            '<button type="button" class="sg-btn sg-accept-all">Accept all</button>' +
            '<button type="button" class="sg-btn sg-reject-all">Reject all</button>' +
            '<button type="button" class="sg-btn sg-review-close">Done</button>' +
            '</span></div>';
        hunks.forEach(h => { html += renderHunkCard(h); });
        reviewEl.innerHTML = html;
    }

    function renderHunkCard(h) {
        const typeLabel = h.type ? (h.type.charAt(0).toUpperCase() + h.type.slice(1)) : 'Change';
        let text = '<span class="sg-ctx">' + escHtml(h.ctxBefore || '') + '</span>';
        if (h.before) text += '<del class="sg-del">' + escHtml(h.before) + '</del>';
        if (h.after) text += '<ins class="sg-ins">' + escHtml(h.after) + '</ins>';
        text += '<span class="sg-ctx">' + escHtml(h.ctxAfter || '') + '</span>';
        let actions;
        if (h.orphaned) {
            actions = '<span class="sg-orphan-note">Could not locate in current text</span>' +
                '<button type="button" class="sg-btn sg-reject" data-hunk="' + escHtml(h.id) + '">Dismiss</button>';
        } else {
            actions = '<button type="button" class="sg-btn sg-accept" data-hunk="' + escHtml(h.id) + '">&#10003; Accept</button>' +
                '<button type="button" class="sg-btn sg-reject" data-hunk="' + escHtml(h.id) + '">&#10007; Reject</button>' +
                '<button type="button" class="sg-btn sg-edit" data-hunk="' + escHtml(h.id) + '">&#9998; Edit</button>';
        }
        return '<div class="sg-hunk' + (h.orphaned ? ' sg-orphan' : '') + '" data-hunk="' + escHtml(h.id) + '">' +
            '<div class="sg-hunk-type">' + typeLabel + '</div>' +
            '<div class="sg-hunk-text">' + text + '</div>' +
            '<div class="sg-hunk-actions">' + actions + '</div></div>';
    }

    function acceptHunk(id) {
        const node = EditorState.getNode(loadedNodeId);
        if (!node) return;
        const hunks = currentSuggestions();
        const h = hunks.find(x => x.id === id);
        if (!h) return;
        let next;
        try { next = SuggestDiff.applyHunk(node.content || '', h); }
        catch (e) { toast('Could not apply suggestion: ' + e.message, 'error'); return; }
        EditorState.pushUndo();
        const remaining = hunks.filter(x => x.id !== id);
        SuggestDiff.validateHunks(next, remaining);
        persistChanges(loadedNodeId, { content: next, suggestions: remaining });
        baselineContent = next;
        afterReviewMutation();
    }

    function rejectHunk(id) {
        const hunks = currentSuggestions();
        if (!hunks.some(x => x.id === id)) return;
        EditorState.pushUndo();
        persistChanges(loadedNodeId, { suggestions: hunks.filter(x => x.id !== id) });
        afterReviewMutation();
    }

    function acceptAll() {
        const node = EditorState.getNode(loadedNodeId);
        if (!node) return;
        const hunks = currentSuggestions();
        if (!hunks.length) return;
        let next;
        try { next = SuggestDiff.applyAllHunks(node.content || '', hunks.filter(h => !h.orphaned)); }
        catch (e) { toast('Could not apply suggestions: ' + e.message, 'error'); return; }
        EditorState.pushUndo();
        persistChanges(loadedNodeId, { content: next, suggestions: [] });
        baselineContent = next;
        afterReviewMutation();
    }

    function rejectAll() {
        const hunks = currentSuggestions();
        if (!hunks.length) return;
        EditorState.pushUndo();
        persistChanges(loadedNodeId, { suggestions: [] });
        afterReviewMutation();
    }

    function afterReviewMutation() {
        if (hunkPopupEl) hunkPopupEl.hidden = true;
        hunkPopupTarget = null;
        if (!currentSuggestions().length) {
            exitReview();
            toast('All suggestions resolved', 'success');
        } else {
            renderReview();
            updateSuggestUI();
        }
    }

    function setupSuggestUI() {
        suggestBtn = document.getElementById('btn-suggest-mode');
        reviewBtn = document.getElementById('btn-review');

        // Hunk editor popup, built once (mirrors the link popup pattern).
        const popup = document.createElement('div');
        popup.className = 'hunk-popup sg-edit-popup';
        popup.hidden = true;
        popup.innerHTML =
            '<div class="hunk-popup-title">Edit suggested text</div>' +
            '<textarea class="hunk-popup-text" rows="3" aria-label="Suggested text"></textarea>' +
            '<div class="hunk-popup-actions">' +
            '<button type="button" class="hunk-popup-save">Save</button>' +
            '<button type="button" class="hunk-popup-cancel">Cancel</button>' +
            '</div>';
        document.body.appendChild(popup);
        hunkPopupEl = popup;
        const textArea = popup.querySelector('.hunk-popup-text');
        const closePopup = () => { popup.hidden = true; hunkPopupTarget = null; };
        popup.querySelector('.hunk-popup-cancel').addEventListener('click', closePopup);
        popup.querySelector('.hunk-popup-save').addEventListener('click', () => commitHunkEdit(textArea.value));
        textArea.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitHunkEdit(textArea.value); }
        });

        if (reviewEl) {
            reviewEl.addEventListener('click', e => {
                const btn = e.target.closest('button');
                if (!btn) return;
                if (btn.classList.contains('sg-accept-all')) return acceptAll();
                if (btn.classList.contains('sg-reject-all')) return rejectAll();
                if (btn.classList.contains('sg-review-close')) return exitReview();
                const id = btn.getAttribute('data-hunk');
                if (!id) return;
                if (btn.classList.contains('sg-accept')) acceptHunk(id);
                else if (btn.classList.contains('sg-reject')) rejectHunk(id);
                else if (btn.classList.contains('sg-edit')) openHunkEditor(id, btn);
            });
        }

        document.addEventListener('mousedown', e => {
            if (popup.hidden) return;
            if (popup.contains(e.target)) return;
            closePopup();
        });

        updateSuggestUI();
    }

    function openHunkEditor(id, anchorBtn) {
        const h = currentSuggestions().find(x => x.id === id);
        if (!h || !hunkPopupEl) return;
        hunkPopupTarget = id;
        const ta = hunkPopupEl.querySelector('.hunk-popup-text');
        ta.value = h.after || '';
        hunkPopupEl.hidden = false;  // unhide to measure
        const r = (anchorBtn || reviewEl).getBoundingClientRect();
        const pw = hunkPopupEl.offsetWidth, ph = hunkPopupEl.offsetHeight;
        const left = Math.max(12, Math.min(r.left, window.innerWidth - pw - 12));
        let top = r.bottom + 6;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
        hunkPopupEl.style.left = left + 'px';
        hunkPopupEl.style.top = top + 'px';
        ta.focus();
    }

    function commitHunkEdit(value) {
        if (hunkPopupTarget == null) return;
        const hunks = currentSuggestions();
        const h = hunks.find(x => x.id === hunkPopupTarget);
        if (!h) { hunkPopupEl.hidden = true; hunkPopupTarget = null; return; }
        EditorState.pushUndo();
        h.after = value;
        if (!h.before && !h.after) {
            persistChanges(loadedNodeId, { suggestions: hunks.filter(x => x.id !== h.id) });
        } else {
            h.type = (h.before && h.after) ? 'replace' : (h.after ? 'insert' : 'delete');
            persistChanges(loadedNodeId, { suggestions: hunks });
        }
        hunkPopupEl.hidden = true;
        hunkPopupTarget = null;
        toast('Suggestion updated', 'success');
        afterReviewMutation();
    }

    // --- Rich text toolbar ---

    function setupToolbar() {
        document.querySelectorAll('.toolbar-btn').forEach(btn => {
            btn.addEventListener('mousedown', e => e.preventDefault());
            btn.addEventListener('click', e => {
                e.preventDefault();
                const action = btn.dataset.action;
                // Suggesting/Review are mode toggles, not formatting commands.
                if (action === 'suggest-toggle') { toggleSuggestMode(); return; }
                if (action === 'review') { reviewMode ? exitReview() : enterReview(); return; }
                applyFormat(action);
            });
        });
    }

    function applyFormat(action, value) {
        if (reviewMode) return;  // editing surface is hidden during review
        contentEl.focus();
        switch (action) {
            case 'font-increase':
                // Relative size keywords compound on nesting, so repeated clicks keep growing.
                wrapSelectionStyle('font-size', 'larger');
                break;
            case 'font-decrease':
                wrapSelectionStyle('font-size', 'smaller');
                break;
            case 'superscript':
                // styleWithCSS is off, so this emits a semantic <sup> that round-trips.
                document.execCommand('superscript', false);
                break;
            case 'subscript':
                document.execCommand('subscript', false);
                break;
            case 'fore-color':
                applyInlineColor('foreColor', value);
                break;
            case 'hilite-color':
                applyInlineColor('hiliteColor', value);
                break;
            case 'upside-down':
                flipSelection();
                break;
            case 'bold':
                document.execCommand('bold', false);
                break;
            case 'italic':
                document.execCommand('italic', false);
                break;
            case 'underline':
                // styleWithCSS is off (see setupContentEditor) so this emits <u>, which
                // serializes to <u>...</u> and round-trips through every parser.
                document.execCommand('underline', false);
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
            case 'footnote':
                insertFootnoteAtCursor();
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

    // --- Custom inline formatting (size / colour / super-sub / flip) ------------------

    // Selection saved when the format menu opens. Needed because the native colour
    // <input type="color"> steals focus from the contenteditable before its change
    // event fires, which would otherwise collapse the live selection.
    let fmtSavedRange = null;
    function saveFmtSelection() {
        const sel = window.getSelection();
        fmtSavedRange = (sel && sel.rangeCount &&
            contentEl.contains(sel.getRangeAt(0).commonAncestorContainer))
            ? sel.getRangeAt(0).cloneRange() : null;
    }
    function restoreFmtSelection() {
        if (!fmtSavedRange) return false;
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(fmtSavedRange);
        return true;
    }

    // Wrap the selection in <span style="prop: value">. surroundContents throws when the
    // range straddles element boundaries, so fall back to extract/insert. No-op on an
    // empty selection.
    function wrapSelectionStyle(prop, value) {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) { toast('Select some text first', 'info'); return; }
        const range = sel.getRangeAt(0);
        if (!contentEl.contains(range.commonAncestorContainer)) return;
        const span = document.createElement('span');
        span.style.setProperty(prop, value);
        try {
            range.surroundContents(span);
        } catch (e) {
            const frag = range.extractContents();
            span.appendChild(frag);
            range.insertNode(span);
        }
        const nr = document.createRange();
        nr.selectNodeContents(span);
        sel.removeAllRanges();
        sel.addRange(nr);
    }

    // Text colour / highlight via execCommand with CSS styling ON, so it emits
    // <span style="color|background-color:..."> (which round-trips) rather than a
    // deprecated <font> tag. styleWithCSS is restored to OFF so other commands keep
    // emitting semantic tags.
    function applyInlineColor(cmd, color) {
        if (!color) return;
        restoreFmtSelection();                       // colour input stole focus
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) { toast('Select some text first', 'info'); return; }
        try {
            document.execCommand('styleWithCSS', false, true);
            if (cmd === 'hiliteColor') {
                if (!document.execCommand('hiliteColor', false, color)) {
                    document.execCommand('backColor', false, color);   // Firefox spelling
                }
                // Pin dark text on the highlight so it stays legible even when the reader
                // views the book in a dark theme (the highlight colours are light).
                document.execCommand('foreColor', false, '#1a1a1a');
            } else {
                document.execCommand(cmd, false, color);
            }
        } finally {
            document.execCommand('styleWithCSS', false, false);
        }
    }

    // Upside-down ("flip") text: reverse the run and map each character to its rotated
    // Unicode counterpart. The map is symmetric (a<->ɐ), so flipping a flipped selection
    // restores the original. Plain text only — renders identically everywhere (editor,
    // viewer, PDF, EPUB) with no markup or round-trip concerns.
    const FLIP_MAP = (() => {
        const pairs = {
            a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ',
            h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'ʅ', m: 'ɯ',
            n: 'u', r: 'ɹ', t: 'ʇ', v: 'ʌ', w: 'ʍ', y: 'ʎ',
            A: '∀', E: 'Ǝ', F: 'Ⅎ', J: 'ſ', L: '˥', M: 'W',
            P: 'Ԁ', T: '⊥', U: '∩', V: 'Λ', Y: '⅄',
            '1': 'Ɩ', '2': 'ᄅ', '3': 'Ɛ', '4': 'ㄣ', '5': 'ϛ',
            '6': '9', '7': 'ㄥ',
            '.': '˙', ',': "'", '?': '¿', '!': '¡', '"': '„',
            '(': ')', '[': ']', '{': '}', '<': '>', '&': '⅋', '_': '‾'
        };
        const map = {};
        for (const k in pairs) {
            map[k] = pairs[k];
            if (!(pairs[k] in map)) map[pairs[k]] = k;   // build the reverse direction
        }
        return map;
    })();
    function flipText(s) {
        let out = '';
        for (const ch of s) out += (FLIP_MAP[ch] || ch);
        return out.split('').reverse().join('');
    }
    function flipSelection() {
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) { toast('Select some text first', 'info'); return; }
        const range = sel.getRangeAt(0);
        if (!contentEl.contains(range.commonAncestorContainer)) return;
        const text = sel.toString();
        if (!text) return;
        range.deleteContents();
        const node = document.createTextNode(flipText(text));
        range.insertNode(node);
        const nr = document.createRange();
        nr.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(nr);
    }

    // Wire the "A±" toolbar dropdown: open/close, item dispatch, colour pickers and
    // swatches. Mousedown is suppressed on the menu so the contenteditable selection
    // survives the click; the colour input additionally relies on the saved range.
    function setupFormatMenu() {
        const wrap = document.getElementById('format-menu');
        if (!wrap) return;
        const trigger = document.getElementById('btn-format-more');
        const dropdown = document.getElementById('format-dropdown');

        function close() {
            dropdown.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        }
        function open() {
            saveFmtSelection();          // capture selection before focus can move
            dropdown.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        }

        trigger.addEventListener('mousedown', e => e.preventDefault());
        trigger.addEventListener('click', e => {
            e.preventDefault();
            dropdown.hidden ? open() : close();
        });

        // Keep the contenteditable selection while clicking inside the menu.
        dropdown.addEventListener('mousedown', e => {
            if (e.target.type !== 'color') e.preventDefault();
        });

        // Action buttons / swatches (anything carrying data-action).
        dropdown.querySelectorAll('[data-action]').forEach(el => {
            if (el.tagName === 'INPUT') return;   // colour inputs handled below
            el.addEventListener('click', e => {
                e.preventDefault();
                restoreFmtSelection();
                const action = el.dataset.action;
                const value = el.dataset.value;
                applyFormat(action, value);
                close();
            });
        });

        // Native colour pickers (text colour + highlight).
        dropdown.querySelectorAll('input[type="color"]').forEach(input => {
            input.addEventListener('input', e => {
                applyFormat(input.dataset.action, e.target.value);
            });
            input.addEventListener('change', () => close());
        });

        // Dismiss on outside click or Escape.
        document.addEventListener('mousedown', e => {
            if (!dropdown.hidden && !wrap.contains(e.target)) close();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !dropdown.hidden) close();
        });
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
        // Move the block's contents into the quote (demoting a heading to plain quoted
        // text) rather than nesting it. Nesting a heading produced <blockquote><h2>,
        // which can't round-trip and leaked back as a literal "> ## Title".
        while (block.firstChild) bq.appendChild(block.firstChild);
        block.parentNode.replaceChild(bq, block);
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

    // --- Authored footnotes: insert + edit pill text ---

    let _fnPopupEl = null;
    let _fnPopupPill = null;

    // Smallest positive integer not already used as a footnote id in the surface.
    function nextFootnoteId() {
        const used = new Set();
        contentEl.querySelectorAll('.fn-pill').forEach(p => used.add(p.getAttribute('data-fnid')));
        let n = 1;
        while (used.has(String(n))) n++;
        return String(n);
    }

    function insertFootnoteAtCursor() {
        if (reviewMode) return;
        contentEl.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!contentEl.contains(range.commonAncestorContainer)) return;
        range.deleteContents();

        const id = nextFootnoteId();
        const sup = document.createElement('sup');
        sup.className = 'fn-pill';
        sup.setAttribute('contenteditable', 'false');
        sup.setAttribute('data-fnid', id);
        sup.textContent = '[?]';
        const trailing = document.createTextNode(' ');
        range.insertNode(sup);
        sup.after(trailing);

        const after = document.createRange();
        after.setStartAfter(trailing);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);

        if (!Object.prototype.hasOwnProperty.call(_fnDefs, id)) _fnDefs[id] = '';
        renumberFootnotePills();
        contentDirty = true;
        contentEl.dispatchEvent(new Event('input'));
        openFootnoteEditor(sup, true);  // prompt for the note text immediately
    }

    // Popup for editing a footnote pill's text. Lives on <body>, outside the
    // contenteditable, mirroring the link popup so the markdown round-trip is safe.
    function setupFootnotePopup() {
        const popup = document.createElement('div');
        popup.className = 'hunk-popup fn-edit-popup';
        popup.hidden = true;
        popup.innerHTML =
            '<div class="hunk-popup-title">Footnote text</div>' +
            '<textarea class="hunk-popup-text" rows="3" aria-label="Footnote text"></textarea>' +
            '<div class="hunk-popup-actions">' +
            '<button type="button" class="hunk-popup-save">Save</button>' +
            '<button type="button" class="fn-popup-remove">Remove</button>' +
            '</div>';
        document.body.appendChild(popup);
        _fnPopupEl = popup;
        const ta = popup.querySelector('.hunk-popup-text');

        function close() { popup.hidden = true; _fnPopupPill = null; }
        function save() {
            if (!_fnPopupPill) return;
            const id = _fnPopupPill.getAttribute('data-fnid') || '';
            _fnDefs[id] = ta.value;
            close();
            contentDirty = true;
            contentEl.dispatchEvent(new Event('input'));
            toast('Footnote saved', 'success');
        }
        function remove() {
            if (!_fnPopupPill) return;
            const id = _fnPopupPill.getAttribute('data-fnid') || '';
            _fnPopupPill.remove();
            // Drop the definition only if no other pill shares this id.
            if (!contentEl.querySelector('.fn-pill[data-fnid="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]')) {
                delete _fnDefs[id];
            }
            renumberFootnotePills();
            close();
            contentDirty = true;
            contentEl.dispatchEvent(new Event('input'));
            toast('Footnote removed', 'success');
        }

        popup.querySelector('.hunk-popup-save').addEventListener('click', save);
        popup.querySelector('.fn-popup-remove').addEventListener('click', remove);
        ta.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); close(); contentEl.focus(); }
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        });

        // Click a pill to edit; click elsewhere closes.
        contentEl.addEventListener('click', e => {
            const pill = e.target && e.target.closest && e.target.closest('.fn-pill');
            if (pill && contentEl.contains(pill)) { e.preventDefault(); openFootnoteEditor(pill, false); }
        });
        document.addEventListener('mousedown', e => {
            if (popup.hidden) return;
            if (popup.contains(e.target)) return;
            if (e.target.closest && e.target.closest('.fn-pill')) return;
            close();
        });
    }

    function openFootnoteEditor(pill, isNew) {
        if (!_fnPopupEl || !pill) return;
        _fnPopupPill = pill;
        const id = pill.getAttribute('data-fnid') || '';
        const ta = _fnPopupEl.querySelector('.hunk-popup-text');
        ta.value = Object.prototype.hasOwnProperty.call(_fnDefs, id) ? (_fnDefs[id] || '') : '';
        _fnPopupEl.querySelector('.hunk-popup-title').textContent = isNew ? 'New footnote text' : 'Footnote text';
        _fnPopupEl.hidden = false;  // unhide to measure
        const r = pill.getBoundingClientRect();
        const pw = _fnPopupEl.offsetWidth, ph = _fnPopupEl.offsetHeight;
        const left = Math.max(12, Math.min(r.left, window.innerWidth - pw - 12));
        let top = r.bottom + 6;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
        _fnPopupEl.style.left = left + 'px';
        _fnPopupEl.style.top = top + 'px';
        ta.focus();
    }

    function setupContentEditor() {
        // Make execCommand emit semantic tags (<b>/<i>) instead of styled <span>s, so
        // bold/italic survive serialization. (styleWithCSS=true would produce
        // <span style="font-weight:bold">, which older serialization dropped entirely.)
        try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* not supported */ }

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
                if (e.shiftKey && key === 'f') {   // Ctrl+Shift+F = insert footnote
                    e.preventDefault();
                    applyFormat('footnote');
                    return;
                }
                // Ctrl+Shift+8 = bullet list (Shift+8 reports as '*' or via Digit8 code).
                if (e.shiftKey && (e.code === 'Digit8' || key === '8' || key === '*')) {
                    e.preventDefault();
                    applyFormat('ul');
                    return;
                }
                // Ctrl+U = underline (was bullet list; moved to Ctrl+Shift+8).
                const map = { 'b': 'bold', 'i': 'italic', 'u': 'underline', '2': 'h2', '3': 'h3', 'q': 'quote', 'e': 'example', 'l': 'link', '0': 'paragraph' };
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
            // Normalize pasted plain text: unify line endings and drop trailing blank lines
            // (copying a block often appends a trailing newline, which otherwise lands as an
            // extra empty paragraph). Interior blank lines are preserved.
            const text = e.clipboardData.getData('text/plain')
                .replace(/\r\n?/g, '\n')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n+$/, '');
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

    // Render node markdown for the read-only Preview pane: authored [^id] footnotes
    // become a "Notes" list and links become numbered "References" — same dual
    // presentation as the Viewer.
    function renderPreviewWithFootnotes(md, prefix) {
        const pf = fnSanitizeId(prefix);
        const harvested = harvestFootnoteDefsEd(md || '');
        const prevFn = _fnEd, prevPf = _fnPrefixEd;
        const prevNotes = _fnNotesEd, prevSeen = _fnNotesSeenEd, prevDefs = _fnNotesDefsEd;
        _fnEd = [];
        _fnNotesEd = [];
        _fnNotesSeenEd = {};
        _fnNotesDefsEd = harvested.defs;
        _fnPrefixEd = pf;
        let body, links, usedNotes, defs;
        try {
            body = markdownToHtml(harvested.bodyMd);
        } finally {
            links = _fnEd;
            usedNotes = _fnNotesEd;
            defs = _fnNotesDefsEd;
            _fnEd = prevFn;
            _fnPrefixEd = prevPf;
            _fnNotesEd = prevNotes; _fnNotesSeenEd = prevSeen; _fnNotesDefsEd = prevDefs;
        }
        return body + buildPreviewNotes(usedNotes, defs, pf) + buildPreviewRefs(links, pf);
    }

    function buildPreviewNotes(used, defs, pf) {
        used = used || [];
        defs = defs || {};
        const referenced = {};
        used.forEach(u => { referenced[u.id] = true; });
        const orphans = Object.keys(defs).filter(id => !referenced[id]);
        if (!used.length && !orphans.length) return '';
        let html = '<section class="fn-notes" aria-label="Notes">' +
            '<h2 class="fn-notes-title">Notes</h2><ol class="fn-notes-list">';
        used.forEach(u => {
            const has = Object.prototype.hasOwnProperty.call(defs, u.id) && defs[u.id] !== '';
            const inner = has ? inlineFormat(defs[u.id])
                : '<span class="fn-error">[no footnote text yet]</span>';
            html += `<li id="fn-${pf}-note-${u.n}" class="fn-note-item${has ? '' : ' fn-error'}">` +
                `<span class="fn-note-text">${inner}</span> ` +
                `<a class="fn-note-backref" href="#fnref-${pf}-note-${u.n}" aria-label="Back to note ${u.n}">↩</a></li>`;
        });
        orphans.forEach(id => {
            html += `<li class="fn-note-item fn-orphan"><span class="fn-note-text">${inlineFormat(defs[id])}</span> ` +
                `<span class="fn-orphan-tag">(unreferenced: ${escHtml(id)})</span></li>`;
        });
        html += '</ol></section>';
        return html;
    }

    function buildPreviewRefs(collected, pf) {
        if (!collected || !collected.length) return '';
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
        return refs;
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

    return { init, toast, applyFormat, updatePreview, commitLink, cancelLink, flushContent,
             toggleSuggestMode, enterReview, exitReview };
})();
