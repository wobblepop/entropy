/* ============================================
   APP — Main entry point, file loading, glue
   Initializes all modules, handles file I/O
   ============================================ */

const App = (() => {
    function init() {
        Navigation.init();
        Renderer.init();
        ReadingMode.init();
        Themes.init();
        Accessibility.init();
        ExplainerGraph.init();
        setupFileLoading();
        setupNavButtons();
        setupSidebar();
        setupDragDrop();
        setupProgress();
        setupGraphToggle();
        setupStandaloneExport();
    }

    function setupFileLoading() {
        const input = document.getElementById('file-input');
        input.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) loadFile(file);
        });
    }

    function loadFile(file) {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.nodes || !data.root || !data.meta) {
                    showToast('That is not an Entropy file — it needs meta, nodes, and root.');
                    return;
                }
                State.loadContent(data);
            } catch (err) {
                showToast('Error parsing file: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    function setupNavButtons() {
        document.getElementById('back-btn').addEventListener('click', () => State.goBack());
        document.getElementById('home-btn').addEventListener('click', () => State.goHome());
    }

    function setupSidebar() {
        const sidebar = document.getElementById('sidebar');
        const content = document.getElementById('main-content');
        const toggle = document.getElementById('sidebar-toggle');

        toggle.addEventListener('click', () => State.toggleSidebar());

        State.on('sidebar-toggled', open => {
            sidebar.classList.toggle('collapsed', !open);
            sidebar.classList.toggle('open', open);
            content.classList.toggle('full-width', !open);
            toggle.setAttribute('aria-expanded', open);
        });
    }

    function setupDragDrop() {
        const overlay = document.createElement('div');
        overlay.classList.add('drag-overlay');
        overlay.innerHTML = '<span class="drag-overlay-text">Drop an Entropy file here</span>';
        document.body.appendChild(overlay);

        let dragCounter = 0;

        document.addEventListener('dragenter', e => {
            e.preventDefault();
            dragCounter++;
            overlay.classList.add('visible');
        });

        document.addEventListener('dragleave', e => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                overlay.classList.remove('visible');
            }
        });

        document.addEventListener('dragover', e => {
            e.preventDefault();
        });

        document.addEventListener('drop', e => {
            e.preventDefault();
            dragCounter = 0;
            overlay.classList.remove('visible');

            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.json')) {
                loadFile(file);
            } else {
                showToast('Please drop an Entropy file (.json)');
            }
        });
    }

    function setupProgress() {
        State.on('navigate', updateProgress);
        State.on('progress-changed', updateProgress);
    }

    function updateProgress() {
        const progress = State.getProgress();
        const arc = document.getElementById('progress-arc');
        const angle = progress * 360;
        const rad = angle * Math.PI / 180;
        const x = 10 + 8 * Math.sin(rad);
        const y = 10 - 8 * Math.cos(rad);
        const largeArc = angle > 180 ? 1 : 0;

        if (angle === 0) {
            arc.setAttribute('d', '');
        } else if (angle >= 360) {
            arc.setAttribute('d', 'M10 2 A8 8 0 1 1 9.99 2');
        } else {
            arc.setAttribute('d', `M10 2 A8 8 0 ${largeArc} 1 ${x} ${y}`);
        }

        const data = State.getData();
        if (!data) return;
        const totalNodes = Object.keys(data.nodes).length;
        document.getElementById('progress-btn').title =
            `Progress: ${Math.round(progress * 100)}% (${Math.round(progress * totalNodes)}/${totalNodes} sections)`;
    }

    function setupStandaloneExport() {
        const btn = document.getElementById('standalone-btn');
        if (!btn) return;
        // The export injects the generated reader template (VIEWER_TEMPLATE). Inside
        // an already-exported file or the editor's embedded preview that template is
        // absent — hide the button instead of offering an action that can't work.
        if (typeof VIEWER_TEMPLATE === 'undefined') { btn.hidden = true; return; }
        btn.addEventListener('click', () => {
            const data = State.getData();
            if (!data) { showToast('Load a file first'); return; }
            showToast('Building standalone file…');
            try {
                Standalone.exportToHtml(data, showToast);
            } catch (err) {
                showToast('Export failed: ' + err.message);
            }
        });
    }

    function setupGraphToggle() {
        const btn = document.getElementById('graph-toggle-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            ExplainerGraph.toggle();
            btn.classList.toggle('active', ExplainerGraph.isVisible());
        });
    }

    function showToast(message) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.classList.add('toast');
        toast.textContent = message;
        toast.setAttribute('role', 'alert');
        document.body.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    document.addEventListener('DOMContentLoaded', init);

    return { loadFile, showToast };
})();
