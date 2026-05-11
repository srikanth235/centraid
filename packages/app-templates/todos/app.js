// Todos — frontend.
// All state lives on the gateway (SQLite). The page is a thin shell that
// fetches the list, renders it, and forwards mutations to actions/.

const $ = (id) => document.getElementById(id);

let todos = [];

async function refresh() {
  const res = await fetch('_data/list');
  if (!res.ok) return;
  todos = await res.json();
  render();
}

async function run(action, args) {
  const res = await fetch('_run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args }),
  });
  if (!res.ok) return null;
  return res.json();
}

function render() {
  const openList = $('openList');
  const doneList = $('doneList');
  const doneSection = $('doneSection');
  const empty = $('empty');
  const openCount = $('openCount');

  openList.innerHTML = '';
  doneList.innerHTML = '';

  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  openCount.textContent = open.length === 1 ? '1 open' : `${open.length} open`;

  for (const t of open) openList.append(renderRow(t));
  for (const t of done) doneList.append(renderRow(t));

  doneSection.hidden = done.length === 0;
  $('doneLabel').textContent = done.length === 1 ? 'Done · 1' : `Done · ${done.length}`;
  empty.hidden = todos.length > 0;
}

function renderRow(t) {
  const circle = document.createElement('button');
  circle.type = 'button';
  circle.className = 'circle';
  circle.setAttribute('data-on', String(t.done));
  circle.setAttribute('aria-label', t.done ? 'Mark as not done' : 'Mark as done');
  if (t.done) circle.textContent = '✓';
  circle.addEventListener('click', async () => {
    await run('toggle', { id: t.id });
    await refresh();
  });

  const text = document.createElement('div');
  text.className = 'row-text';
  text.textContent = t.text;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.setAttribute('aria-label', 'Delete');
  del.textContent = '×';
  del.addEventListener('click', async () => {
    await run('delete', { id: t.id });
    await refresh();
  });

  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('data-done', String(t.done));
  row.append(circle, text, del);
  return row;
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('addInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await run('add', { text });
  await refresh();
});

void refresh();
