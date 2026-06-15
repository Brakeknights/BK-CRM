// ===========================================================================
// bk-phone / public/js/thread.js  —  one conversation
// ---------------------------------------------------------------------------
// Loads a conversation, draws the chat bubbles, shows the customer's name and a
// one-tap "View Profile" link, and sends replies. Sending is "optimistic": your
// message shows instantly, then quietly confirms it was delivered.
// ===========================================================================

(function () {
  const threadId = Number(location.pathname.split('/').pop());
  const loadingEl = document.getElementById('loading');
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  let messages = [];     // current messages in memory
  let thread = null;
  let tmpSeq = 0;

  document.getElementById('back').addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.href = '/';
  });

  // A few default quick replies (full editable templates come later).
  const QUICK = [
    'We come to you! What city are you in?',
    'What year, make, and model is the vehicle?',
    "Sounds good, I'll send your quote shortly.",
  ];

  // ---- Render -------------------------------------------------------------
  function statusLabel(m) {
    if (m.pending) return 'Sending…';
    const s = (m.status || '').toLowerCase();
    if (s.includes('fail')) return 'Failed';
    if (s === 'delivered') return 'Delivered';
    if (s === 'received') return '';
    return 'Sent';
  }

  // Should we print a timestamp/status line after this message? Only at the end
  // of a run from the same side (keeps the thread clean), or if it needs status.
  function showsMeta(m, next) {
    if (m.pending || (m.status || '').toLowerCase().includes('fail')) return true;
    if (!next) return true;
    if (next.direction !== m.direction) return true;
    return false;
  }

  function render() {
    let html = '';
    let lastDay = '';
    messages.forEach((m, i) => {
      const day = BKP.dayLabel(m.created_at);
      if (day && day !== lastDay) { html += `<div class="day-divider">${BKP.esc(day)}</div>`; lastDay = day; }

      const out = m.direction === 'outbound';
      const failed = (m.status || '').toLowerCase().includes('fail');
      html += `<div class="bubble-row ${out ? 'out' : 'in'}">
        <div class="bubble ${m.pending ? 'pending' : ''}">${BKP.esc(m.body)}</div>
      </div>`;

      if (showsMeta(m, messages[i + 1])) {
        const label = out ? statusLabel(m) : '';
        const time = BKP.clockTime(m.created_at);
        const parts = [time, label].filter(Boolean).join(' · ');
        if (parts) html += `<div class="bubble-meta ${failed ? 'failed' : ''}">${BKP.esc(parts)}</div>`;
      }
    });
    messagesEl.innerHTML = html;
    scrollToBottom();
  }

  function scrollToBottom() {
    const c = document.getElementById('content');
    c.scrollTop = c.scrollHeight;
  }

  // ---- Header + quick replies --------------------------------------------
  function renderHeader(profile) {
    const name = (profile && profile.name) || (thread.contact_name) || BKP.prettyPhone(thread.contact_phone);
    document.getElementById('hdr-name').textContent = name;
    // show the number underneath only when we have a real name (avoids repeating it)
    const hasName = !!((profile && profile.name) || thread.contact_name);
    document.getElementById('hdr-sub').textContent = hasName ? BKP.prettyPhone(thread.contact_phone) : '';

    const link = document.getElementById('profile-link');
    if (profile && profile.profileUrl) { link.href = profile.profileUrl; link.hidden = false; }
    else link.hidden = true;
  }

  function renderQuickReplies() {
    const wrap = document.getElementById('quick-replies');
    wrap.innerHTML = QUICK.map(q => `<button class="quick-reply">${BKP.esc(q)}</button>`).join('');
    wrap.querySelectorAll('.quick-reply').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        input.value = QUICK[i];
        input.focus();
        autoGrow();
        updateSendState();
      });
    });
  }

  // ---- Sending (optimistic) ----------------------------------------------
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; autoGrow(); updateSendState();

    const temp = {
      id: 'tmp_' + (++tmpSeq),
      direction: 'outbound',
      body: text,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      status: 'queued',
      pending: true,
    };
    messages.push(temp);
    render();

    try {
      const r = await BKP.api(`/api/threads/${threadId}/send`, { method: 'POST', body: JSON.stringify({ text }) });
      temp.pending = false;
      temp.status = r.status || 'sent';
      render();
    } catch (e) {
      temp.pending = false;
      temp.status = 'failed';
      render();
      BKP.toast(e.message || 'Message failed to send', true);
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter makes a new line.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ---- Textarea auto-grow + send button enable ----------------------------
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  function updateSendState() { sendBtn.disabled = input.value.trim().length === 0; }
  input.addEventListener('input', () => { autoGrow(); updateSendState(); });

  // ---- Load ---------------------------------------------------------------
  async function load() {
    try {
      const data = await BKP.api(`/api/threads/${threadId}`);
      thread = data.thread;
      messages = data.messages || [];
      loadingEl.hidden = true;
      renderHeader(data.profile);
      renderQuickReplies();
      render();
      input.focus();
    } catch (e) {
      loadingEl.hidden = true;
      BKP.toast(e.message, true);
    }
  }

  load();
})();
