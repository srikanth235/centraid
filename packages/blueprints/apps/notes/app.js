// Notes — a read-only projection over the personal vault. Every row rendered
// here lives in knowledge.note; bodies are canonical core.content_item rows
// decoded gateway-side by the library query. There are no write paths: the
// knowledge domain has no typed commands yet, so this app is a window, not
// a pen. Revoke the grant and this page goes dark while the model, history
// and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

let notes = [];
let notebooks = [];
let activeNotebook = 'all';

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
  title.textContent = note.title;
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
  $('noteTitle').textContent = note.title;
  const names = note.notebook_names ?? [];
  $('noteMeta').textContent = [fmtDay(note.updated_at), names.join(' · ')]
    .filter(Boolean)
    .join(' — ');
  $('noteBody').textContent = note.body ?? '';
  $('noteView').hidden = false;
  $('noteList').hidden = true;
  $('notebookChips').hidden = true;
  $('empty').hidden = true;
}

function closeNote() {
  $('noteView').hidden = true;
  $('noteList').hidden = false;
  $('notebookChips').hidden = false;
  renderNotes();
}

$('backButton').addEventListener('click', closeNote);

window.addEventListener('focus', refresh);
refresh();
