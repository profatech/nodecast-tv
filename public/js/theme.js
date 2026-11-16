/**
 * UI theme selection.
 * Loaded synchronously in <head> so the theme is applied before first paint.
 * The choice is per browser (localStorage); "classic" is the original look.
 */
(function () {
    const STORAGE_KEY = 'nodecast-theme';
    const DEFAULT_THEME = 'midnight-glass';
    const THEMES = ['midnight-glass', 'classic'];

    function read() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            return THEMES.includes(saved) ? saved : DEFAULT_THEME;
        } catch (e) {
            return DEFAULT_THEME;
        }
    }

    function apply(theme) {
        const root = document.documentElement;
        if (theme === 'classic') {
            root.removeAttribute('data-theme');
        } else {
            root.setAttribute('data-theme', theme);
        }
    }

    window.NodecastTheme = {
        themes: THEMES.slice(),
        get: read,
        set(theme) {
            if (!THEMES.includes(theme)) return;
            try {
                localStorage.setItem(STORAGE_KEY, theme);
            } catch (e) {
                // Storage unavailable: theme still applies for this page view
            }
            apply(theme);
        }
    };

    apply(read());
})();
