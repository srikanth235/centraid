// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Threads is a finished messenger — inbox with search/filters, new-conversation picker, delivery-state bubbles, consent-parked sends — and splitting it would break that "one file" contract.
// Threads — a pure projection over the personal vault. Every row rendered
// here lives in social.thread / social.message (bodies in core.content_item);
// every mutation is a typed vault command routed through this app's handlers
// (ctx.vault on the gateway side). The app's own data.sqlite stays empty by
// design: revoke the grant and this page goes dark while the model, history
// and receipts remain the owner's. Sending is the consent showcase: the
// send action parks until the owner confirms it — the bubble wears that
// state (⏳ chip) instead of a banner sentence.

import {
  debounce,
  letterAvatar,
  localDayKey,
  outcomeMessage,
  readFailed,
  relTime,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

let currentThread = null; // the open thread row, or null for the inbox
let inboxThreads = []; // last inbox payload, for client-side search/filter
let inboxParties = []; // recipient directory for New message (owner excluded)
let searchText = '';
let channelFilter = ''; // '' = all
let firstInboxLoad = true;
// message_ids whose send parked this session — the ⏳ "waiting for your
// approval" chip. The vault still says delivery='draft' while parked, so
// this is honest session-scoped presentation, not invented state.
const pendingSend = new Set();
let optimisticBody = null; // bubble shown while a write round-trips
let selectedRecipient = null; // {party_id, display_name} in the New form
let newMsgChannel = 'dm';
const SUBTITLE_DEFAULT = 'A projection of your vault — nothing stored here.';

// ---------- Read cursors (unread indicators) ----------
// Opening a thread stamps social.mark_thread_read with "now" — fire-and-
// forget, never blocking a render, never toasting: a read cursor is silent
// bookkeeping and the command is idempotent (re-marking with a newer
// instant is the normal case). `markedAt` remembers this session's marks so
// the inbox reads as caught-up even when a refresh outraces the write.
const markedAt = new Map(); // thread_id -> ISO instant of our newest mark

function markThreadRead(threadId) {
  const read_at = new Date().toISOString();
  markedAt.set(threadId, read_at);
  window.centraid.write({ action: 'mark-read', input: { thread_id: threadId, read_at } }).catch(
    () => {}, // silent by design — the next open re-marks anyway
  );
}

// The query's `unread` fact, overridden by any newer mark of our own.
function isUnread(t) {
  if (!t.unread) return false;
  const marked = markedAt.get(t.thread_id);
  return !marked || String(t.last_inbound_at ?? '').localeCompare(marked) > 0;
}

function fmtClock(iso) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

function dayLabel(iso) {
  const key = localDayKey(iso);
  if (key === localDayKey(new Date())) return 'Today';
  if (key === localDayKey(new Date(Date.now() - 86400000))) return 'Yesterday';
  const d = new Date(iso);
  const opts = { month: 'short', day: 'numeric' };
  if (!Number.isNaN(d.getTime()) && d.getFullYear() !== new Date().getFullYear()) {
    opts.year = 'numeric';
  }
  try {
    return d.toLocaleDateString(undefined, opts);
  } catch {
    return key;
  }
}

function threadTitle(t) {
  if (t.subject) return t.subject;
  if (t.others?.length) return t.others.join(', ');
  if (t.participants?.length) return t.participants.join(', ');
  return 'Untitled thread';
}

function hideNotice() {
  $('noticeBanner').hidden = true;
}

async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    toast(String(err?.message ?? err));
    return undefined;
  }
}

// One narration for every action outcome; returns true when it executed.
function narrate(outcome, onDenied) {
  if (outcome?.status === 'executed') return true;
  const message = outcomeMessage(outcome);
  if (message) toast(message);
  if (outcome?.status === 'denied' && onDenied) onDenied();
  return false;
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
        toast('Could not read that file.');
        continue;
      }
      const outcome = await act('attach', {
        subject_id: subjectId,
        data_uri: dataUri,
        title: file.name,
      });
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

// ---------- View switching ----------

function showInbox() {
  currentThread = null;
  optimisticBody = null;
  document.body.classList.remove('thread-open');
  $('messageView').hidden = true;
  $('inboxView').hidden = false;
  hideNotice();
  refresh();
}

async function openThread(t) {
  currentThread = t;
  optimisticBody = null;
  markThreadRead(t.thread_id); // fire-and-forget; rendering never waits
  $('composeInput').value = '';
  autosizeCompose();
  document.body.classList.add('thread-open');
  $('inboxView').hidden = true;
  $('messageView').hidden = false;
  $('threadDetails').hidden = true;
  $('threadTitleBtn').setAttribute('aria-expanded', 'false');
  $('threadTitle').textContent = threadTitle(t);
  $('threadSub').textContent = t.channel ?? '';
  $('emptyThread').hidden = true;
  showSkeleton($('messageList'), 4);
  hideNotice();
  await loadThread({ forceScroll: true });
  $('composeInput').focus();
}

async function refresh() {
  if (currentThread) {
    await loadThread();
  } else {
    await loadInbox();
  }
}

// ---------- Inbox ----------

async function loadInbox() {
  let data;
  try {
    data = await window.centraid.read({ query: 'inbox' });
  } catch {
    if (firstInboxLoad) $('threadList').innerHTML = '';
    readFailed($('noticeBanner'));
    return; // the focus refresh retries
  }
  firstInboxLoad = false;
  hideNotice();
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('subtitle').textContent = SUBTITLE_DEFAULT; // no stale "N unread"
    $('threadList').innerHTML = '';
    $('emptyInbox').hidden = true;
    return;
  }
  inboxThreads = data?.threads ?? [];
  inboxParties = data?.parties ?? [];
  renderInbox();
  renderRecipients();
}

function inboxMatches(t) {
  if (channelFilter && t.channel !== channelFilter) return false;
  const q = searchText.trim().toLowerCase();
  if (!q) return true;
  const hay = [threadTitle(t), ...(t.participants ?? []), t.snippet ?? ''].join(' ').toLowerCase();
  return hay.includes(q);
}

function renderInbox() {
  const list = $('threadList');
  list.innerHTML = '';
  // The header counts every unread thread, not just the filtered view.
  const unreadCount = inboxThreads.filter(isUnread).length;
  $('subtitle').textContent = unreadCount > 0 ? `${unreadCount} unread` : SUBTITLE_DEFAULT;
  const rows = inboxThreads.filter(inboxMatches);
  const empty = $('emptyInbox');
  empty.hidden = rows.length > 0;
  if (rows.length === 0) {
    empty.textContent =
      inboxThreads.length > 0
        ? 'No conversations match — clear the search or filter.'
        : 'No conversations yet. Start one with ＋ New message, or import history through the vault’s ingest.';
  }
  for (const t of rows) {
    const unread = isUnread(t);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'thread-row';
    if (unread) row.dataset.unread = 'true';
    row.appendChild(letterAvatar(t.others?.[0] ?? threadTitle(t)));
    const main = document.createElement('span');
    main.className = 'row-main';
    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = threadTitle(t);
    const snippet = document.createElement('span');
    snippet.className = 'row-snippet';
    if (t.has_draft) {
      const mark = document.createElement('span');
      mark.className = 'draft-mark';
      mark.textContent = 'Draft · ';
      snippet.appendChild(mark);
    }
    snippet.appendChild(document.createTextNode(t.snippet || ' '));
    main.append(text, snippet);
    const side = document.createElement('span');
    side.className = 'row-side';
    const time = document.createElement('span');
    time.className = 'row-when';
    time.textContent = relTime(t.last_message_at ?? t.created_at);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t.channel;
    side.append(time, badge);
    if (unread) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Unread');
      dot.title = 'Unread';
      side.appendChild(dot);
    }
    row.append(main, side);
    row.addEventListener('click', () => openThread(t));
    list.appendChild(row);
  }
}

// ---------- Thread ----------

async function loadThread({ forceScroll = false } = {}) {
  if (!currentThread) return;
  const list = $('messageList');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  let data;
  try {
    data = await window.centraid.read({
      query: 'thread',
      input: { thread_id: currentThread.thread_id },
    });
  } catch {
    readFailed($('noticeBanner'));
    return; // the focus refresh retries
  }
  hideNotice();
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    list.innerHTML = '';
    $('emptyThread').hidden = true;
    renderAttachments($('attachStrip'), [], removeAttachment);
    return;
  }
  optimisticBody = null; // the read is now the truth; reconcile
  const messages = data?.messages ?? [];
  renderMessages(messages);
  renderParticipants(messages);
  renderAttachments($('attachStrip'), data?.attachments ?? [], removeAttachment);
  if (forceScroll || nearBottom) scrollToNewest(list, forceScroll ? 'auto' : 'smooth');
  // New inbound while the thread is open and the reader is at the bottom:
  // they saw it, so re-mark. Own sends are `mine` and never count; scrolled
  // -up readers keep their cursor until they come back down (next refresh).
  const newestInbound = messages.reduce(
    (acc, m) =>
      !m.mine && String(m.sent_at ?? '').localeCompare(acc) > 0 ? String(m.sent_at) : acc,
    '',
  );
  const marked = markedAt.get(currentThread.thread_id) ?? '';
  if (newestInbound && newestInbound.localeCompare(marked) > 0 && (forceScroll || nearBottom)) {
    markThreadRead(currentThread.thread_id);
  }
}

// Opening jumps straight to the newest message; refreshes glide (unless the
// viewer prefers reduced motion).
function scrollToNewest(list, behavior) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  list.scrollTo({ top: list.scrollHeight, behavior: reduced ? 'auto' : behavior });
}

// Delivery, visualized on the bubble itself (mine only): a draft is dashed
// with its own Send; a parked send wears the ⏳ consent chip; sent/delivered/
// read are iMessage-style ticks; failed is a red chip — never silent.
function deliveryMeta(m) {
  const bits = [];
  if (m.delivery === 'draft') {
    if (pendingSend.has(m.message_id)) {
      const chip = document.createElement('span');
      chip.className = 'kit-pending-chip';
      chip.textContent = '⏳ Waiting for your approval';
      bits.push(chip);
    } else {
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'msg-send';
      send.textContent = 'Send';
      send.addEventListener('click', () => releaseDraft(m.message_id));
      bits.push(send);
    }
  } else if (m.delivery === 'failed') {
    const chip = document.createElement('span');
    chip.className = 'failed-chip';
    chip.textContent = 'Failed';
    bits.push(chip);
  } else if (m.delivery === 'sent' || m.delivery === 'delivered' || m.delivery === 'read') {
    const ticks = document.createElement('span');
    ticks.className = 'msg-ticks';
    ticks.textContent = m.delivery === 'sent' ? '✓' : '✓✓';
    if (m.delivery === 'read') ticks.dataset.read = 'true';
    ticks.setAttribute('aria-label', m.delivery);
    ticks.title = m.delivery;
    bits.push(ticks);
  }
  return bits;
}

function buildBubble(m) {
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.dataset.delivery = m.delivery;
  msg.dataset.mine = String(Boolean(m.mine));
  if (m.mine && m.delivery === 'draft' && pendingSend.has(m.message_id)) {
    msg.dataset.pending = 'true';
  }
  const bubble = document.createElement('p');
  bubble.className = 'msg-body';
  bubble.textContent = m.body;
  const meta = document.createElement('p');
  meta.className = 'msg-meta';
  const time = document.createElement('span');
  time.textContent = m.delivery === 'draft' ? 'Draft' : fmtClock(m.sent_at);
  meta.appendChild(time);
  if (m.mine) for (const bit of deliveryMeta(m)) meta.appendChild(bit);
  msg.append(bubble, meta);
  return msg;
}

function renderMessages(messages) {
  const list = $('messageList');
  list.innerHTML = '';
  $('emptyThread').hidden = messages.length > 0 || optimisticBody !== null;
  let prev = null;
  for (const m of messages) {
    // Day separators between runs — "Today", "Yesterday", "Mar 3".
    if (!prev || localDayKey(prev.sent_at) !== localDayKey(m.sent_at)) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      const label = document.createElement('span');
      label.textContent = dayLabel(m.sent_at);
      sep.appendChild(label);
      list.appendChild(sep);
    }
    // `mine` comes from the query comparing the sender against the vault's
    // owner party — alignment is a fact read from the vault, not a guess.
    const grouped = prev && prev.sender_party_id === m.sender_party_id;
    if (!grouped && !m.mine) {
      const who = document.createElement('p');
      who.className = 'msg-sender muted small';
      who.textContent = m.sender;
      list.appendChild(who);
    }
    list.appendChild(buildBubble(m));
    prev = m;
  }
  if (optimisticBody !== null) list.appendChild(buildOptimistic(optimisticBody));
}

// The optimistic bubble: appended the instant a write leaves, replaced by
// the vault's row on the next read.
function buildOptimistic(body) {
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.dataset.mine = 'true';
  msg.dataset.optimistic = 'true';
  const bubble = document.createElement('p');
  bubble.className = 'msg-body';
  bubble.textContent = body;
  const meta = document.createElement('p');
  meta.className = 'msg-meta';
  meta.textContent = 'Sending…';
  msg.append(bubble, meta);
  return msg;
}

function showOptimistic(body) {
  optimisticBody = body;
  const list = $('messageList');
  $('emptyThread').hidden = true;
  list.appendChild(buildOptimistic(body));
  list.scrollTop = list.scrollHeight;
}

function renderParticipants(messages) {
  const ul = $('participantList');
  ul.innerHTML = '';
  const names = new Set(currentThread?.participants ?? []);
  for (const m of messages) if (!m.mine) names.add(m.sender);
  for (const name of names) {
    const li = document.createElement('li');
    li.appendChild(letterAvatar(name, { size: '1.75rem' }));
    li.appendChild(document.createTextNode(name));
    ul.appendChild(li);
  }
  const count = names.size;
  $('threadSub').textContent = [currentThread?.channel, count ? `${count} in thread` : null]
    .filter(Boolean)
    .join(' · ');
}

// ---------- Sending (draft → send, consent-parked) ----------

async function releaseDraft(messageId) {
  const outcome = await act('send', { message_id: messageId });
  if (!outcome) return;
  if (outcome.status === 'parked') pendingSend.add(messageId);
  narrate(outcome, refresh);
  await loadThread();
}

// The compose primary: one Send that chains draft → send. `sendAfter=false`
// is the "Save draft" ghost — the message stays dashed with its own Send.
async function composeSubmit(sendAfter) {
  const input = $('composeInput');
  const body_text = input.value.trim();
  if (!body_text || !currentThread) return;
  input.value = '';
  autosizeCompose();
  showOptimistic(body_text);
  const draft = await act('draft', { body_text, thread_id: currentThread.thread_id });
  if (!draft || draft.status !== 'executed') {
    optimisticBody = null;
    input.value = body_text; // give the words back — never eat a message
    autosizeCompose();
    if (draft) narrate(draft, refresh);
    await loadThread();
    return;
  }
  const messageId = draft.output?.message_id ?? null;
  if (sendAfter && messageId) {
    const sent = await act('send', { message_id: messageId });
    if (sent?.status === 'parked') pendingSend.add(messageId);
    if (sent) narrate(sent, refresh);
  } else if (!sendAfter) {
    toast('Draft saved — it stays yours until you send it.');
  }
  await loadThread({ forceScroll: true });
  input.focus();
}

$('composeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  composeSubmit(true);
});

$('draftBtn').addEventListener('click', () => composeSubmit(false));

function autosizeCompose() {
  const input = $('composeInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

$('composeInput').addEventListener('input', autosizeCompose);

$('composeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    composeSubmit(true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('newMsgForm').hidden && $('messageView').hidden) {
    closeNewMsgForm();
  } else if (!$('messageView').hidden) {
    showInbox();
  }
});

// ---------- Thread header ----------

$('backBtn').addEventListener('click', showInbox);

$('threadTitleBtn').addEventListener('click', () => {
  const details = $('threadDetails');
  details.hidden = !details.hidden;
  $('threadTitleBtn').setAttribute('aria-expanded', String(!details.hidden));
});

wireAttachInput($('attachInput'), () => currentThread?.thread_id);

// ---------- Inbox search + channel filter ----------

$('searchInput').addEventListener(
  'input',
  debounce(() => {
    searchText = $('searchInput').value;
    renderInbox();
  }, 150),
);

for (const chip of $('channelFilter').querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    channelFilter = chip.dataset.filter ?? '';
    for (const c of $('channelFilter').querySelectorAll('.chip')) {
      const selected = c === chip;
      c.classList.toggle('selected', selected);
      c.setAttribute('aria-pressed', String(selected));
    }
    renderInbox();
  });
}

// ---------- New conversation ----------
// The write path always supported this (draft accepts recipient_party_id /
// channel / subject); the picker searches the party directory the inbox
// query already reads.

function closeNewMsgForm() {
  $('newMsgForm').hidden = true;
  $('newMsgForm').reset();
  $('recipientList').innerHTML = '';
  selectedRecipient = null;
  setNewMsgChannel('dm');
  updateStartEnabled();
}

$('newMsgBtn').addEventListener('click', () => {
  const form = $('newMsgForm');
  if (form.hidden) {
    form.hidden = false;
    renderRecipients();
    $('recipientSearch').focus();
  } else {
    closeNewMsgForm();
  }
});

$('cancelNewMsg').addEventListener('click', closeNewMsgForm);

function setNewMsgChannel(channel) {
  newMsgChannel = channel;
  for (const c of $('channelSelect').querySelectorAll('.chip')) {
    const selected = c.dataset.channel === channel;
    c.classList.toggle('selected', selected);
    c.setAttribute('aria-pressed', String(selected));
  }
  $('subjectInput').hidden = channel !== 'email';
}

for (const chip of $('channelSelect').querySelectorAll('.chip')) {
  chip.addEventListener('click', () => setNewMsgChannel(chip.dataset.channel));
}

function updateStartEnabled() {
  $('startThreadBtn').disabled = !selectedRecipient || !$('newMsgBody').value.trim();
}

function renderRecipients() {
  const listEl = $('recipientList');
  if ($('newMsgForm').hidden) return;
  listEl.innerHTML = '';
  const q = $('recipientSearch').value.trim().toLowerCase();
  if (selectedRecipient && $('recipientSearch').value === selectedRecipient.display_name) {
    $('recipientSearch').setAttribute('aria-expanded', 'false');
    return; // picked — keep the list closed
  }
  const matches = inboxParties
    .filter(
      (p) =>
        !q ||
        String(p.display_name ?? '')
          .toLowerCase()
          .includes(q),
    )
    .slice(0, 8);
  $('recipientSearch').setAttribute('aria-expanded', String(matches.length > 0));
  for (const p of matches) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'recipient-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selectedRecipient?.party_id === p.party_id));
    row.appendChild(letterAvatar(p.display_name, { size: '1.75rem' }));
    row.appendChild(document.createTextNode(p.display_name ?? 'Unknown'));
    row.addEventListener('click', () => {
      selectedRecipient = p;
      $('recipientSearch').value = p.display_name ?? '';
      renderRecipients();
      updateStartEnabled();
      $('newMsgBody').focus();
    });
    listEl.appendChild(row);
  }
}

$('recipientSearch').addEventListener(
  'input',
  debounce(() => {
    if (selectedRecipient && $('recipientSearch').value !== selectedRecipient.display_name) {
      selectedRecipient = null;
    }
    renderRecipients();
    updateStartEnabled();
  }, 120),
);

$('newMsgBody').addEventListener('input', updateStartEnabled);

$('newMsgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body_text = $('newMsgBody').value.trim();
  if (!selectedRecipient || !body_text) return;
  // Capture before closeNewMsgForm resets the form state.
  const channel = newMsgChannel;
  const subject = channel === 'email' ? $('subjectInput').value.trim() : '';
  const recipientName = selectedRecipient.display_name ?? 'Unknown';
  const outcome = await act('draft', {
    body_text,
    recipient_party_id: selectedRecipient.party_id,
    channel,
    ...(subject ? { subject } : {}),
  });
  if (!outcome) return;
  if (outcome.status !== 'executed') {
    narrate(outcome, refresh);
    return;
  }
  const threadId = outcome.output?.thread_id ?? null;
  closeNewMsgForm();
  if (!threadId) {
    await refresh();
    return;
  }
  await openThread({
    thread_id: threadId,
    channel,
    subject: subject || null,
    participants: [recipientName],
    others: [recipientName],
  });
});

// ---------- Boot ----------

showSkeleton($('threadList'), 6);
window.addEventListener('focus', refresh);
refresh();
