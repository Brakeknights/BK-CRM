// ===========================================================================
// bk-phone / public/js/threads.js  —  the conversation list screen
// ---------------------------------------------------------------------------
// Loads every conversation and draws the list. A row shows the customer's NAME
// (not just a number) when we know it, the time, a preview, and an unread dot.
// Tapping a row opens that conversation.
// ===========================================================================

(function () {
  const listEl = document.getElementById('thread-list');
  const loadingEl = document.getElementById('loading');
  const emptyEl = document.getElementById('empty');

  // ---- Theme toggle (updates the icon to a sun/moon) ----------------------
  const toggleBtn = document.getElementById('theme-toggle');
  function refreshThemeIcon() {
    const dark = BKP.getTheme() === 'dark';
    // moon when dark (tap -> go light), sun when light (tap -> go dark)
    document.getElementById('theme-icon').innerHTML = dark
      ? '<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/>'
      : '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"/>';
  }
  toggleBtn.addEventListener('click', () => { BKP.toggleTheme(); refreshThemeIcon(); });
  refreshThemeIcon();

  // ---- Compose a new text (simple for now; full screen comes later) -------
  document.getElementById('compose').addEventListener('click', async () => {
    const to = prompt('Text a new number (e.g. 571-555-1234):');
    if (!to) return;
    const text = prompt('Message:');
    if (!text) return;
    try {
      const r = await BKP.api('/api/send', { method: 'POST', body: JSON.stringify({ to, text }) });
      window.location.href = '/thread/' + r.threadId;
    } catch (e) { BKP.toast(e.message, true); }
  });

  // ---- Render one conversation row ----------------------------------------
  function rowHtml(t) {
    const name = BKP.esc(BKP.displayName(t));
    const inits = BKP.initials(t);
    const avatar = inits
      ? `<div class="avatar known">${BKP.esc(inits)}</div>`
      : `<div class="avatar"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg></div>`;
    const unread = t.unread_count > 0;
    return `
      <li class="thread-row ${unread ? 'unread' : ''}" data-id="${t.id}">
        ${avatar}
        <div class="thread-main">
          <div class="thread-top">
            <span class="thread-name">${name}</span>
            <span class="thread-time">${BKP.esc(BKP.shortTime(t.last_message_at || t.created_at))}</span>
          </div>
          <div class="thread-preview">${BKP.esc(t.last_message_preview || 'New conversation')}</div>
        </div>
        ${unread ? '<span class="unread-dot"></span>' : ''}
      </li>`;
  }

  // ---- Load + draw --------------------------------------------------------
  async function load() {
    try {
      const { threads } = await BKP.api('/api/threads');
      loadingEl.hidden = true;
      if (!threads.length) { emptyEl.hidden = false; return; }
      listEl.innerHTML = threads.map(rowHtml).join('');
      listEl.hidden = false;
      // tap a row -> open the conversation
      listEl.querySelectorAll('.thread-row').forEach(row => {
        row.addEventListener('click', () => {
          window.location.href = '/thread/' + row.dataset.id;
        });
      });
    } catch (e) {
      loadingEl.hidden = true;
      BKP.toast(e.message, true);
    }
  }

  load();
})();
