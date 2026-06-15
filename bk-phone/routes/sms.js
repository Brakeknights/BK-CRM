// ===========================================================================
// bk-phone / routes/sms.js
// ---------------------------------------------------------------------------
// The texting brain. Two separate "doors" are exported:
//
//   webhook  - the PUBLIC door Telnyx knocks on when a customer texts us or
//              when a message we sent changes status (delivered / failed).
//              Every knock is signature-checked before we trust it.
//
//   app      - the PASSWORD-PROTECTED door your phone screens use: list of
//              conversations, the messages inside one, and sending a reply or
//              starting a new text.
//
// All database work goes through the helpers in db.js (every value parameterized)
// and all sending goes through telnyx.js.
// ===========================================================================

const express = require('express');
const path = require('path');
const dbm = require('../db');
const telnyx = require('../telnyx');
const crm = require('../crm');

const webhook = express.Router();
const app = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Short, single-line snippet of a message for the conversation list.
function preview(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ===========================================================================
// PUBLIC: Telnyx webhook
// ===========================================================================
webhook.post('/', (req, res) => {
  // 1) Prove it's really Telnyx. Reject anything that fails the signature.
  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  if (!telnyx.verifyWebhook(req.rawBody || '', signature, timestamp)) {
    console.warn('[sms webhook] rejected: bad/missing signature');
    return res.status(403).json({ error: 'invalid signature' });
  }

  // 2) Handle the event. We always answer 200 afterward (even on a handled
  //    error) so Telnyx doesn't retry the same event forever.
  try {
    const event = req.body && req.body.data ? req.body.data : {};
    const type = event.event_type;
    const payload = event.payload || {};

    if (type === 'message.received') {
      handleInbound(payload);                 // a customer texted us
    } else if (type === 'message.sent' || type === 'message.finalized') {
      handleStatus(payload);                  // delivery update on our outbound text
    }
    // other event types are ignored for now
  } catch (err) {
    console.error('[sms webhook] error handling event:', err.message);
  }

  res.json({ ok: true });
});

// A customer's incoming text -> save it to their conversation.
function handleInbound(payload) {
  const telnyxId = payload.id || null;
  if (telnyxId && dbm.messageExists(telnyxId)) return; // duplicate webhook, skip

  const from = payload.from && payload.from.phone_number;
  const to = Array.isArray(payload.to) && payload.to[0] && payload.to[0].phone_number;
  const text = payload.text || '';
  if (!from) return;

  // Match the number to a CRM customer so the conversation shows their name.
  const match = crm.lookupByPhone(from);
  const thread = dbm.getOrCreateThread(from, match && match.name, to || telnyx.TELNYX_NUMBER);
  dbm.insertMessage({
    thread_id: thread.id,
    direction: 'inbound',
    body: text,
    from_number: from,
    to_number: to || telnyx.TELNYX_NUMBER,
    telnyx_id: telnyxId,
    status: 'received',
  });
  dbm.touchThread(thread.id, preview(text), 1); // +1 unread

  // FUTURE (Phase 3): look up this number in the CRM to fill the customer name,
  // and (Phase 8E reuse) fire a push notification for the new message.
  console.log(`[sms] inbound from ${from} -> thread ${thread.id}`);
}

// Delivery status update on a text we sent -> update that message's status.
function handleStatus(payload) {
  const telnyxId = payload.id;
  if (!telnyxId) return;
  const recipient = Array.isArray(payload.to) ? payload.to[0] : null;
  const status = (recipient && recipient.status) || payload.status || null;
  const error = recipient && Array.isArray(recipient.errors) && recipient.errors[0]
    ? (recipient.errors[0].detail || recipient.errors[0].title)
    : null;
  if (status) dbm.updateMessageStatus(telnyxId, status, error);
}

// ===========================================================================
// PROTECTED: app screens + API (mounted behind requireAuth in server.js)
// ===========================================================================

// The two HTML screens (built in Files 6 & 7).
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/thread/:id', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'thread.html')));

// --- API: list every conversation (newest first) for the main screen --------
app.get('/api/threads', (_req, res) => {
  const threads = dbm.listThreads();
  // Self-heal: if a conversation has no name yet (e.g. the customer was added to
  // the CRM after they first texted), fill it in now.
  for (const t of threads) {
    if (!t.contact_name) {
      const match = crm.lookupByPhone(t.contact_phone);
      if (match && match.name) { dbm.setThreadName(t.id, match.name); t.contact_name = match.name; }
    }
  }
  res.json({ threads });
});

// --- API: one conversation + its messages (and mark it read) ----------------
app.get('/api/threads/:id', (req, res) => {
  const thread = dbm.getThreadById(Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'Conversation not found' });
  const messages = dbm.listMessagesByThread(thread.id);
  dbm.markThreadRead(thread.id); // opening a conversation clears its unread badge

  // Customer match powers the name + one-tap "View Profile" link in the header.
  const profile = crm.lookupByPhone(thread.contact_phone);
  if (profile && profile.name && !thread.contact_name) {
    dbm.setThreadName(thread.id, profile.name);
    thread.contact_name = profile.name;
  }
  res.json({ thread, messages, profile: profile || null });
});

// --- API: send a reply inside an existing conversation ----------------------
app.post('/api/threads/:id/send', async (req, res) => {
  const thread = dbm.getThreadById(Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'Conversation not found' });

  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message is empty' });

  const result = await telnyx.sendSms({ to: thread.contact_phone, text });

  // Save the message either way, so a failed send is visible in the thread.
  const id = dbm.insertMessage({
    thread_id: thread.id,
    direction: 'outbound',
    body: text,
    from_number: telnyx.TELNYX_NUMBER,
    to_number: thread.contact_phone,
    telnyx_id: result.id || null,
    status: result.ok ? (result.status || 'sent') : 'failed',
    error: result.ok ? null : result.error,
  });
  dbm.touchThread(thread.id, preview(text), 0);

  if (!result.ok) return res.status(502).json({ ok: false, id, error: result.error });
  res.json({ ok: true, id, status: result.status });
});

// --- API: start a NEW conversation (compose to a fresh number) ---------------
app.post('/api/send', async (req, res) => {
  const to = telnyx.toE164(req.body.to);
  const text = String(req.body.text || '').trim();
  if (!to || to.length < 8) return res.status(400).json({ error: 'Invalid phone number' });
  if (!text) return res.status(400).json({ error: 'Message is empty' });

  const thread = dbm.getOrCreateThread(to, null, telnyx.TELNYX_NUMBER);
  const result = await telnyx.sendSms({ to, text });

  const id = dbm.insertMessage({
    thread_id: thread.id,
    direction: 'outbound',
    body: text,
    from_number: telnyx.TELNYX_NUMBER,
    to_number: to,
    telnyx_id: result.id || null,
    status: result.ok ? (result.status || 'sent') : 'failed',
    error: result.ok ? null : result.error,
  });
  dbm.touchThread(thread.id, preview(text), 0);

  if (!result.ok) {
    return res.status(502).json({ ok: false, threadId: thread.id, id, error: result.error });
  }
  res.json({ ok: true, threadId: thread.id, id, status: result.status });
});

module.exports = { webhook, app };
