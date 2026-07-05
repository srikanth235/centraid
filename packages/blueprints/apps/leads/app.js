// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Leads is a finished CRM pipeline — drag-and-drop stages with undo, inline rate edits, search, lost reasons, attachment roles — and splitting it would break that "one file" contract.
// Leads — a lightweight CRM as a projection over the personal vault. A lead
// is a business.client whose lead → active → past lifecycle is the pipeline;
// names come from core.party, running notes from social.contact_card. Every
// write is a typed vault command (add_client, update_client, update_card),
// all risk low. Files attach per lead. The app stores nothing — revoke the
// grant and this page goes dark while the model, history and receipts remain
// the owner's.

import {
  armConfirm,
  attachMentionField,
  debounce,
  fmtMoney,
  inlineLinkIds,
  letterAvatar,
  readFailed,
  removeReference,
  renderReferenceStrip,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

const COLUMNS = [
  { key: 'lead', title: 'Leads' },
  { key: 'active', title: 'Active' },
  { key: 'past', title: 'Past' },
];

// The last currency used sticks across visits — a UI preference, not data.
const CURRENCY_KEY = 'leads.currency';

let data = { leads: [], candidates: [] };
let loaded = false; // first successful read landed
// The browse window: the pipeline query reads only this many recent clients
// (UUIDv7 order — newest first). "Show more" grows it; search reaches the rest.
let pipelineWindow = 500;
let pipelineTruncated = false;
let filterText = ''; // lowercased search needle
let searchResults = null; // vault FTS matches while a term is active
let candidateResults = null; // vault FTS parties while a picker term is active
let attachTarget = null; // client_id the shared file input attaches to
let attachRole = null; // role chosen in the per-card picker (null = auto)
let draggedLead = null; // the lead being dragged between columns

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function notice(text) {
  const el = $('noticeBanner');
  delete el.dataset.readFailure;
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

// What a file can be to a lead. The vault's core.attach enum has no
// "proposal", so the picker offers its closest CRM-shaped subset; "Auto"
// omits the role and lets the command infer photo/other from the media type.
const ROLE_OPTIONS = [
  { value: 'contract', label: 'Contract' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'other', label: 'Other' },
  { value: null, label: 'Auto' },
];

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
    tile.title = [a.title, a.role].filter(Boolean).join(' — ');
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
    meta.textContent = [a.role, fmtBytes(a.byte_size)].filter(Boolean).join(' · ');
    tile.appendChild(meta);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.setAttribute('aria-label', 'Remove attachment');
    rm.addEventListener('click', () => {
      if (!armConfirm(rm, { armedLabel: 'Sure?' })) return;
      onRemove(a.attachment_id);
    });
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
        ...(attachRole ? { role: attachRole } : {}),
      });
      if (!narrate(outcome)) break;
    }
    inputEl.value = '';
    attachRole = null;
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
  if (minor == null) return 'Set rate';
  return `${fmtMoney(minor, currency)}/h`;
}

/** "12.50" → 1250 minor units; null when blank; undefined when invalid. */
function parseRateMinor(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100);
}

// ---------- Pipeline moves (buttons and drag share one path) ----------

async function moveLead(lead, toStatus) {
  const fromStatus = lead.status;
  const card = document.querySelector(`.card[data-client-id="${CSS.escape(lead.client_id)}"]`);
  card?.classList.add('kit-pending');
  const outcome = await act('update-client', { client_id: lead.client_id, status: toStatus });
  card?.classList.remove('kit-pending');
  if (!narrate(outcome)) return false;
  await refresh();
  const title = COLUMNS.find((c) => c.key === toStatus)?.title ?? toStatus;
  toast(`Moved to ${title}`, {
    undoLabel: 'Undo',
    onUndo: async () => {
      const back = await act('update-client', { client_id: lead.client_id, status: fromStatus });
      if (narrate(back)) await refresh();
    },
  });
  return true;
}

// ---------- Render ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'pipeline', input: { limit: pipelineWindow } });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    $('noticeBanner').dataset.readFailure = 'true';
    return;
  }
  if ($('noticeBanner').dataset.readFailure === 'true') notice('');
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  pipelineTruncated = Boolean(next?.truncated);
  loaded = true;
  renderAddForm();
  renderBoard();
}

function renderAddForm() {
  const select = $('candidateSelect');
  const previous = select.value;
  select.innerHTML = '';
  // Zero-term the picker offers the pipeline's shortlist; with a term it
  // shows the vault's ranked matches instead (see the filter wiring below).
  const list = candidateResults ?? data.candidates;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = list.length
    ? 'Pick a person…'
    : candidateResults
      ? 'No one matches'
      : 'No unenrolled people';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  for (const c of list) {
    const el = document.createElement('option');
    el.value = c.party_id;
    el.textContent = c.display_name;
    select.appendChild(el);
  }
  // A pick survives a re-render (a refresh, a late reply) while still listed.
  if (previous && list.some((c) => c.party_id === previous)) select.value = previous;
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  $('empty').hidden = data.leads.length > 0;
  // While a term is active the board IS the vault's ranked matches; stage
  // grouping still happens here so the kanban keeps its columns.
  const matched = filterText ? (searchResults ?? []) : data.leads;
  for (const col of COLUMNS) {
    const inColumn = data.leads.filter((l) => l.status === col.key);
    const shown = filterText ? matched.filter((l) => l.status === col.key) : inColumn;
    board.appendChild(renderColumn(col, inColumn, shown));
  }
  // The window is honest about its edge: the columns group the loaded slice
  // (their counts count loaded cards), "Show more" grows it, and search
  // reaches everything beyond it — so no footer while a term is active.
  if (pipelineTruncated && !filterText) {
    const footer = document.createElement('div');
    footer.className = 'window-footer';
    const label = document.createElement('span');
    label.textContent = `Showing your latest ${pipelineWindow} leads — older ones are a search away. `;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost';
    more.textContent = 'Show more';
    more.addEventListener('click', async () => {
      pipelineWindow += 500;
      more.disabled = true;
      await refresh();
    });
    footer.append(label, more);
    board.appendChild(footer);
  }
}

/**
 * "€400/h avg" over the column's rated cards — a clearly-labeled hourly
 * proxy, since clients carry a default rate but deals carry no value yet.
 */
function columnSummary(cards) {
  const rated = cards.filter((c) => c.default_rate_minor != null);
  if (rated.length === 0) return '';
  const currencies = new Set(rated.map((c) => c.currency));
  if (currencies.size > 1) return 'mixed rates';
  const avg = Math.round(rated.reduce((sum, c) => sum + c.default_rate_minor, 0) / rated.length);
  return `${fmtMoney(avg, rated[0].currency)}/h avg`;
}

function renderColumn(col, cards, shown) {
  const column = document.createElement('div');
  column.className = 'column';
  column.dataset.status = col.key;

  const head = document.createElement('div');
  head.className = 'column-head';
  const title = document.createElement('span');
  title.className = 'column-title';
  title.textContent = col.title;
  const meta = document.createElement('span');
  meta.className = 'column-count';
  const countText =
    filterText && shown.length !== cards.length
      ? `${shown.length}/${cards.length}`
      : String(cards.length);
  const summary = columnSummary(cards);
  meta.textContent = summary ? `${countText} · ${summary}` : countText;
  if (summary) {
    meta.title = 'Average default hourly rate of rated leads — an hourly proxy, not a deal value.';
  }
  head.append(title, meta);
  column.appendChild(head);

  // The whole column is a drop target for cards from other stages.
  column.addEventListener('dragover', (e) => {
    if (!draggedLead || draggedLead.status === col.key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    column.classList.add('drop-target');
  });
  column.addEventListener('dragleave', (e) => {
    if (!column.contains(e.relatedTarget)) column.classList.remove('drop-target');
  });
  column.addEventListener('drop', (e) => {
    e.preventDefault();
    column.classList.remove('drop-target');
    if (draggedLead && draggedLead.status !== col.key) moveLead(draggedLead, col.key);
  });

  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'column-empty';
    empty.textContent = 'Drop a card here';
    column.appendChild(empty);
  } else if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'column-empty';
    empty.textContent = 'No matches';
    column.appendChild(empty);
  }
  for (const lead of shown) column.appendChild(renderCard(lead));

  // Only the Leads column can add — add-lead always enrols at status 'lead'.
  if (col.key === 'lead') {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ghost add-ghost';
    add.textContent = '＋ Add lead';
    add.addEventListener('click', () => {
      $('addForm').scrollIntoView({
        behavior: reducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
      });
      (addMode === 'contact' ? $('nameInput') : $('candidateFilter')).focus();
    });
    column.appendChild(add);
  }
  return column;
}

// Which pipeline moves a card offers, by current status. These ghost buttons
// stay as the accessible/mobile fallback for drag-and-drop; "Lost" first
// asks for a reason in the note editor.
const MOVES = {
  lead: [
    { status: 'active', label: 'Won' },
    { status: 'past', label: 'Lost', reason: true },
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
  card.dataset.clientId = lead.client_id;
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    // Never hijack a drag that starts inside a control or an editor.
    if (e.target.closest?.('input,textarea,select,button,a')) {
      e.preventDefault();
      return;
    }
    draggedLead = lead;
    e.dataTransfer.setData('text/plain', lead.client_id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    draggedLead = null;
    card.classList.remove('dragging');
    for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  });

  const top = document.createElement('div');
  top.className = 'card-top';
  top.appendChild(letterAvatar(lead.name, { size: '2rem' }));
  const idBox = document.createElement('div');
  idBox.className = 'card-id';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = lead.name;
  const rate = document.createElement('button');
  rate.type = 'button';
  rate.className = 'card-rate';
  rate.textContent = fmtRate(lead.default_rate_minor, lead.currency);
  rate.title = 'Edit hourly rate';
  rate.addEventListener('click', () => openRateEditor(lead, rate));
  idBox.append(name, rate);
  top.appendChild(idBox);
  card.appendChild(top);

  // The reach-them line: primary email/phone straight off the party's
  // identifiers, each a real mailto:/tel: link.
  if (lead.email || lead.tel) {
    const contact = document.createElement('p');
    contact.className = 'card-contact';
    if (lead.email) {
      const a = document.createElement('a');
      a.href = `mailto:${lead.email}`;
      a.textContent = lead.email;
      contact.appendChild(a);
    }
    if (lead.email && lead.tel) contact.appendChild(document.createTextNode(' · '));
    if (lead.tel) {
      const a = document.createElement('a');
      a.href = `tel:${lead.tel}`;
      a.textContent = lead.tel;
      contact.appendChild(a);
    }
    card.appendChild(contact);
  }

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
    btn.addEventListener('click', () => {
      if (move.reason) {
        openNoteEditor(card, lead, { lostTo: move.status });
        return;
      }
      moveLead(lead, move.status);
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
  attach.addEventListener('click', () => openRoleMenu(card, lead));
  actions.appendChild(attach);
  card.appendChild(actions);

  const strip = document.createElement('div');
  strip.className = 'attach-strip';
  renderAttachments(strip, lead.attachments, removeAttachment);
  card.appendChild(strip);
  return card;
}

// Tiny role picker before the file dialog — what is this file to the lead?
function openRoleMenu(card, lead) {
  const existing = card.querySelector('.role-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'card-actions role-menu';
  const hint = document.createElement('span');
  hint.className = 'role-hint';
  hint.textContent = 'Attach as';
  menu.appendChild(hint);
  for (const opt of ROLE_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      attachTarget = lead.client_id;
      attachRole = opt.value;
      menu.remove();
      $('attachInput').click();
    });
    menu.appendChild(btn);
  }
  card.appendChild(menu);
  menu.querySelector('button')?.focus();
}

// Inline rate editor — the rate line becomes an input; Enter saves through
// update-client, Escape or blur cancels.
function openRateEditor(lead, rateBtn) {
  const wrap = document.createElement('span');
  wrap.className = 'rate-edit';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.inputMode = 'decimal';
  input.value = lead.default_rate_minor != null ? String(lead.default_rate_minor / 100) : '';
  input.setAttribute('aria-label', `Hourly rate in ${lead.currency}`);
  const unit = document.createElement('span');
  unit.className = 'rate-unit';
  unit.textContent = `${lead.currency}/h`;
  wrap.append(input, unit);
  let saving = false;
  const restore = () => wrap.replaceWith(rateBtn);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      restore();
      rateBtn.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const minor = parseRateMinor(input.value);
    if (minor === undefined) {
      notice('Rate must be a non-negative number.');
      return;
    }
    if (minor === null || minor === lead.default_rate_minor) {
      restore();
      return;
    }
    saving = true;
    input.disabled = true;
    const outcome = await act('update-client', {
      client_id: lead.client_id,
      default_rate_minor: minor,
    });
    if (narrate(outcome)) {
      toast('Rate updated');
      await refresh();
    } else {
      restore();
    }
  });
  input.addEventListener('blur', () => {
    if (!saving) restore();
  });
  rateBtn.replaceWith(wrap);
  input.focus();
  input.select();
}

// Inline note editor — replaces the card's actions with a textarea + save.
// With `lostTo` set this is the lost-reason flow: the running note gets a
// "Lost because " prompt appended and saving also moves the card.
function openNoteEditor(card, lead, { lostTo } = {}) {
  if (card.querySelector('.note-editor')) return;
  const editor = document.createElement('div');
  editor.className = 'note-editor';
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = lostTo ? `${lead.note ? `${lead.note}\n` : ''}Lost because ` : (lead.note ?? '');
  ta.setAttribute('aria-label', lostTo ? 'Why was this lead lost?' : 'Note');

  // @-mentions on the running note (issues #272 + #282): the kit field owns
  // the popover, the pick→insert→assert, and (on save) the reconcile. Anchors
  // ride core.party; the strip is where a reference shows (a note has no
  // read-view render). reconcile only touches anchored links, so any
  // employment (works-for) links on the party are left untouched.
  const refsOf = () => (lead.references ||= []);
  const strip = document.createElement('div');
  strip.className = 'kit-ref-strip lead-refs';
  const renderStrip = () =>
    renderReferenceStrip(strip, refsOf(), {
      inlineIds: inlineLinkIds(ta.value, refsOf()),
      onRemove: async (ref) => {
        const outcome = await removeReference(ref.link_id);
        if (outcome?.status === 'executed') {
          lead.references = refsOf().filter((r) => r.link_id !== ref.link_id);
        }
        renderStrip();
      },
    });
  const field = attachMentionField(ta, {
    from: () => ({ type: 'core.party', id: lead.party_id }),
    references: refsOf,
    onChange: renderStrip,
  });

  const row = document.createElement('div');
  row.className = 'card-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'ghost';
  save.textContent = lostTo ? 'Save & mark lost' : 'Save';
  save.addEventListener('click', async () => {
    const note = ta.value.trim();
    const subject = { type: 'core.party', id: lead.party_id };
    const references = refsOf();
    const outcome = await act('save-note', { party_id: lead.party_id, note });
    if (!narrate(outcome)) return;
    // The saved note is the settled text — reconcile the anchors against it
    // (re-baseline live selectors, retract orphaned mentions with Undo).
    await field.reconcile(note, { from: subject, references });
    field.detach();
    if (lostTo) {
      await moveLead(lead, lostTo);
      return;
    }
    await refresh();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    field.detach();
    editor.remove();
  });
  const mention = document.createElement('button');
  mention.type = 'button';
  mention.className = 'ghost';
  mention.textContent = '＋ Mention';
  mention.addEventListener('click', () => field.startMention());
  row.append(save, cancel, mention);
  editor.append(ta, strip, row);
  card.appendChild(editor);
  renderStrip();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ---------- Search ----------

// Searching asks the vault, not a local copy: the FTS5 index matches names,
// org lines and running notes inside SQLite and returns only the hits, so
// the board never greps every contact in memory. `searchSeq` drops stale
// replies when the owner types faster than the vault answers.
let searchSeq = 0;
$('searchInput').addEventListener(
  'input',
  debounce(async () => {
    const raw = $('searchInput').value.trim();
    filterText = raw.toLowerCase();
    if (!raw) {
      searchResults = null;
      if (loaded) renderBoard();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    try {
      const res = await window.centraid.read({ query: 'search', input: { term: raw } });
      rows = res?.leads ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    searchResults = rows;
    if (loaded) renderBoard();
  }, 150),
);

// ---------- Add lead ----------

// Two ways in: enrol someone the vault already knows, or mint a brand-new
// contact through core.add_party and enrol them in one stroke.
let addMode = 'existing'; // 'existing' | 'contact'

// The picker's shipped shortlist stops at the newest 300 parties — a
// convenience, not a directory. Typing here asks the vault's FTS5 index
// over core.party instead (find-candidates), so anyone ever recorded is
// enrollable without growing that cap. `candidateSeq` drops stale replies,
// same as the board search above; an empty term restores the shortlist.
let candidateSeq = 0;
$('candidateFilter').addEventListener(
  'input',
  debounce(async () => {
    const raw = $('candidateFilter').value.trim();
    if (!raw) {
      candidateResults = null;
      renderAddForm();
      return;
    }
    const seq = ++candidateSeq;
    let rows = [];
    try {
      const res = await window.centraid.read({ query: 'find-candidates', input: { term: raw } });
      rows = res?.candidates ?? [];
    } catch {
      rows = [];
    }
    if (seq !== candidateSeq) return;
    candidateResults = rows;
    renderAddForm();
  }, 250),
);

function applyAddMode() {
  const contact = addMode === 'contact';
  $('candidateFilter').hidden = contact;
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
  (addMode === 'contact' ? $('nameInput') : $('candidateFilter')).focus();
});

function initCurrency() {
  const select = $('currencyInput');
  let saved = null;
  try {
    saved = localStorage.getItem(CURRENCY_KEY);
  } catch {
    /* storage unavailable — default stands */
  }
  if (!saved || !/^[A-Z]{3}$/.test(saved)) return;
  if (![...select.options].some((o) => o.value === saved)) {
    const opt = document.createElement('option');
    opt.value = saved;
    opt.textContent = saved;
    select.appendChild(opt);
  }
  select.value = saved;
}

function rememberCurrency(code) {
  try {
    localStorage.setItem(CURRENCY_KEY, code);
  } catch {
    /* storage unavailable — nothing to remember into */
  }
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currency = $('currencyInput').value;
  const rateMinor = parseRateMinor($('rateInput').value);
  if (rateMinor === undefined) {
    notice('Rate must be a non-negative number.');
    return;
  }
  const rateField = rateMinor != null ? { default_rate_minor: rateMinor } : {};
  if (addMode === 'contact') {
    const display_name = $('nameInput').value.trim();
    if (!display_name || currency.length !== 3) {
      notice('Name the new contact and pick a currency.');
      return;
    }
    const email = $('emailInput').value.trim();
    const tel = $('telInput').value.trim();
    const outcome = await act('add-contact', {
      display_name,
      ...(email ? { email } : {}),
      ...(tel ? { tel } : {}),
      currency,
      ...rateField,
    });
    if (narrate(outcome)) {
      $('nameInput').value = '';
      $('emailInput').value = '';
      $('telInput').value = '';
      $('rateInput').value = '';
      rememberCurrency(currency);
      await refresh();
    }
    return;
  }
  const party_id = $('candidateSelect').value;
  if (!party_id || currency.length !== 3) {
    notice('Pick a person and a currency.');
    return;
  }
  const outcome = await act('add-lead', { party_id, currency, ...rateField });
  if (narrate(outcome)) {
    $('rateInput').value = '';
    // The matches now offer someone just enrolled — back to the shortlist.
    $('candidateFilter').value = '';
    candidateResults = null;
    rememberCurrency(currency);
    await refresh();
  }
});

applyAddMode();
initCurrency();
showSkeleton($('board'), 6);

window.addEventListener('focus', refresh);
refresh();
