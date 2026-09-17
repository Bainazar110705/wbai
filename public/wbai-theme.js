(() => {
  const storageKey = 'wbai_theme';
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function preferredTheme() {
    try { return localStorage.getItem(storageKey) || (darkQuery.matches ? 'dark' : 'light'); }
    catch { return darkQuery.matches ? 'dark' : 'light'; }
  }

  function icon(theme) {
    return theme === 'dark'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z"/></svg>';
  }

  function applyTheme(theme, persist) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = normalized;
    document.documentElement.style.colorScheme = normalized;
    if (persist) {
      try { localStorage.setItem(storageKey, normalized); } catch {}
    }
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const isDark = normalized === 'dark';
      button.setAttribute('aria-pressed', String(isDark));
      button.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
      const glyph = button.querySelector('[data-theme-icon]');
      if (glyph) glyph.innerHTML = icon(normalized);
    });
  }

  applyTheme(preferredTheme(), false);
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(preferredTheme(), false);
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
    });
  });
  darkQuery.addEventListener?.('change', (event) => {
    try { if (!localStorage.getItem(storageKey)) applyTheme(event.matches ? 'dark' : 'light', false); } catch {}
  });
})();
