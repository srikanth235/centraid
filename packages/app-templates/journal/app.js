// Journal — frontend.
// State lives on the gateway; the page caches the active entry locally so
// keystrokes don't fire a roundtrip per character. Saves debounce by ~500ms.

const $ = (id) => document.getElementById(id);

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

let activeDate = todayKey();
let savedBody = '';
let saveTimer = null;
let lastSavedAt = null;
let entries = [];

async function run(action, args) {
  const res = await fetch('_run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function loadEntries() {
  const res = await fetch('_data/list-dates');
  if (!res.ok) return;
  entries = await res.json();
  renderList();
}

async function loadActive() {
  const res = await fetch('_data/get?date=' + encodeURIComponent(activeDate));
  if (!res.ok) return;
  const data = await res.json();
  savedBody = data.body ?? '';
  lastSavedAt = data.updatedAt ?? null;
  const ta = $('body');
  ta.value = savedBody;
  renderHeader();
  renderStatus();
}

function renderHeader() {
  $('dateLabel').textContent = formatDateLabel(activeDate);
  $('deleteBtn').hidden = !entries.some((e) => e.date === activeDate);
}

function renderStatus() {
  $('status').textContent = lastSavedAt ? 'Saved.' : '';
}

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No entries yet.';
    list.append(empty);
    return;
  }
  for (const e of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'entry';
    btn.setAttribute('data-active', String(e.date === activeDate));
    const date = document.createElement('div');
    date.className = 'entry-date';
    date.textContent = formatDateLabel(e.date);
    const preview = document.createElement('div');
    preview.className = 'entry-preview';
    preview.textContent = e.preview || 'Empty';
    btn.append(date, preview);
    btn.addEventListener('click', async () => {
      // Flush any pending save before switching dates so the previous
      // entry's tail keystrokes aren't lost.
      await flushSave();
      activeDate = e.date;
      await loadActive();
      renderList();
    });
    list.append(btn);
  }
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const ta = $('body');
  const text = ta.value;
  if (text === savedBody) return;
  const result = await run('save', { date: activeDate, body: text });
  if (result) {
    savedBody = text;
    lastSavedAt = result.updatedAt ?? Date.now();
    renderStatus();
    await loadEntries();
    renderHeader();
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  $('status').textContent = 'Saving…';
  saveTimer = setTimeout(() => {
    void flushSave();
  }, 500);
}

$('body').addEventListener('input', scheduleSave);
$('body').addEventListener('blur', () => void flushSave());

$('todayBtn').addEventListener('click', async () => {
  await flushSave();
  activeDate = todayKey();
  await loadActive();
  renderList();
});

$('deleteBtn').addEventListener('click', async () => {
  await run('delete', { date: activeDate });
  // After deletion: drop to today (or the most recent remaining entry).
  await loadEntries();
  activeDate = entries[0]?.date ?? todayKey();
  await loadActive();
  renderList();
});

void (async () => {
  await loadEntries();
  await loadActive();
  renderList();
})();
