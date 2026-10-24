/* ============================================
   MARKDOWN — Lightweight Markdown to HTML
   No dependencies. Handles common patterns.
   ============================================ */

const Markdown = (() => {
    // --- Equations (LaTeX) ---------------------------------------------------------------
    // Same dialect as the editor and the exporters: inline $...$ (opener not followed by
    // whitespace or $, closer not preceded by whitespace and not followed by a digit, so
    // "$5 and $10" stays text; \$ is a literal dollar; inline code is never scanned) and a
    // display block of a $$ line, TeX lines, a $$ line (or one line $$...$$). KaTeX renders
    // when loaded; otherwise the source shows in <code>. The TeX is kept in data-tex.
    const MATH_SCAN_RE = /(`[^`\n]*`)|(?<!\\)\$(?![\s$])((?:\\[\s\S]|[^$\\])+?)(?<![\s\\])\$(?!\d)/g;
    const MATH_PH_RE = /\uE000(\d+)\uE001/g;
    function katexLib() {
        if (typeof window !== 'undefined' && window.katex && window.katex.renderToString) return window.katex;
        if (typeof katex !== 'undefined' && katex && katex.renderToString) return katex;
        return null;
    }
    function renderTex(tex, display) {
        const k = katexLib();
        if (k) {
            try { return k.renderToString(tex, { displayMode: !!display, throwOnError: false, trust: false }); }
            catch (e) { /* fall through to the source form */ }
        }
        const d = display ? '$$' : '$';
        return '<code class="math-src">' + d + escapeHtml(tex) + d + '</code>';
    }
    function mathInlineHtml(tex) {
        return '<span class="math-inline" data-tex="' + escapeHtml(tex) + '">' + renderTex(tex, false) + '</span>';
    }
    function mathBlockHtml(tex) {
        return '<div class="math-display" data-tex="' + escapeHtml(tex) + '">' + renderTex(tex, true) + '</div>';
    }

    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, c => map[c]);
    }

    // Footnote/reference collection. When `footnotes` is a live array (set by
    // renderWithFootnotes), inline links become numbered superscript references
    // and are pushed onto the collector in document order. When null (the
    // default) links render as ordinary inline anchors — so any code that calls
    // parse()/parseInline() directly keeps its original behavior.
    let footnotes = null;
    let fnPrefix = '';

    // Authored footnotes ([^id] markers + [^id]: definitions). Kept separate from
    // the link-reference apparatus above: markers render as bracketed [n] feeding a
    // "Notes" list, links keep bare superscripts feeding "References".
    let notes = null;        // ordered list of {n, id} as markers first appear
    let notesSeen = null;    // id -> assigned display number (repeated markers reuse it)
    let notesDefs = null;    // id -> definition text harvested from the body

    function sanitizeId(s) {
        return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '-') || 'fn';
    }

    // Pull `[^id]: text` definition lines out of the markdown (skipping fenced
    // code so code samples are never altered). Returns the body without those
    // lines plus a map of id -> text. The first definition for an id wins.
    function harvestFootnoteDefs(md) {
        const defs = {};
        if (!md) return { bodyMd: md || '', defs };
        const lines = md.split('\n');
        const body = [];
        let inCode = false;
        const defRe = /^\[\^([A-Za-z0-9_-]+)\]:\s?(.*)$/;
        // A note may continue on following lines indented by four spaces (or a tab); a
        // blank line inside the note is kept when an indented line follows it.
        const contRe = /^(?: {4}|\t)(.*)$/;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^```/.test(line)) { inCode = !inCode; body.push(line); continue; }
            if (!inCode) {
                const m = line.match(defRe);
                if (m) {
                    const id = m[1];
                    const text = [m[2]];
                    while (i + 1 < lines.length) {
                        const cont = lines[i + 1].match(contRe);
                        if (cont) { text.push(cont[1]); i++; continue; }
                        if (lines[i + 1] === '' && i + 2 < lines.length && contRe.test(lines[i + 2])) {
                            text.push(''); i++; continue;
                        }
                        break;
                    }
                    if (Object.prototype.hasOwnProperty.call(defs, id)) {
                        if (typeof console !== 'undefined' && console.warn) {
                            console.warn('Footnote: duplicate definition for [^' + id + '] ignored.');
                        }
                    } else {
                        defs[id] = text.join('\n');
                    }
                    continue;  // strip the definition lines from the rendered body
                }
            }
            body.push(line);
        }
        return { bodyMd: body.join('\n'), defs };
    }

    // Footnote text may hold several lines: render each and join with <br>.
    function noteInline(text) {
        return String(text == null ? '' : text).split('\n').map(parseInline).join('<br>');
    }

    function parseInline(text) {
        // Equations first: lift $...$ out as placeholders so the emphasis rules never touch
        // TeX (which uses *, _ and ~ freely); inline code is left alone.
        const maths = [];
        let t = String(text == null ? '' : text).replace(MATH_SCAN_RE, (m, code, tex) => {
            if (code !== undefined) return code;
            maths.push(tex);
            return '\uE000' + (maths.length - 1) + '\uE001';
        });
        t = t.replace(/\\\$/g, '$')            // \$ is a literal dollar sign
            .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-image">')
            // Emphasis requires non-space flanking (opener not followed by whitespace,
            // closer not preceded by whitespace) so space-flanked asterisks like "3 * 4 * 5"
            // stay literal — matching the editor's serializer and keeping output idempotent.
            // The bold-italic (***) rule runs first (as in the editor and the Python
            // exporters); without it ***x*** rendered as mis-nested <strong><em>x</strong></em>.
            .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(?!\s)(.+?)(?<!\s)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');
        // Authored footnote markers — before links so [^id] isn't mistaken for a
        // link label. Only active when a notes collector is live (renderWithFootnotes).
        if (notes) {
            t = t.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (m, id) => {
                let n = notesSeen[id];
                if (n === undefined) { n = notes.length + 1; notesSeen[id] = n; notes.push({ n, id }); }
                return `<sup class="fn-marker" id="fnref-${fnPrefix}-note-${n}">` +
                    `<a href="#fn-${fnPrefix}-note-${n}">[${n}]</a></sup>`;
            });
        }
        if (footnotes) {
            t = t.replace(/\[(.+?)\]\((.+?)\)/g, (m, label, url) => {
                const n = footnotes.length + 1;
                footnotes.push({ n, label, url });
                // Keep the inline link clickable AND add a superscript reference
                // marker, so the end-of-chapter list serves print readers too.
                return `<a href="${url}" target="_blank" rel="noopener">${label}</a>` +
                    `<sup class="footnote-ref" id="fnref-${fnPrefix}-${n}">` +
                    `<a href="#fn-${fnPrefix}-${n}">${n}</a></sup>`;
            });
        } else {
            t = t.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        }
        return t.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<del>$1</del>')
            .replace(MATH_PH_RE, (m, i) => mathInlineHtml(maths[+i]));
    }

    // Parse a full node's markdown, turning each inline link into a numbered
    // reference and appending a "References" list at the end (in the order the
    // links appear). idPrefix namespaces the anchor IDs so several nodes can be
    // rendered on one page (read-all mode) without colliding. Returns the body
    // HTML unchanged when the node has no links.
    function renderWithFootnotes(markdown, idPrefix) {
        const prefix = sanitizeId(idPrefix);
        const harvested = harvestFootnoteDefs(markdown);
        const prevFootnotes = footnotes, prevPrefix = fnPrefix;
        const prevNotes = notes, prevSeen = notesSeen, prevDefs = notesDefs;
        footnotes = [];
        notes = [];
        notesSeen = {};
        notesDefs = harvested.defs;
        fnPrefix = prefix;
        let body, collectedLinks, collectedNotes, defs;
        try {
            body = parse(harvested.bodyMd);
        } finally {
            collectedLinks = footnotes;
            collectedNotes = notes;
            defs = notesDefs;
            footnotes = prevFootnotes;
            fnPrefix = prevPrefix;
            notes = prevNotes; notesSeen = prevSeen; notesDefs = prevDefs;
        }
        // Order: body, then authored Notes, then link References.
        return body + buildNotesSection(collectedNotes, defs, prefix) +
            buildReferencesSection(collectedLinks, prefix);
    }

    // Authored-footnote "Notes" list. Missing definitions and unreferenced
    // definitions are surfaced (warned + rendered), never silently dropped.
    function buildNotesSection(used, defs, prefix) {
        used = used || [];
        defs = defs || {};
        const referenced = {};
        used.forEach(u => { referenced[u.id] = true; });
        const orphans = Object.keys(defs).filter(id => !referenced[id]);
        if (used.length === 0 && orphans.length === 0) return '';

        let html = '<section class="fn-notes" aria-label="Notes">' +
            '<h2 class="fn-notes-title">Notes</h2><ol class="fn-notes-list">';
        for (const u of used) {
            const has = Object.prototype.hasOwnProperty.call(defs, u.id);
            if (!has && typeof console !== 'undefined' && console.warn) {
                console.warn('Footnote [^' + u.id + '] is referenced but has no definition.');
            }
            const inner = has ? noteInline(defs[u.id])
                : '<span class="fn-error">[missing footnote text: ' + escapeHtml(u.id) + ']</span>';
            html += `<li id="fn-${prefix}-note-${u.n}" class="fn-note-item${has ? '' : ' fn-error'}">` +
                `<span class="fn-note-text">${inner}</span> ` +
                `<a class="fn-note-backref" href="#fnref-${prefix}-note-${u.n}" ` +
                `aria-label="Back to note ${u.n}">↩</a></li>`;
        }
        for (const id of orphans) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('Footnote definition [^' + id + '] is never referenced.');
            }
            html += `<li class="fn-note-item fn-orphan"><span class="fn-note-text">${noteInline(defs[id])}</span> ` +
                `<span class="fn-orphan-tag">(unreferenced: ${escapeHtml(id)})</span></li>`;
        }
        html += '</ol></section>';
        return html;
    }

    // Existing link-reference apparatus, unchanged in form.
    function buildReferencesSection(collected, prefix) {
        if (!collected || collected.length === 0) return '';
        let refs = '<section class="footnotes" aria-label="References">' +
            '<h2 class="footnotes-title">References</h2>' +
            '<ol class="footnotes-list">';
        for (const f of collected) {
            const url = escapeHtml(f.url);
            refs += `<li id="fn-${prefix}-${f.n}" class="footnote-item">` +
                `<span class="footnote-text">${f.label}</span> ` +
                `<a class="footnote-url" href="${url}" target="_blank" rel="noopener">${url}</a> ` +
                `<a class="footnote-backref" href="#fnref-${prefix}-${f.n}" ` +
                `aria-label="Back to reference ${f.n} in the text">↩</a></li>`;
        }
        refs += '</ol></section>';
        return refs;
    }

    function parse(markdown) {
        if (!markdown) return '';
        const lines = markdown.split('\n');
        let html = '';
        let inList = false;
        let listType = '';
        let inBlockquote = false;
        let inCodeBlock = false;
        let inExample = false;
        let exampleBuf = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Example blocks (:::example / :::): once open, buffer every line
            // (including nested code fences) until the closing :::, then parse the
            // inner as full markdown. Checked BEFORE code/list handling so nested
            // ``` blocks aren't swallowed by the parsers below.
            if (inExample) {
                if (line.match(/^:::\s*$/)) {
                    html += '<div class="example-block"><span class="example-label"></span>' + parse(exampleBuf.join('\n')) + '</div>';
                    inExample = false;
                    exampleBuf = [];
                } else {
                    exampleBuf.push(line);
                }
                continue;
            }
            if (line.match(/^:::example\s*$/i)) {
                if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                inExample = true;
                exampleBuf = [];
                continue;
            }

            // Code blocks
            if (line.startsWith('```')) {
                if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                if (inCodeBlock) {
                    html += '</code></pre>';
                    inCodeBlock = false;
                } else {
                    inCodeBlock = true;
                    html += '<pre><code>';
                }
                continue;
            }
            if (inCodeBlock) {
                html += escapeHtml(line) + '\n';
                continue;
            }

            // Display equation: a $$ line, TeX lines, a $$ line -- or one line $$...$$.
            const dm = line.match(/^\s*\$\$(.*)$/);
            if (dm) {
                const rest = dm[1];
                let tex = null, skipTo = i;
                if (/\$\$\s*$/.test(rest) && rest.trim().length > 2) {
                    tex = rest.replace(/\$\$\s*$/, '').trim();
                } else if (!rest.trim()) {
                    let j = i + 1;
                    const buf = [];
                    while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j])) { buf.push(lines[j]); j++; }
                    if (j < lines.length) { tex = buf.join('\n').trim(); skipTo = j; }
                }
                if (tex !== null) {
                    if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                    if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                    html += mathBlockHtml(tex);
                    i = skipTo;
                    continue;
                }
                // an unclosed $$ is ordinary text
            }

            // Close lists if needed
            if (inList && !line.match(/^(\s*[-*+]|\s*\d+\.)\s/)) {
                html += listType === 'ul' ? '</ul>' : '</ol>';
                inList = false;
            }

            // Close blockquote when line doesn't start with >
            if (inBlockquote && !line.startsWith('>')) {
                html += '</blockquote>';
                inBlockquote = false;
            }

            // Headings
            const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                html += `<h${level}>${parseInline(headingMatch[2])}</h${level}>`;
                continue;
            }

            // Blockquote (handle > with or without trailing content)
            if (line.startsWith('>')) {
                const content = line.replace(/^>\s?/, '').trim();
                if (!inBlockquote) {
                    html += '<blockquote>';
                    inBlockquote = true;
                }
                if (content) {
                    html += `<p>${parseInline(content)}</p>`;
                }
                continue;
            }

            // Unordered list
            const ulMatch = line.match(/^\s*[-*+]\s+(.+)/);
            if (ulMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
                    html += '<ul>';
                    inList = true;
                    listType = 'ul';
                }
                html += `<li>${parseInline(ulMatch[1])}</li>`;
                continue;
            }

            // Ordered list
            const olMatch = line.match(/^\s*\d+\.\s+(.+)/);
            if (olMatch) {
                if (!inList || listType !== 'ol') {
                    if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
                    html += '<ol>';
                    inList = true;
                    listType = 'ol';
                }
                html += `<li>${parseInline(olMatch[1])}</li>`;
                continue;
            }

            // Horizontal rule
            if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
                html += '<hr>';
                continue;
            }

            // Empty line
            if (line.trim() === '') {
                continue;
            }

            // Paragraph
            html += `<p>${parseInline(line)}</p>`;
        }

        // Close unclosed elements
        if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
        if (inBlockquote) html += '</blockquote>';
        if (inExample) html += '<div class="example-block"><span class="example-label"></span>' + parse(exampleBuf.join('\n')) + '</div>';
        if (inCodeBlock) html += '</code></pre>';

        return html;
    }

    return { parse, parseInline, escapeHtml, renderWithFootnotes };
})();
