/* ============================================
   MEDIA — Handles multimedia content rendering
   Images, video, audio, embeds, diagrams
   ============================================ */

const Media = (() => {
    function render(media) {
        const posClass = media.position ? media.position : 'inline';
        const alt = media.alt || '';
        const caption = media.caption || '';

        let inner = '';

        switch (media.type) {
            case 'image':
                inner = `<img src="${escAttr(media.src)}" alt="${escAttr(alt)}" loading="lazy">`;
                break;

            case 'video':
                inner = `<video controls preload="metadata" aria-label="${escAttr(alt)}">
                    <source src="${escAttr(media.src)}">
                    <p>Your browser does not support video playback.</p>
                </video>`;
                break;

            case 'audio':
                inner = `<audio controls preload="metadata" aria-label="${escAttr(alt)}">
                    <source src="${escAttr(media.src)}">
                    <p>Your browser does not support audio playback.</p>
                </audio>`;
                break;

            case 'embed':
                inner = `<iframe src="${escAttr(media.src)}" title="${escAttr(alt)}"
                    loading="lazy" sandbox="allow-scripts allow-same-origin"
                    style="width:100%;height:400px;border:none;"></iframe>`;
                break;

            case 'diagram':
                inner = `<div class="diagram-container" data-src="${escAttr(media.src)}" aria-label="${escAttr(alt)}">
                    <img src="${escAttr(media.src)}" alt="${escAttr(alt)}" loading="lazy">
                </div>`;
                break;

            default:
                inner = `<p>Unsupported media type: ${media.type}</p>`;
        }

        return `<figure class="media-item ${posClass}" role="figure" aria-label="${escAttr(caption || alt)}">
            ${inner}
            ${caption ? `<figcaption class="media-caption">${Markdown.escapeHtml(caption)}</figcaption>` : ''}
        </figure>`;
    }

    function escAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    return { render };
})();
