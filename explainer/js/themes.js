/* ============================================
   THEMES — Theme switching and persistence
   ============================================ */

const Themes = (() => {
    const themeMap = {
        'clean': 'Clean',
        'academic': 'Academic',
        'dark': 'Dark',
        'high-contrast': 'High Contrast'
    };

    function init() {
        const themeBtn = document.getElementById('theme-btn');
        const modal = document.getElementById('theme-modal');
        const grid = document.getElementById('theme-grid');
        const closeBtn = modal.querySelector('.modal-close');

        buildGrid(grid);
        applyTheme(State.getTheme());

        themeBtn.addEventListener('click', () => toggleModal(modal));
        closeBtn.addEventListener('click', () => hideModal(modal));
        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.classList.contains('modal-backdrop')) hideModal(modal);
        });

        State.on('theme-changed', applyTheme);
    }

    function buildGrid(grid) {
        grid.innerHTML = '';
        Object.entries(themeMap).forEach(([key, label]) => {
            const option = document.createElement('button');
            option.classList.add('theme-option');
            option.dataset.theme = key;
            option.textContent = label;
            if (key === State.getTheme()) option.classList.add('active');

            option.addEventListener('click', () => {
                grid.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
                option.classList.add('active');
                State.setTheme(key);
            });

            grid.appendChild(option);
        });
    }

    function applyTheme(theme) {
        document.body.className = `theme-${theme}`;
    }

    function toggleModal(modal) {
        modal.classList.toggle('visible');
        modal.setAttribute('aria-hidden', !modal.classList.contains('visible'));
    }

    function hideModal(modal) {
        modal.classList.remove('visible');
        modal.setAttribute('aria-hidden', 'true');
    }

    return { init };
})();
