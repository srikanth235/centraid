// Leads — a lightweight CRM as a projection over the personal vault. A lead
// is a business.client whose lead → active → past lifecycle is the pipeline;
// names come from core.party, running notes from social.contact_card. Every
// write is a typed vault command (add_client, update_client, update_card),
// all risk low. Files attach per lead. The app stores nothing — revoke the
// grant and this page goes dark while the model, history and receipts remain
// the owner's.

const $ = (id) => document.getElementById(id);

const COLUMNS = [
  { key: 'lead', title: 'Leads' },
  { key: 'active', title: 'Active' },
  { key: 'past', title: 'Past' },
];

let data = { leads: [], candidates: [] };
let attachTarget = null; // client_id the shared file input attaches to

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

function narrate(outcome) {
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
      link.textContent = (a.title ?? a.media_type ?? 'file').slice(0, 18);
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
      const outcome = await act('attach', {
        subject_id: subjectId,
        data_uri: dataUri,
        title: file.name,
      });
      if (!narrate(outcome)) break;
    }
    inputEl.value = '';
    await refresh();
  });
}

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome)) await refresh();
}

wireAttachInput($('attachInput'), () => attachTarget);

// ---------- Formatting ----------

function fmtRate(minor, currency) {
  if (minor == null) return 'No rate set';
  const value = minor / 100;
  try {
    return `${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)}/h`;
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}/h`;
  }
}

// ---------- Render ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'pipeline' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  renderAddForm();
  renderBoard();
}

function renderAddForm() {
  const select = $('candidateSelect');
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = data.candidates.length ? 'Pick a person…' : 'No unenrolled people';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  for (const c of data.candidates) {
    const el = document.createElement('option');
    el.value = c.party_id;
    el.textContent = c.display_name;
    select.appendChild(el);
  }
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  $('empty').hidden = data.leads.length > 0;
  for (const col of COLUMNS) {
    const inColumn = data.leads.filter((l) => l.status === col.key);
    board.appendChild(renderColumn(col, inColumn));
  }
}

function renderColumn(col, cards) {
  const column = document.createElement('div');
  column.className = 'column';
  column.dataset.status = col.key;
  const head = document.createElement('div');
  head.className = 'column-head';
  const title = document.createElement('span');
  title.className = 'column-title';
  title.textContent = col.title;
  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = String(cards.length);
  head.append(title, count);
  column.appendChild(head);
  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'column-empty';
    empty.textContent = '—';
    column.appendChild(empty);
  }
  for (const lead of cards) column.appendChild(renderCard(lead));
  return column;
}

// Which pipeline moves a card offers, by current status.
const MOVES = {
  lead: [
    { status: 'active', label: 'Won' },
    { status: 'past', label: 'Lost' },
  ],
  active: [
    { status: 'past', label: 'Close' },
    { status: 'lead', label: '↩ Lead' },
  ],
  past: [{ status: 'lead', label: 'Reopen' }],
};

function renderCard(lead) {
  const card = document.createElement('div');
  card.className = 'card';

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = lead.name;
  const rate = document.createElement('span');
  rate.className = 'card-rate';
  rate.textContent = fmtRate(lead.default_rate_minor, lead.currency);
  card.append(name, rate);

  const note = document.createElement('p');
  note.className = lead.note ? 'card-note' : 'card-note empty-note';
  note.textContent = lead.note || 'No notes yet — click Note to add one.';
  card.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  for (const move of MOVES[lead.status] ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = move.label;
    btn.addEventListener('click', async () => {
      const outcome = await act('update-client', {
        client_id: lead.client_id,
        status: move.status,
      });
      if (narrate(outcome)) await refresh();
    });
    actions.appendChild(btn);
  }
  const noteBtn = document.createElement('button');
  noteBtn.type = 'button';
  noteBtn.className = 'ghost';
  noteBtn.textContent = 'Note';
  noteBtn.addEventListener('click', () => openNoteEditor(card, lead));
  actions.appendChild(noteBtn);

  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost';
  attach.textContent = '＋ File';
  attach.addEventListener('click', () => {
    attachTarget = lead.client_id;
    $('attachInput').click();
  });
  actions.appendChild(attach);
  card.appendChild(actions);

  const strip = document.createElement('div');
  strip.className = 'attach-strip';
  renderAttachments(strip, lead.attachments, removeAttachment);
  card.appendChild(strip);
  return card;
}

// Inline note editor — replaces the card's actions with a textarea + save.
function openNoteEditor(card, lead) {
  if (card.querySelector('.note-editor')) return;
  const editor = document.createElement('div');
  editor.className = 'note-editor';
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = lead.note ?? '';
  ta.setAttribute('aria-label', 'Note');
  const row = document.createElement('div');
  row.className = 'card-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'ghost';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    const outcome = await act('save-note', { party_id: lead.party_id, note: ta.value.trim() });
    if (narrate(outcome)) await refresh();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => editor.remove());
  row.append(save, cancel);
  editor.append(ta, row);
  card.appendChild(editor);
  ta.focus();
}

// ---------- Add lead ----------

// Two ways in: enrol someone the vault already knows, or mint a brand-new
// contact through core.add_party and enrol them in one stroke.
let addMode = 'existing'; // 'existing' | 'contact'

function applyAddMode() {
  const contact = addMode === 'contact';
  $('candidateSelect').hidden = contact;
  $('nameInput').hidden = !contact;
  $('contactRow').hidden = !contact;
  $('modeHint').textContent = contact
    ? 'A new person lands in your vault and the pipeline together.'
    : 'Leads are people from your vault.';
  $('modeToggle').textContent = contact ? 'Pick an existing person instead' : 'New contact instead';
}

$('modeToggle').addEventListener('click', () => {
  addMode = addMode === 'contact' ? 'existing' : 'contact';
  applyAddMode();
  (addMode === 'contact' ? $('nameInput') : $('candidateSelect')).focus();
});

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currency = $('currencyInput').value.trim().toUpperCase();
  if (addMode === 'contact') {
    const display_name = $('nameInput').value.trim();
    if (!display_name || currency.length !== 3) {
      notice('Name the new contact and give a 3-letter currency.');
      return;
    }
    const email = $('emailInput').value.trim();
    const tel = $('telInput').value.trim();
    const outcome = await act('add-contact', {
      display_name,
      ...(email ? { email } : {}),
      ...(tel ? { tel } : {}),
      currency,
    });
    if (narrate(outcome)) {
      $('nameInput').value = '';
      $('emailInput').value = '';
      $('telInput').value = '';
      await refresh();
    }
    return;
  }
  const party_id = $('candidateSelect').value;
  if (!party_id || currency.length !== 3) {
    notice('Pick a person and a 3-letter currency.');
    return;
  }
  const outcome = await act('add-lead', { party_id, currency });
  if (narrate(outcome)) await refresh();
});

applyAddMode();

window.addEventListener('focus', refresh);
refresh();
