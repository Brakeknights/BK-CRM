// bk-phone / settings.js — Settings screen logic (theme, number, back)

(function () {
  document.getElementById('back').addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.href = '/';
  });

  // Theme row reflects + toggles the current theme.
  const themeValue = document.getElementById('theme-value');
  function refresh() { themeValue.textContent = BKP.getTheme() === 'dark' ? 'Dark' : 'Light'; }
  document.getElementById('theme-row').addEventListener('click', () => { BKP.toggleTheme(); refresh(); });
  refresh();

  // Show the business number.
  BKP.api('/api/config')
    .then(cfg => { document.getElementById('acct-number').textContent = BKP.prettyPhone(cfg.number) || cfg.number || ''; })
    .catch(() => {});
})();
