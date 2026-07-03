// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Notes is a finished product — search-as-you-type, edit-in-place autosave, markdown + checklists, pinning — and splitting it would break that "one file" contract.
// Notes — a projection over the personal vault. Every row rendered here
// lives in knowledge.note; bodies are canonical core.content_item rows
// decoded gateway-side by the library query. Writes go through the
// knowledge domain's typed commands (create_note, edit_note, move_note,
// create_notebook, rename_notebook, delete_notebook, delete_note) routed
// via this app's action handlers —
// consent-checked per command and receipted. Revoke the grant and this
// page goes dark while the model, history and receipts remain the owner's.

import { armConfirm, readFailed, relTime, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);

let notes = [];
let notebooks = [];
let activeNotebook = 'all';
let renamingNotebookId = null; // chip currently swapped for its rename input
let searchTerm = '';
let searchResults = null; // vault FTS matches while a term is active
let firstLoad = true;
let readErrorShown = false;

// The open note. `draft` is the local truth while the user types; it only
// syncs from the vault when the editor is idle, so a change-feed refresh
// never clobbers text mid-keystroke.
let viewingId = null;
let draft = null; // { title, body }
let lastSaved = null; // { title, body } as last acknowledged by the vault
let dirty = false;
let editingBody = false;
let saveTimer = 0;
let savePromise = null;
let saveStateTimer = 0;

const PIN_SVG =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.9 5.9 0 0 1 5 6.708V2.277a2.8 2.8 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/></svg>';

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// One narration for every action outcome; returns true when it executed.
// `friendly` maps a refused predicate name to a human sentence, so the
// banner can explain the vault's contract instead of quoting it.
function narrate(outcome, onDenied, friendly) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it lands once approved.');
  } else if (outcome?.status === 'failed') {
    const predicate = String(outcome.predicate ?? '');
    const known = friendly ? Object.keys(friendly).find((k) => predicate.includes(k)) : undefined;
    notice(
      known
        ? friendly[known]
        : `The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`,
    );
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

function currentNote() {
  return notes.find((n) => n.note_id === viewingId) ?? null;
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

// Render an attachment strip: images as thumbnails that open the lightbox,
// everything else as a download tile, each with a remove control wired to
// the detach action.
function renderAttachments(stripEl, list, onRemove) {
  stripEl.innerHTML = '';
  for (const a of list ?? []) {
    const tile = document.createElement('div');
    tile.className = 'attach-tile';
    if (String(a.media_type).startsWith('image/')) {
      const img = document.createElement('img');
      img.src = a.content_uri;
      img.alt = a.title ?? 'attachment';
      img.className = 'attach-zoom';
      img.addEventListener('click', () => openLightbox(a.content_uri, a.title ?? ''));
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

// ---------- Lightbox ----------

function openLightbox(src, alt) {
  $('lightboxImg').src = src;
  $('lightboxImg').alt = alt;
  $('lightbox').hidden = false;
}

function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightboxImg').src = '';
}

$('lightbox').addEventListener('click', closeLightbox);

// ---------- Safe markdown rendering (DOM nodes only, never innerHTML) ----------

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\s][^*\n]*?\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;

// Inline spans: `code`, **bold**, *italic*, [text](https://…). Everything is
// appended as text nodes or elements with textContent — no HTML parsing of
// note content, so nothing a note says can become markup.
function appendInline(el, text) {
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = m[1].slice(1, -1);
      el.appendChild(code);
    } else if (m[2]) {
      const strong = document.createElement('strong');
      strong.textContent = m[2].slice(2, -2);
      el.appendChild(strong);
    } else if (m[3]) {
      const em = document.createElement('em');
      em.textContent = m[3].slice(1, -1);
      el.appendChild(em);
    } else if (m[4]) {
      const a = document.createElement('a');
      a.href = m[6];
      a.textContent = m[5];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

const CHECK_RE = /^\s*[-*] \[( |x|X)\] ?(.*)$/;

// One `- [ ]` / `- [x]` source line as a live checkbox row. Works in every
// format: a checklist is a checklist even in a plain-text note.
function checkLine(match, lineIndex, markdown) {
  const row = document.createElement('div');
  row.className = `check-line${/x/i.test(match[1]) ? ' done' : ''}`;
  row.dataset.line = String(lineIndex);
  const box = document.createElement('label');
  box.className = 'check-box';
  box.addEventListener('click', (e) => e.stopPropagation());
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = /x/i.test(match[1]);
  input.setAttribute('aria-label', match[2] || 'Checklist item');
  input.addEventListener('change', () => toggleCheckLine(lineIndex, input.checked));
  box.appendChild(input);
  const text = document.createElement('span');
  text.className = 'check-text';
  if (markdown) appendInline(text, match[2]);
  else text.textContent = match[2];
  row.append(box, text);
  return row;
}

// Line-oriented block renderer. Markdown gets headings (#/##/###), `- ` lists
// and inline spans; plain/html bodies render as literal lines. Checklists
// render live in every format. Each block carries data-line so a click can
// drop the caret on the right source line.
function renderBodyInto(container, body, format) {
  container.innerHTML = '';
  const markdown = format === 'markdown';
  const lines = String(body ?? '').split('\n');
  let list = null;
  lines.forEach((line, i) => {
    const check = CHECK_RE.exec(line);
    if (check) {
      list = null;
      container.appendChild(checkLine(check, i, markdown));
      return;
    }
    if (markdown) {
      const heading = /^(#{1,3}) +(.*)$/.exec(line);
      if (heading) {
        list = null;
        const h = document.createElement(`h${heading[1].length + 2}`);
        h.className = `md-h${heading[1].length}`;
        h.dataset.line = String(i);
        appendInline(h, heading[2]);
        container.appendChild(h);
        return;
      }
      const item = /^\s*[-*] +(.*)$/.exec(line);
      if (item) {
        if (!list) {
          list = document.createElement('ul');
          list.className = 'md-list';
          container.appendChild(list);
        }
        const li = document.createElement('li');
        li.dataset.line = String(i);
        appendInline(li, item[1]);
        list.appendChild(li);
        return;
      }
    }
    list = null;
    const p = document.createElement('p');
    p.dataset.line = String(i);
    if (line.trim()) {
      p.className = 'md-p';
      if (markdown) appendInline(p, line);
      else p.textContent = line;
    } else {
      p.className = 'md-gap';
    }
    container.appendChild(p);
  });
}

// ---------- Search ----------

// Append `text` to `el` with every occurrence of the search term wrapped in
// <mark> — built from text nodes, so note content never parses as HTML.
function highlightInto(el, text, term) {
  const str = String(text ?? '');
  if (!term) {
    el.textContent = str;
    return;
  }
  const lower = str.toLowerCase();
  let i = 0;
  let idx = lower.indexOf(term, i);
  while (idx !== -1) {
    if (idx > i) el.appendChild(document.createTextNode(str.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.textContent = str.slice(idx, idx + term.length);
    el.appendChild(mark);
    i = idx + term.length;
    idx = lower.indexOf(term, i);
  }
  if (i < str.length) el.appendChild(document.createTextNode(str.slice(i)));
}

// Flatten a body for the row preview: markdown syntax becomes glyphs, and
// when a search match sits deep in the note the snippet re-centers on it.
function previewText(body, term) {
  const flat = String(body ?? '')
    .split('\n')
    .map((l) =>
      l
        .replace(/^#{1,3} +/, '')
        .replace(/^\s*[-*] \[[xX]\] ?/, '☑ ')
        .replace(/^\s*[-*] \[ \] ?/, '☐ ')
        .replace(/^\s*[-*] +/, '• '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (term) {
    const at = flat.toLowerCase().indexOf(term);
    if (at > 100) return `…${flat.slice(at - 40, at - 40 + 200)}`;
  }
  return flat.slice(0, 200);
}

// Render a vault search snippet from text nodes only — the ⟦…⟧ hit markers
// the vault returns become <mark>, and note content never parses as HTML.
function snippetInto(el, snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = parts[i];
      el.appendChild(mark);
    } else {
      el.appendChild(document.createTextNode(parts[i]));
    }
  }
}

// Searching asks the vault, not a local copy: the FTS5 index matches over
// every note (title + body) inside SQLite and returns only the hits, so the
// app never greps an unbounded table in memory. `searchSeq` drops stale
// replies when the owner types faster than the vault answers.
const searchInput = $('searchInput');
let searchDebounce = 0;
let searchSeq = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const raw = searchInput.value.trim();
    searchTerm = raw.toLowerCase();
    if (!raw) {
      searchResults = null;
      renderNotes();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    try {
      const data = await window.centraid.read({ query: 'search', input: { term: raw } });
      rows = data?.notes ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    searchResults = rows;
    renderNotes();
  }, 120);
});

function clearSearch() {
  searchInput.value = '';
  searchTerm = '';
  searchResults = null;
  renderNotes();
}

// ---------- Read + render ----------

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'library' });
  } catch {
    if (firstLoad) {
      firstLoad = false;
      $('noteList').innerHTML = '';
    }
    readFailed($('noticeBanner'));
    readErrorShown = true;
    return;
  }
  if (firstLoad) {
    firstLoad = false;
    $('noteList').innerHTML = '';
  }
  if (readErrorShown) {
    readErrorShown = false;
    notice('');
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('quickAdd').hidden = Boolean(denied);
  $('searchWrap').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('notebookChips').innerHTML = '';
    $('noteList').innerHTML = '';
    $('noteView').hidden = true;
    $('empty').hidden = true;
    return;
  }
  notes = data?.notes ?? [];
  notebooks = data?.notebooks ?? [];
  if (activeNotebook !== 'all' && !notebooks.some((nb) => nb.notebook_id === activeNotebook)) {
    activeNotebook = 'all';
  }
  if (renamingNotebookId && !notebooks.some((nb) => nb.notebook_id === renamingNotebookId)) {
    renamingNotebookId = null; // renamed-away target deleted elsewhere
  }
  if (viewingId) {
    const fresh = currentNote();
    if (!fresh) {
      // Deleted elsewhere. If the user is mid-edit keep the draft on screen;
      // otherwise fall back to the list.
      if (!editorBusy()) closeNoteView();
    } else if (!editorBusy()) {
      draft = { title: fresh.title ?? '', body: fresh.body ?? '' };
      lastSaved = { ...draft };
      renderNoteView(fresh);
    }
  }
  renderChips();
  renderNotes();
}

function renderChips() {
  const row = $('notebookChips');
  row.innerHTML = '';
  const all = [{ notebook_id: 'all', name: 'All' }, ...notebooks];
  for (const nb of all) {
    if (nb.notebook_id !== 'all' && nb.notebook_id === renamingNotebookId) {
      row.appendChild(renameChipInput(nb));
      continue;
    }
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = nb.name ?? 'Notebook';
    chip.setAttribute('aria-pressed', String(nb.notebook_id === activeNotebook));
    chip.addEventListener('click', async () => {
      activeNotebook = nb.notebook_id;
      renamingNotebookId = null;
      if (viewingId) await goBack();
      renderChips();
      renderNotes();
    });
    row.appendChild(chip);
    // The selected notebook is manageable in place: rename and delete ride
    // beside its chip — a typo'd notebook is no longer forever.
    if (nb.notebook_id !== 'all' && nb.notebook_id === activeNotebook) {
      row.append(renameChipButton(nb), deleteChipButton(nb));
    }
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip chip-add';
  add.textContent = '+ Notebook';
  add.addEventListener('click', () => {
    $('notebookForm').hidden = false;
    $('notebookNameInput').focus();
  });
  row.appendChild(add);
}

// ---------- Notebook management (rename / delete beside the active chip) ----------

// The vault's predicates, translated. Rename refuses a name already used by
// another of the owner's notebooks; delete refuses while children exist.
const RENAME_NOTEBOOK_FRIENDLY = {
  name_unused_by_owner: 'You already have a notebook with that name.',
};
const DELETE_NOTEBOOK_FRIENDLY = {
  notebook_has_no_children:
    'This notebook still has notebooks inside it — delete or move those first.',
};

function renameChipButton(nb) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip-tool';
  btn.textContent = '✎';
  btn.title = 'Rename notebook';
  btn.setAttribute('aria-label', `Rename notebook ${nb.name ?? ''}`);
  btn.addEventListener('click', () => {
    renamingNotebookId = nb.notebook_id;
    renderChips();
    const input = $('notebookChips').querySelector('.chip-rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  });
  return btn;
}

function deleteChipButton(nb) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip-tool danger';
  btn.textContent = '×';
  btn.title = 'Delete notebook';
  btn.setAttribute('aria-label', `Delete notebook ${nb.name ?? ''}`);
  btn.addEventListener('click', async () => {
    if (!armConfirm(btn, { armedLabel: 'Delete?' })) return;
    const outcome = await act('delete-notebook', { notebook_id: nb.notebook_id });
    if (narrate(outcome, refresh, DELETE_NOTEBOOK_FRIENDLY)) {
      // The notebook was pure structure: its notes survive as unfiled rows.
      const unfiled = Number(outcome.output?.notes_unfiled ?? 0);
      activeNotebook = 'all';
      renamingNotebookId = null;
      toast(`Notebook deleted — ${unfiled} ${unfiled === 1 ? 'note' : 'notes'} unfiled`);
      await refresh();
    }
  });
  return btn;
}

// The chip swapped for an inline rename input: Enter saves, Esc (or clicking
// away) cancels. A refused rename keeps the input open with the banner
// explaining why, so the user can fix the name in place.
function renameChipInput(nb) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-rename-input';
  input.value = nb.name ?? '';
  input.setAttribute('aria-label', `New name for notebook ${nb.name ?? ''}`);
  let settled = false;
  const close = () => {
    if (settled) return;
    settled = true;
    renamingNotebookId = null;
    renderChips();
  };
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // the document-level Escape must not double-handle
      close();
      return;
    }
    if (e.key !== 'Enter' || settled) return;
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === nb.name) {
      // Nothing to send — the vault treats a rename to its own name as a
      // no-op anyway, so skip the round-trip entirely.
      close();
      return;
    }
    const outcome = await act('rename-notebook', { notebook_id: nb.notebook_id, name });
    if (narrate(outcome, refresh, RENAME_NOTEBOOK_FRIENDLY)) {
      settled = true;
      renamingNotebookId = null;
      await refresh();
    } else if (!settled) {
      input.focus();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  return input;
}

function visibleNotes() {
  // While a term is active the list IS the vault's ranked matches — the
  // library copy is only the browse view. The notebook chip still narrows.
  let rows = searchTerm ? (searchResults ?? []) : notes;
  if (activeNotebook !== 'all') {
    rows = rows.filter((n) => (n.notebook_ids ?? []).includes(activeNotebook));
  }
  return rows;
}

function renderNotes() {
  const list = $('noteList');
  list.innerHTML = '';
  const rows = visibleNotes();
  const empty = $('empty');
  empty.hidden = rows.length > 0 || viewingId != null || firstLoad;
  empty.textContent = searchTerm
    ? 'No notes match your search.'
    : 'No notes yet. Write the first one above.';
  const pinned = rows.filter((n) => n.pinned === 1);
  const others = rows.filter((n) => n.pinned !== 1);
  const grid = (group) => {
    const el = document.createElement('div');
    el.className = 'note-grid';
    for (const note of group) el.appendChild(renderRow(note));
    return el;
  };
  const head = (label) => {
    const el = document.createElement('h2');
    el.className = 'section-head';
    el.textContent = label;
    return el;
  };
  if (pinned.length > 0) {
    list.append(head('Pinned'), grid(pinned));
    if (others.length > 0) list.append(head('Others'), grid(others));
  } else if (others.length > 0) {
    list.append(grid(others));
  }
}

function renderRow(note) {
  const row = document.createElement('article');
  row.className = 'note';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  const title = document.createElement('span');
  title.className = 'note-title';
  highlightInto(title, note.title ?? '', searchTerm);
  row.appendChild(title);
  const text = document.createElement('span');
  text.className = 'note-preview';
  // A vault match carries its own snippet, already centered on the hit.
  if (note.snippet) snippetInto(text, note.snippet);
  else highlightInto(text, previewText(note.body, searchTerm), searchTerm);
  row.appendChild(text);
  const meta = document.createElement('span');
  meta.className = 'note-meta-row';
  const when = document.createElement('span');
  when.textContent = relTime(note.updated_at);
  meta.appendChild(when);
  const names = note.notebook_names ?? [];
  if (names.length > 0) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = names.join(' · ');
    meta.appendChild(tag);
  }
  row.appendChild(meta);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = `pin-btn${note.pinned === 1 ? ' pinned' : ''}`;
  pin.innerHTML = PIN_SVG; // static trusted markup, never note content
  pin.setAttribute('aria-label', note.pinned === 1 ? 'Unpin note' : 'Pin note');
  pin.setAttribute('aria-pressed', String(note.pinned === 1));
  pin.addEventListener('click', async (e) => {
    e.stopPropagation();
    await togglePin(note);
  });
  row.appendChild(pin);
  row.addEventListener('click', () => openNote(note));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openNote(note);
    }
  });
  return row;
}

async function togglePin(note) {
  const outcome = await act('edit-note', {
    note_id: note.note_id,
    pinned: note.pinned === 1 ? 0 : 1,
  });
  if (narrate(outcome, refresh)) await refresh();
}

// ---------- Note view: edit-in-place with autosave ----------

function editorBusy() {
  const active = document.activeElement;
  return (
    dirty || savePromise != null || active === $('noteTitleInput') || active === $('noteBodyInput')
  );
}

async function openNote(note) {
  if (viewingId && viewingId !== note.note_id) await flushSave();
  viewingId = note.note_id;
  draft = { title: note.title ?? '', body: note.body ?? '' };
  lastSaved = { ...draft };
  dirty = false;
  editingBody = false;
  setSaveState('');
  renderNoteView(note);
  $('noteView').hidden = false;
  $('noteList').hidden = true;
  $('notebookChips').hidden = true;
  $('quickAdd').hidden = true;
  $('searchWrap').hidden = true;
  $('empty').hidden = true;
}

function renderNoteView(note) {
  $('noteTitleInput').value = draft.title;
  const names = note.notebook_names ?? [];
  $('noteMeta').textContent = [`Edited ${relTime(note.updated_at)}`, names.join(' · ')]
    .filter(Boolean)
    .join(' — ');
  $('pinButton').textContent = note.pinned === 1 ? 'Unpin' : 'Pin';
  renderNoteBody(note);
  renderMoveSelect(note);
  renderAttachments($('attachStrip'), note.attachments, removeAttachment);
}

function renderNoteBody(note) {
  const render = $('noteBodyRender');
  const input = $('noteBodyInput');
  if (editingBody) {
    render.hidden = true;
    input.hidden = false;
    if (input.value !== draft.body) input.value = draft.body;
    autoSize(input);
  } else {
    input.hidden = true;
    render.hidden = false;
    renderBodyInto(render, draft.body, note?.format);
  }
}

function renderMoveSelect(note) {
  const select = $('moveSelect');
  select.innerHTML = '';
  const current = (note.notebook_ids ?? [])[0] ?? '';
  for (const option of [{ notebook_id: '', name: 'Unfiled' }, ...notebooks]) {
    const el = document.createElement('option');
    el.value = option.notebook_id;
    el.textContent = option.name ?? 'Notebook';
    el.selected = option.notebook_id === current;
    select.appendChild(el);
  }
}

function closeNoteView() {
  viewingId = null;
  draft = null;
  lastSaved = null;
  dirty = false;
  editingBody = false;
  setSaveState('');
  $('noteView').hidden = true;
  $('noteList').hidden = false;
  $('notebookChips').hidden = false;
  $('quickAdd').hidden = false;
  $('searchWrap').hidden = false;
  renderNotes();
}

async function goBack() {
  await flushSave();
  closeNoteView();
}

// ---------- Autosave machinery ----------

function setSaveState(state) {
  const el = $('saveState');
  clearTimeout(saveStateTimer);
  if (state === 'saving') el.textContent = 'Saving…';
  else if (state === 'saved') {
    el.textContent = 'Saved';
    saveStateTimer = setTimeout(() => {
      el.textContent = '';
    }, 2500);
  } else if (state === 'pending') el.textContent = 'Pending approval';
  else if (state === 'error') el.textContent = 'Not saved';
  else el.textContent = '';
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    doSave();
  }, 800);
}

function doSave() {
  if (savePromise) return savePromise;
  savePromise = performSave().finally(() => {
    savePromise = null;
  });
  return savePromise;
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) await savePromise;
  if (dirty && viewingId) await doSave();
}

// Quick-add derives a title from the body's first line; the editor keeps the
// same contract when the title is cleared, so a note never loses its name.
function deriveTitle(d) {
  const typed = d.title.trim();
  if (typed) return typed;
  const firstLine = d.body.split('\n').find((l) => l.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : '';
}

async function performSave() {
  const note = currentNote();
  if (!note || !draft || !dirty) return;
  const snapTitle = draft.title;
  const snapBody = draft.body;
  const savedTitle = deriveTitle(draft);
  const input = { note_id: note.note_id };
  if (savedTitle && savedTitle !== deriveTitle({ title: lastSaved.title, body: lastSaved.body })) {
    input.title = savedTitle;
  }
  if (snapBody.trim() && snapBody !== lastSaved.body) input.body_text = snapBody;
  if (!input.title && !input.body_text) {
    dirty = false;
    setSaveState('');
    return;
  }
  setSaveState('saving');
  const outcome = await act('edit-note', input);
  const executed = outcome?.status === 'executed';
  // Whatever the outcome, record the snapshot as submitted so the debounce
  // loop never resubmits identical content; a parked/failed edit is narrated
  // in the banner, not retried silently.
  lastSaved = { title: snapTitle, body: snapBody };
  dirty = draft.title !== snapTitle || draft.body !== snapBody;
  if (executed) {
    notice('');
    setSaveState(dirty ? 'saving' : 'saved');
    note.title = input.title ?? note.title;
    note.body = snapBody;
    note.updated_at = new Date().toISOString();
    if (dirty) scheduleSave();
  } else {
    narrate(outcome, refresh);
    setSaveState(outcome?.status === 'parked' ? 'pending' : 'error');
  }
}

// ---------- Body editor (click to type, blur to render) ----------

function autoSize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

function enterBodyEdit(caretPos = null) {
  if (!draft) return;
  editingBody = true;
  renderNoteBody(currentNote());
  const input = $('noteBodyInput');
  input.focus();
  const pos = caretPos ?? input.value.length;
  input.setSelectionRange(pos, pos);
}

function exitBodyEdit() {
  if (!editingBody) return;
  editingBody = false;
  renderNoteBody(currentNote());
}

$('noteBodyRender').addEventListener('click', (e) => {
  if (e.target.closest('a, input, .check-box')) return;
  const lineEl = e.target.closest('[data-line]');
  let pos = null;
  if (lineEl && draft) {
    const lineIdx = Number(lineEl.dataset.line);
    const lines = draft.body.split('\n');
    pos =
      lines.slice(0, lineIdx).reduce((n, l) => n + l.length + 1, 0) + (lines[lineIdx]?.length ?? 0);
  }
  enterBodyEdit(pos);
});

$('noteBodyRender').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target === $('noteBodyRender')) {
    e.preventDefault();
    enterBodyEdit();
  }
});

$('noteBodyInput').addEventListener('input', () => {
  if (!draft) return;
  draft.body = $('noteBodyInput').value;
  dirty = true;
  autoSize($('noteBodyInput'));
  scheduleSave();
});

// Enter inside a checklist line continues the list; Enter on an empty
// checklist marker ends it — the Notes/Keep muscle memory.
$('noteBodyInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const el = e.currentTarget;
  const pos = el.selectionStart;
  if (pos !== el.selectionEnd) return;
  const before = el.value.slice(0, pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  const m = /^(\s*[-*] \[[ xX]\] )(.*)$/.exec(before.slice(lineStart));
  if (!m) return;
  e.preventDefault();
  if (m[2] === '') el.setRangeText('\n', lineStart, pos, 'end');
  else el.setRangeText(`\n${m[1].replace(/\[[xX]\]/, '[ ]')}`, pos, pos, 'end');
  draft.body = el.value;
  dirty = true;
  autoSize(el);
  scheduleSave();
});

$('noteBodyInput').addEventListener('blur', () => {
  // Delay so a click on the toolbar (e.g. ☑ Checklist) doesn't bounce the
  // editor closed before the button handler runs.
  setTimeout(async () => {
    if (document.activeElement === $('noteBodyInput')) return;
    await flushSave();
    exitBodyEdit();
  }, 120);
});

$('noteTitleInput').addEventListener('input', () => {
  if (!draft) return;
  draft.title = $('noteTitleInput').value;
  dirty = true;
  scheduleSave();
});

$('noteTitleInput').addEventListener('blur', () => {
  flushSave();
});

// ---------- Checklist toggle + insert ----------

async function toggleCheckLine(lineIndex, checked) {
  const note = currentNote();
  if (!note || !draft) return;
  const lines = draft.body.split('\n');
  if (lines[lineIndex] == null) return;
  lines[lineIndex] = lines[lineIndex].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
  draft.body = lines.join('\n');
  dirty = true;
  renderNoteBody(note);
  await flushSave();
}

$('checklistButton').addEventListener('pointerdown', (e) => e.preventDefault());
$('checklistButton').addEventListener('click', () => {
  if (!viewingId || !draft) return;
  if (!editingBody) {
    const base =
      draft.body.length > 0 && !draft.body.endsWith('\n') ? `${draft.body}\n` : draft.body;
    draft.body = `${base}- [ ] `;
    dirty = true;
    scheduleSave();
    enterBodyEdit(draft.body.length);
    return;
  }
  const input = $('noteBodyInput');
  const value = input.value;
  const pos = input.selectionStart ?? value.length;
  const lineStart = value.slice(0, pos).lastIndexOf('\n') + 1;
  const nl = value.indexOf('\n', pos);
  const lineEnd = nl === -1 ? value.length : nl;
  let caret;
  if (value.slice(lineStart, lineEnd).trim() === '') {
    input.setRangeText('- [ ] ', lineStart, lineStart, 'end');
    caret = lineStart + 6;
  } else {
    input.setRangeText('\n- [ ] ', lineEnd, lineEnd, 'end');
    caret = lineEnd + 7;
  }
  input.setSelectionRange(caret, caret);
  draft.body = input.value;
  dirty = true;
  autoSize(input);
  scheduleSave();
  input.focus();
});

// ---------- Quick add ----------

$('titleInput').addEventListener('focus', () => {
  $('quickAddMore').hidden = false;
  $('quickAddTarget').textContent =
    activeNotebook === 'all'
      ? 'Unfiled'
      : `Into ${notebooks.find((nb) => nb.notebook_id === activeNotebook)?.name ?? 'notebook'}`;
});

$('cancelAdd').addEventListener('click', () => {
  $('titleInput').value = '';
  $('bodyInput').value = '';
  $('quickAddMore').hidden = true;
});

$('quickAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const typedTitle = $('titleInput').value.trim();
  const bodyText = $('bodyInput').value.trim();
  if (!typedTitle && !bodyText) {
    notice('Write something first — a title or a first line is enough.');
    return;
  }
  // No title? The first line of the body is the title, like every notes app.
  const title = typedTitle || bodyText.split('\n')[0].slice(0, 80);
  const outcome = await act('create-note', {
    title,
    body_text: bodyText || typedTitle,
    format: 'markdown',
    ...(activeNotebook !== 'all' ? { notebook_id: activeNotebook } : {}),
  });
  if (narrate(outcome, refresh)) {
    $('titleInput').value = '';
    $('bodyInput').value = '';
    $('quickAddMore').hidden = true;
    await refresh();
  }
});

// ---------- Notebooks ----------

$('notebookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('notebookNameInput').value.trim();
  if (!name) return;
  const outcome = await act('create-notebook', { name });
  if (narrate(outcome, refresh)) {
    $('notebookNameInput').value = '';
    $('notebookForm').hidden = true;
    activeNotebook = outcome.output.notebook_id;
    await refresh();
  }
});

$('cancelNotebook').addEventListener('click', () => {
  $('notebookForm').hidden = true;
});

// ---------- Note view: attachments, pin, move, delete ----------

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

wireAttachInput($('attachInput'), () => viewingId);

$('pinButton').addEventListener('click', async () => {
  const note = currentNote();
  if (!note) return;
  await togglePin(note);
});

$('moveSelect').addEventListener('change', async () => {
  const note = currentNote();
  if (!note) return;
  await flushSave();
  const target = $('moveSelect').value;
  const outcome = await act('move-note', {
    note_id: note.note_id,
    ...(target ? { notebook_id: target } : {}),
  });
  if (narrate(outcome, refresh)) await refresh();
});

// Deletion confirms with a second click on the same control, not a modal.
// The command drops the note plus its placements, annotations and
// attachment edges; the deduped body is only released when nothing else
// shares it.
$('deleteButton').addEventListener('click', async () => {
  const note = currentNote();
  if (!note) return;
  if (!armConfirm($('deleteButton'), { armedLabel: 'Really delete?' })) return;
  const title = note.title;
  const outcome = await act('delete-note', { note_id: note.note_id });
  if (narrate(outcome, refresh)) {
    closeNoteView();
    toast(`Deleted “${String(title).slice(0, 40)}”`);
    await refresh();
  }
});

$('backButton').addEventListener('click', goBack);

// ---------- Keyboard ----------

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing =
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable);
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    if (viewingId) {
      e.preventDefault();
      flushSave();
    } else if (t === $('titleInput') || t === $('bodyInput')) {
      e.preventDefault();
      $('quickAdd').requestSubmit();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (!$('lightbox').hidden) {
      closeLightbox();
      return;
    }
    if (t === searchInput) {
      if (searchTerm || searchInput.value) clearSearch();
      else searchInput.blur();
      return;
    }
    if (typing) {
      t.blur(); // in the note editor this saves and re-renders
      return;
    }
    if (viewingId) goBack();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    if (viewingId) {
      goBack().then(() => searchInput.focus());
    } else {
      searchInput.focus();
    }
  } else if (e.key === 'n') {
    e.preventDefault();
    if (viewingId) {
      goBack().then(() => $('titleInput').focus());
    } else {
      $('titleInput').focus();
    }
  }
});

// Autosave must survive tab switches and iframe teardown as well as it can.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

window.addEventListener('focus', refresh);
showSkeleton($('noteList'), 5);
refresh();
