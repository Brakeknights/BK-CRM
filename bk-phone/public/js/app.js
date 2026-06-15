// ===========================================================================
// bk-phone / public/js/app.js  —  shared front-end helpers
// ---------------------------------------------------------------------------
// Small toolbox used by every screen: theme switching, safe text rendering,
// a fetch wrapper, friendly timestamps, phone formatting, avatar initials,
// and a toast for messages. Kept dependency-free and tiny so the app loads
// instantly.
// ===========================================================================

const BKP = (() => {
  // ---- Theme (dark default, light optional, remembered per device) --------
  const THEME_KEY = 'bkphone-theme';
  function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  function getTheme() { return localStorage.getItem(THEME_KEY) || 'dark'; }
  function setTheme(theme) { localStorage.setItem(THEME_KEY, theme); applyTheme(theme); }
  function toggleTheme() { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); }
  applyTheme(getTheme()); // apply ASAP

  // ---- Safe text: prevents customer text from injecting HTML/script -------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- API helper: JSON fetch that bounces to /login on 401 ---------------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---- Timestamps: SQLite stores UTC like "2026-06-15 02:36:30" ------------
  function parseUTC(ts) {
    if (!ts) return null;
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d;
  }
  // Short label for the conversation list (iMessage-style).
  function shortTime(ts) {
    const d = parseUTC(ts); if (!d) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    const days = (now - d) / 86400000;
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
  }
  // Full clock time for a message bubble.
  function clockTime(ts) {
    const d = parseUTC(ts); if (!d) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  // Day heading for grouping messages.
  function dayLabel(ts) {
    const d = parseUTC(ts); if (!d) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // ---- Phone formatting: +17035551234 -> (703) 555-1234 -------------------
  function prettyPhone(e164) {
    if (!e164) return '';
    const m = String(e164).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
    return e164;
  }

  // ---- Display name + avatar initials -------------------------------------
  function displayName(thread) {
    return thread.contact_name && thread.contact_name.trim()
      ? thread.contact_name.trim()
      : prettyPhone(thread.contact_phone);
  }
  function initials(thread) {
    const name = thread.contact_name && thread.contact_name.trim();
    if (name) {
      const parts = name.split(/\s+/);
      return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
    }
    return ''; // no name: caller will show a generic person icon instead
  }

  // ---- Toast --------------------------------------------------------------
  let toastTimer;
  function toast(message, isError = false) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3200);
  }

  return {
    getTheme, setTheme, toggleTheme,
    esc, api,
    shortTime, clockTime, dayLabel,
    prettyPhone, displayName, initials,
    toast,
  };
})();
