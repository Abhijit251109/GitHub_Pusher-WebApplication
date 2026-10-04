(() => {
  const KEY = 'gpp_theme';
  const valid = new Set(['system', 'dark', 'light']);
  const get = () => {
    const value = localStorage.getItem(KEY) || 'system';
    return valid.has(value) ? value : 'system';
  };
  const apply = value => {
    const theme = valid.has(value) ? value : 'system';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
    localStorage.setItem(KEY, theme);
    document.querySelectorAll('[data-theme-select], #themeSelect').forEach(el => { el.value = theme; });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const light = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
      meta.content = light ? '#f6f7fb' : '#111827';
    }
  };
  window.GPPTheme = { get, apply };
  apply(get());
  if (window.matchMedia) {
    const media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener?.('change', () => { if (get() === 'system') apply('system'); });
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-select], #themeSelect').forEach(select => {
      select.value = get();
      select.addEventListener('change', () => apply(select.value));
    });
  });
})();
