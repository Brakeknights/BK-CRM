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

  // --- Notifications toggle ---
  const notifRow = document.getElementById('notif-row');
  const notifValue = document.getElementById('notif-value');
  const notifHint = document.getElementById('notif-hint');
  let busy = false;

  async function refreshNotif() {
    if (!BKP.pushSupported()) {
      notifValue.textContent = 'Unavailable';
      notifHint.textContent = 'This device or browser does not support notifications. On iPhone, open the app from your Home Screen.';
      notifRow.disabled = true;
      return;
    }
    const on = await BKP.pushEnabled().catch(() => false);
    notifValue.textContent = on ? 'On' : 'Off';
  }

  notifRow.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      const on = await BKP.pushEnabled().catch(() => false);
      if (on) {
        await BKP.disablePush();
        BKP.toast('Notifications turned off');
      } else {
        await BKP.enablePush();
        BKP.toast('Notifications on, you’ll be alerted on new texts');
      }
      await refreshNotif();
    } catch (e) {
      BKP.toast(e.message || 'Could not change notifications', true);
    } finally {
      busy = false;
    }
  });

  refreshNotif();
})();
