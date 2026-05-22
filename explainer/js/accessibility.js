/* ============================================
   ACCESSIBILITY — Keyboard nav, ARIA, focus
   ============================================ */

const Accessibility = (() => {
    function init() {
        setupKeyboardNav();
        setupFontModal();
        setupAnnouncements();
    }

    function setupKeyboardNav() {
        document.addEventListener('keydown', e => {
            // Escape closes modals
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.visible').forEach(m => {
                    m.classList.remove('visible');
                    m.setAttribute('aria-hidden', 'true');
                });
            }

            // Alt+Left = back
            if (e.altKey && e.key === 'ArrowLeft') {
                e.preventDefault();
                State.goBack();
            }

            // Alt+Home = home
            if (e.altKey && e.key === 'Home') {
                e.preventDefault();
                State.goHome();
            }

            // Ctrl+/ = toggle sidebar
            if (e.ctrlKey && e.key === '/') {
                e.preventDefault();
                State.toggleSidebar();
            }

            // / to focus search (when not in input)
            if (e.key === '/' && !isInputFocused()) {
                e.preventDefault();
                document.getElementById('nav-search').focus();
            }
        });
    }

    function setupFontModal() {
        const fontBtn = document.getElementById('font-btn');
        const modal = document.getElementById('font-modal');
        const closeBtn = modal.querySelector('.modal-close');
        const sizeSlider = document.getElementById('font-size-slider');
        const heightSlider = document.getElementById('line-height-slider');
        const widthSlider = document.getElementById('content-width-slider');
        const sizeDisplay = document.getElementById('font-size-display');
        const heightDisplay = document.getElementById('line-height-display');
        const widthDisplay = document.getElementById('content-width-display');

        sizeSlider.value = State.getFontSize();
        heightSlider.value = State.getLineHeight();
        widthSlider.value = State.getContentWidth();
        sizeDisplay.textContent = State.getFontSize() + 'px';
        heightDisplay.textContent = State.getLineHeight();
        widthDisplay.textContent = State.getContentWidth() + 'px';

        applySettings();

        fontBtn.addEventListener('click', () => {
            modal.classList.toggle('visible');
            modal.setAttribute('aria-hidden', !modal.classList.contains('visible'));
        });

        closeBtn.addEventListener('click', () => {
            modal.classList.remove('visible');
            modal.setAttribute('aria-hidden', 'true');
        });

        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.classList.contains('modal-backdrop')) {
                modal.classList.remove('visible');
                modal.setAttribute('aria-hidden', 'true');
            }
        });

        sizeSlider.addEventListener('input', () => {
            const val = parseInt(sizeSlider.value);
            sizeDisplay.textContent = val + 'px';
            State.setFontSize(val);
        });

        heightSlider.addEventListener('input', () => {
            const val = parseFloat(heightSlider.value);
            heightDisplay.textContent = val.toFixed(1);
            State.setLineHeight(val);
        });

        widthSlider.addEventListener('input', () => {
            const val = parseInt(widthSlider.value);
            widthDisplay.textContent = val + 'px';
            State.setContentWidth(val);
        });

        State.on('settings-changed', applySettings);
    }

    function applySettings() {
        document.documentElement.style.setProperty('--font-size', State.getFontSize() + 'px');
        document.documentElement.style.setProperty('--line-height', State.getLineHeight());
        document.documentElement.style.setProperty('--content-width', State.getContentWidth() + 'px');
    }

    function setupAnnouncements() {
        const announcer = document.createElement('div');
        announcer.setAttribute('role', 'status');
        announcer.setAttribute('aria-live', 'polite');
        announcer.setAttribute('aria-atomic', 'true');
        announcer.classList.add('sr-only');
        document.body.appendChild(announcer);

        State.on('navigate', nodeId => {
            const node = State.getNode(nodeId);
            if (node) {
                announcer.textContent = `Navigated to: ${node.title}`;
            }
        });
    }

    function isInputFocused() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    return { init };
})();
