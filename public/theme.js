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
    document.querySelectorAll('[data-theme-select]').forEach(el => { el.value = theme; });
  };
  window.GPPTheme = { get, apply };
  apply(get());
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-select]').forEach(select => {
      select.value = get();
      select.addEventListener('change', () => apply(select.value));
    });
  });
})();
