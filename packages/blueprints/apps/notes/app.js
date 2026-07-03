// Notes — a projection over the personal vault. Every row rendered here
// lives in knowledge.note; bodies are canonical core.content_item rows
// decoded gateway-side by the library query. Writes go through the
// knowledge domain's typed commands (create_note, edit_note, move_note,
// create_notebook) routed via this app's action handlers — consent-checked
// per command and receipted. Revoke the grant and this page goes dark
// while the model, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

let notes = [];
let notebooks = [];
let activeNotebook = 'all';
let viewing = null;

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

function preview(body) {
  const flat = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function fmtDay(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(iso ?? '');
  }
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'library' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('quickAdd').hidden = Boolean(denied);
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
  if (viewing) {
    // Keep the open note fresh across change-feed refreshes.
    viewing = notes.find((n) => n.note_id === viewing.note_id) ?? null;
    if (viewing) openNote(viewing);
    else closeNote();
  }
  renderChips();
  renderNotes();
}

function renderChips() {
  const row = $('notebookChips');
  row.innerHTML = '';
  const all = [{ notebook_id: 'all', name: 'All' }, ...notebooks];
  for (const nb of all) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = nb.name ?? 'Notebook';
    chip.setAttribute('aria-pressed', String(nb.notebook_id === activeNotebook));
    chip.addEventListener('click', () => {
      activeNotebook = nb.notebook_id;
      closeNote();
      renderChips();
      renderNotes();
    });
    row.appendChild(chip);
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

function visibleNotes() {
  if (activeNotebook === 'all') return notes;
  return notes.filter((n) => (n.notebook_ids ?? []).includes(activeNotebook));
}

function renderNotes() {
  const list = $('noteList');
  list.innerHTML = '';
  const rows = visibleNotes();
  $('empty').hidden = rows.length > 0 || !$('noteView').hidden;
  for (const note of rows) {
    list.appendChild(renderRow(note));
  }
}

function renderRow(note) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'note';
  const main = document.createElement('span');
  main.className = 'note-main';
  const title = document.createElement('span');
  title.className = 'note-title';
  title.textContent = note.pinned === 1 ? `📌 ${note.title}` : note.title;
  const text = document.createElement('span');
  text.className = 'note-preview muted small';
  text.textContent = preview(note.body);
  main.append(title, text);
  row.appendChild(main);
  const names = note.notebook_names ?? [];
  if (names.length > 0) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = names.join(' · ');
    row.appendChild(tag);
  }
  row.addEventListener('click', () => openNote(note));
  return row;
}

function openNote(note) {
  viewing = note;
  $('noteTitle').textContent = note.title;
  const names = note.notebook_names ?? [];
  $('noteMeta').textContent = [fmtDay(note.updated_at), names.join(' · ')]
    .filter(Boolean)
    .join(' — ');
  $('noteBody').textContent = note.body ?? '';
  $('pinButton').textContent = note.pinned === 1 ? 'Unpin' : 'Pin';
  renderMoveSelect(note);
  renderAttachments($('attachStrip'), note.attachments, removeAttachment);
  closeEdit();
  $('noteView').hidden = false;
  $('noteList').hidden = true;
  $('notebookChips').hidden = true;
  $('quickAdd').hidden = true;
  $('empty').hidden = true;
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

function closeNote() {
  viewing = null;
  $('noteView').hidden = true;
  $('noteList').hidden = false;
  $('notebookChips').hidden = false;
  $('quickAdd').hidden = false;
  closeEdit();
  renderNotes();
}

function closeEdit() {
  $('editForm').hidden = true;
  $('noteBody').hidden = false;
  $('noteTitle').hidden = false;
}

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
  const title = $('titleInput').value.trim();
  const bodyText = $('bodyInput').value.trim();
  if (!title || !bodyText) return;
  const outcome = await act('create-note', {
    title,
    body_text: bodyText,
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

// ---------- Note view: attachments, pin, move, edit ----------

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome, refresh)) await refresh();
}

wireAttachInput($('attachInput'), () => viewing?.note_id);

$('pinButton').addEventListener('click', async () => {
  if (!viewing) return;
  const outcome = await act('edit-note', {
    note_id: viewing.note_id,
    pinned: viewing.pinned === 1 ? 0 : 1,
  });
  if (narrate(outcome, refresh)) await refresh();
});

$('moveSelect').addEventListener('change', async () => {
  if (!viewing) return;
  const target = $('moveSelect').value;
  const outcome = await act('move-note', {
    note_id: viewing.note_id,
    ...(target ? { notebook_id: target } : {}),
  });
  if (narrate(outcome, refresh)) await refresh();
});

$('editButton').addEventListener('click', () => {
  if (!viewing) return;
  $('editTitleInput').value = viewing.title;
  $('editBodyInput').value = viewing.body ?? '';
  $('noteBody').hidden = true;
  $('noteTitle').hidden = true;
  $('editForm').hidden = false;
  $('editTitleInput').focus();
});

$('cancelEdit').addEventListener('click', closeEdit);

$('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!viewing) return;
  const title = $('editTitleInput').value.trim();
  const bodyText = $('editBodyInput').value.trim();
  if (!title || !bodyText) return;
  const input = { note_id: viewing.note_id };
  if (title !== viewing.title) input.title = title;
  if (bodyText !== (viewing.body ?? '')) input.body_text = bodyText;
  if (!input.title && !input.body_text) {
    closeEdit();
    return;
  }
  const outcome = await act('edit-note', input);
  if (narrate(outcome, refresh)) await refresh();
});

$('backButton').addEventListener('click', closeNote);

window.addEventListener('focus', refresh);
refresh();
