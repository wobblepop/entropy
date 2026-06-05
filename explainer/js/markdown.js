/* ============================================
   MARKDOWN — Lightweight Markdown to HTML
   No dependencies. Handles common patterns.
   ============================================ */

const Markdown = (() => {
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

    function sanitizeId(s) {
        return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '-') || 'fn';
    }

    function parseInline(text) {
        let t = text
            .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-image">')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');
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
        return t.replace(/~~(.+?)~~/g, '<del>$1</del>');
    }

    // Parse a full node's markdown, turning each inline link into a numbered
    // reference and appending a "References" list at the end (in the order the
    // links appear). idPrefix namespaces the anchor IDs so several nodes can be
    // rendered on one page (read-all mode) without colliding. Returns the body
    // HTML unchanged when the node has no links.
    function renderWithFootnotes(markdown, idPrefix) {
        const prefix = sanitizeId(idPrefix);
        const prevFootnotes = footnotes;
        const prevPrefix = fnPrefix;
        footnotes = [];
        fnPrefix = prefix;
        let body;
        let collected;
        try {
            body = parse(markdown);
        } finally {
            collected = footnotes;
            footnotes = prevFootnotes;
            fnPrefix = prevPrefix;
        }
        if (!collected || collected.length === 0) return body;

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
        return body + refs;
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
