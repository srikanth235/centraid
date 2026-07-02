// Threads — a pure projection over the personal vault. Every row rendered
// here lives in social.thread / social.message (bodies in core.content_item);
// every mutation is a typed vault command routed through this app's handlers
// (ctx.vault on the gateway side). The app's own data.sqlite stays empty by
// design: revoke the grant and this page goes dark while the model, history
// and receipts remain the owner's. Sending is the consent showcase: the
// send action parks until the owner confirms it.

const $ = (id) => document.getElementById(id);

let currentThread = null; // the open thread row, or null for the inbox
let draftMessageId = null; // last drafted message awaiting Send

function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return String(iso).slice(0, 10);
  }
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function threadTitle(t) {
  if (t.subject) return t.subject;
  if (t.participants?.length) return t.participants.join(', ');
  return 'Untitled thread';
}

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

function showInbox() {
  currentThread = null;
  draftMessageId = null;
  $('sendBtn').disabled = true;
  $('messageView').hidden = true;
  $('threadList').hidden = false;
  notice('');
  refresh();
}

async function refresh() {
  if (currentThread) {
    await loadThread();
  } else {
    await loadInbox();
  }
}

async function loadInbox() {
  let data;
  try {
    data = await window.centraid.read({ query: 'inbox' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('threadList').innerHTML = '';
    $('emptyInbox').hidden = true;
    return;
  }
  renderInbox(data?.threads ?? []);
}

function renderInbox(threads) {
  const list = $('threadList');
  list.innerHTML = '';
  $('emptyInbox').hidden = threads.length > 0;
  for (const t of threads) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'thread-row';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = threadTitle(t);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t.channel;
    const time = document.createElement('span');
    time.className = 'row-when';
    time.textContent = fmtRelative(t.last_message_at ?? t.created_at);
    row.append(text, badge, time);
    row.addEventListener('click', () => openThread(t));
    list.appendChild(row);
  }
}

async function openThread(t) {
  currentThread = t;
  draftMessageId = null;
  $('sendBtn').disabled = true;
  $('composeInput').value = '';
  $('threadList').hidden = true;
  $('emptyInbox').hidden = true;
  $('messageView').hidden = false;
  $('threadTitle').textContent = threadTitle(t);
  notice('');
  await loadThread();
}

async function loadThread() {
  if (!currentThread) return;
  let data;
  try {
    data = await window.centraid.read({
      query: 'thread',
      input: { thread_id: currentThread.thread_id },
    });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('messageList').innerHTML = '';
    $('emptyThread').hidden = true;
    return;
  }
  renderMessages(data?.messages ?? []);
}

function renderMessages(messages) {
  const list = $('messageList');
  list.innerHTML = '';
  $('emptyThread').hidden = messages.length > 0;
  for (const m of messages) {
    // No owner flag on the row, so every bubble renders left-aligned with
    // its sender named — we never invent an "is mine" the vault didn't say.
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.dataset.delivery = m.delivery;
    const meta = document.createElement('p');
    meta.className = 'msg-meta muted small';
    meta.textContent = `${m.sender} · ${fmtTime(m.sent_at)}${
      m.delivery === 'draft' ? ' · draft' : ''
    }`;
    const bubble = document.createElement('p');
    bubble.className = 'msg-body';
    bubble.textContent = m.body;
    msg.append(meta, bubble);
    list.appendChild(msg);
  }
  list.scrollTop = list.scrollHeight;
}

$('backBtn').addEventListener('click', showInbox);

$('composeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body_text = $('composeInput').value.trim();
  if (!body_text || !currentThread) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'draft',
      input: { body_text, thread_id: currentThread.thread_id },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    draftMessageId = outcome.output?.message_id ?? null;
    $('sendBtn').disabled = !draftMessageId;
    notice(draftMessageId ? 'Draft saved — press Send to release it.' : '');
    await loadThread();
  } else if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — the draft will appear once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

$('sendBtn').addEventListener('click', async () => {
  if (!draftMessageId) return;
  let outcome;
  try {
    outcome = await window.centraid.write({
      action: 'send',
      input: { message_id: draftMessageId },
    });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  if (outcome?.status === 'executed') {
    draftMessageId = null;
    $('sendBtn').disabled = true;
    $('composeInput').value = '';
    notice('');
    await loadThread();
  } else if (outcome?.status === 'parked') {
    notice("Waiting for the owner to confirm — check the vault's parked queue.");
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    await refresh();
  }
});

window.addEventListener('focus', refresh);
refresh();
