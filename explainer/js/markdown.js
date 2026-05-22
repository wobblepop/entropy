/* ============================================
   MARKDOWN — Lightweight Markdown to HTML
   No dependencies. Handles common patterns.
   ============================================ */

const Markdown = (() => {
    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, c => map[c]);
    }

    function parseInline(text) {
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>');
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

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

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

            // Example blocks (:::example / :::)
            if (line.match(/^:::example\s*$/i)) {
                if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                inExample = true;
                html += '<div class="example-block"><span class="example-label"></span>';
                continue;
            }
            if (inExample && line.match(/^:::\s*$/)) {
                html += '</div>';
                inExample = false;
                continue;
            }
            if (inExample) {
                const trimmed = line.trim();
                if (trimmed) {
                    html += `<p>${parseInline(trimmed)}</p>`;
                }
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
        if (inExample) html += '</div>';
        if (inCodeBlock) html += '</code></pre>';

        return html;
    }

    return { parse, parseInline, escapeHtml };
})();
