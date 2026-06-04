// Todos — frontend.
// All state lives on the gateway (SQLite). The page is a thin shell that
// reads the list via `centraid.read(...)` and forwards mutations through
// `centraid.write(...)`. Both helpers are baked into every served HTML
// by the runtime — they delegate to the three-tool dispatcher
// (`centraid_write` / `centraid_read`), which validates input against
// the app.json manifest before invoking the handler.

const $ = (id) => document.getElementById(id);
const bridge = typeof window !== 'undefined' ? window.centraid : undefined;

let todos = [];

async function refresh() {
  try {
    todos = (await window.centraid.read({ query: 'list' })) ?? [];
    render();
  } catch (_err) {
    /* leave list as-is; the change feed will retry */
  }
}

async function run(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (_err) {
    return null;
  }
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
    const result = await run('toggle', { id: t.id });
    if (result && !t.done) bridge?.haptic?.success?.();
    else bridge?.haptic?.selection?.();
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

// Re-fetch on every server-observed mutation (chat-assistant writes,
// cross-window edits, future cron jobs). The runtime injects
// `window.centraid.onChange` into every served HTML.
window.centraid?.onChange?.(() => void refresh());
