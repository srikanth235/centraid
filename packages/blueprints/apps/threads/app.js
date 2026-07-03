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

// One narration for every action outcome; returns true when it executed.
function narrate(outcome, onDenied) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it lands once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
    if (onDenied) onDenied();
  }
  return false;
}

async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return undefined;
  }
}

// ---------- Attachments (shared pattern across apps) ----------
// Read a File as a base64 data: URI — the vault stores bytes inline, so the
// browser does the encoding before the data ever leaves the app.
function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Render an attachment strip: images as thumbnails, everything else as a
// download tile, each with a remove control wired to the detach action.
function renderAttachments(stripEl, list, onRemove) {
  stripEl.innerHTML = '';
  for (const a of list ?? []) {
    const tile = document.createElement('div');
    tile.className = 'attach-tile';
    if (String(a.media_type).startsWith('image/')) {
      const img = document.createElement('img');
      img.src = a.content_uri;
      img.alt = a.title ?? 'attachment';
      tile.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.className = 'attach-file';
      link.href = a.content_uri;
      link.download = a.title ?? 'file';
      link.textContent = (a.title ?? a.media_type ?? 'file').slice(0, 24);
      tile.appendChild(link);
    }
    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    meta.textContent = fmtBytes(a.byte_size);
    tile.appendChild(meta);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => onRemove(a.attachment_id));
    tile.appendChild(rm);
    stripEl.appendChild(tile);
  }
}

// Wire a file <input> so each chosen file is attached to the current subject.
function wireAttachInput(inputEl, getSubjectId) {
  inputEl.addEventListener('change', async () => {
    const subjectId = getSubjectId();
    if (!subjectId) return;
    for (const file of [...inputEl.files]) {
      let dataUri;
      try {
        dataUri = await fileToDataUri(file);
      } catch {
        notice('Could not read that file.');
        continue;
      }
      const outcome = await act('attach', { subject_id: subjectId, data_uri: dataUri, title: file.name });
      if (!narrate(outcome, refresh)) break;
    }
    inputEl.value = '';
    await refresh();
  });
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
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
    renderAttachments($('attachStrip'), [], removeAttachment);
    return;
  }
  renderMessages(data?.messages ?? []);
  renderAttachments($('attachStrip'), data?.attachments ?? [], removeAttachment);
}

function renderMessages(messages) {
  const list = $('messageList');
  list.innerHTML = '';
  $('emptyThread').hidden = messages.length > 0;
  let prev = null;
  for (const m of messages) {
    // `mine` comes from the query comparing the sender against the vault's
    // owner party — alignment is a fact read from the vault, not a guess.
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.dataset.delivery = m.delivery;
    msg.dataset.mine = String(Boolean(m.mine));
    const grouped = prev && prev.sender_party_id === m.sender_party_id;
    if (!grouped && !m.mine) {
      const who = document.createElement('p');
      who.className = 'msg-sender muted small';
      who.textContent = m.sender;
      msg.appendChild(who);
    }
    const bubble = document.createElement('p');
    bubble.className = 'msg-body';
    bubble.textContent = m.body;
    const meta = document.createElement('p');
    meta.className = 'msg-meta muted small';
    meta.textContent = `${fmtTime(m.sent_at)}${m.delivery === 'draft' ? ' · draft' : ''}`;
    msg.append(bubble, meta);
    list.appendChild(msg);
    prev = m;
  }
  list.scrollTop = list.scrollHeight;
}

$('backBtn').addEventListener('click', showInbox);

wireAttachInput($('attachInput'), () => currentThread?.thread_id);

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
