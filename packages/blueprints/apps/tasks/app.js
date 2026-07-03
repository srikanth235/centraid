// Tasks — a Things-style manager that is still a pure projection over the
// personal vault. Every row rendered here lives in schedule.task; every
// mutation is a typed vault command (schedule.add_task / set_task_status /
// edit_task) routed through this app's handlers, consent-checked and
// receipted. The app's own data.sqlite stays empty by design: revoke the
// grant and this page goes dark while the tasks, history and receipts
// remain the owner's.

const $ = (id) => document.getElementById(id);

const OPEN_STATUSES = new Set(['needs-action', 'in-process']);

// The quick-add form's optional subtask context: set by the "+" on a row.
let parentContext = null; // { task_id, title }

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDay(iso) {
  try {
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

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
    notice('Sent to the owner for confirmation — it will appear once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
  }
  return false;
}

async function write(action, input) {
  let outcome;
  try {
    outcome = await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return;
  }
  // Executed, and consent-state changes (denied) both warrant a re-read.
  if (narrate(outcome) || outcome?.status === 'denied') await refresh();
}

// Like write(), but returns the raw outcome so the shared attachment helpers
// can narrate and refresh on their own schedule.
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

// The task a click on a row's attach button will pin the next file onto. One
// hidden file input is shared across the whole board; the button sets this.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome) || outcome?.status === 'denied') await refresh();
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'board' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('quickAdd').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('board').innerHTML = '';
    $('logbook').hidden = true;
    $('empty').hidden = true;
    $('subtitle').textContent = 'Your canonical task list, from the vault.';
    return;
  }
  renderBoard(data?.open ?? [], data?.counts ?? {});
  renderLogbook(data?.logbook ?? []);
}

// ---------- The open board, bucketed by due date ----------

function bucketFor(task, today, weekEnd) {
  const due = task.due_at ? String(task.due_at).slice(0, 10) : null;
  if (!due) return 'anytime';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due <= weekEnd) return 'week';
  return 'later';
}

const BUCKETS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'anytime', label: 'Anytime' },
];

function renderBoard(open, counts) {
  const board = $('board');
  board.innerHTML = '';
  $('empty').hidden = open.length > 0;
  const today = todayStr();
  const dueToday = open.filter((t) => t.due_at && String(t.due_at).slice(0, 10) <= today).length;
  $('subtitle').textContent =
    counts.open > 0
      ? `${counts.open} open · ${dueToday} due today or overdue`
      : 'Your canonical task list, from the vault.';

  const weekEnd = plusDays(7);
  const groups = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const task of open) groups.get(bucketFor(task, today, weekEnd)).push(task);

  for (const { key, label } of BUCKETS) {
    const tasks = groups.get(key);
    if (!tasks.length) continue;
    const h = document.createElement('p');
    h.className = 'section-label muted small';
    h.dataset.bucket = key;
    h.textContent = `${label} · ${tasks.length}`;
    board.appendChild(h);
    for (const task of tasks) {
      board.appendChild(renderRow(task, { showDue: key === 'later' || key === 'overdue' }));
      for (const child of task.children ?? []) {
        board.appendChild(renderRow(child, { subtask: true, showDue: true }));
      }
    }
  }
}

// ---------- The logbook (closed top-level tasks) ----------

function renderLogbook(logbook) {
  const details = $('logbook');
  details.hidden = logbook.length === 0;
  $('logbookCount').textContent = logbook.length ? `· ${logbook.length}` : '';
  const list = $('logbookList');
  list.innerHTML = '';
  for (const task of logbook) {
    list.appendChild(renderRow(task, { closed: true, showDue: false }));
  }
}

// ---------- One task row ----------

function renderRow(task, { subtask = false, closed = false, showDue = false } = {}) {
  const row = document.createElement('div');
  row.className = subtask ? 'row subtask' : 'row';
  const isDone = !OPEN_STATUSES.has(task.status);
  row.dataset.status = task.status;
  row.dataset.done = String(isDone);

  const circle = document.createElement('button');
  circle.type = 'button';
  circle.className = 'circle';
  circle.dataset.on = String(task.status === 'completed');
  circle.title = isDone ? 'Reopen' : 'Complete';
  circle.setAttribute('aria-label', circle.title);
  if (task.status === 'completed') circle.textContent = '✓';
  if (task.status === 'cancelled') circle.textContent = '✕';
  circle.addEventListener('click', () =>
    write('set-status', {
      task_id: task.task_id,
      status: isDone ? 'needs-action' : 'completed',
    }),
  );

  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = task.title;
  if (!closed) {
    text.title = 'Click to rename';
    text.addEventListener('click', () => beginRename(row, text, task));
  }

  row.append(circle, text);

  if (task.status === 'in-process') row.appendChild(chip('badge doing', 'in progress'));
  if (task.priority >= 1) {
    const level = task.priority <= 3 ? 'high' : task.priority <= 6 ? 'medium' : 'low';
    row.appendChild(chip(`badge flag ${level}`, '⚑'));
  }
  if (task.effort_min) row.appendChild(chip('badge muted small', fmtEffort(task.effort_min)));
  if (task.rrule) row.appendChild(chip('badge muted small', '↻'));
  if (!closed && task.children?.length) {
    row.appendChild(chip('badge muted small', `${task.done_children}/${task.children.length}`));
  }

  if (task.due_at && (showDue || closed)) {
    const overdue = !isDone && String(task.due_at).slice(0, 10) < todayStr();
    const due = chip(`row-due muted small${overdue ? ' overdue' : ''}`, fmtDay(task.due_at));
    row.appendChild(due);
  }
  if (closed && task.completed_at) {
    row.appendChild(chip('row-due muted small', fmtDay(task.completed_at)));
  }

  if (!closed) row.appendChild(rowActions(task, subtask));

  // Any attachments render as a strip beneath the row; the row and its strip
  // travel together in a fragment so the board's append logic stays flat.
  if (task.attachments?.length) {
    const frag = document.createDocumentFragment();
    frag.appendChild(row);
    const strip = document.createElement('div');
    strip.className = 'attach-strip row-attachments';
    if (subtask) strip.classList.add('subtask');
    renderAttachments(strip, task.attachments, closed ? () => {} : removeAttachment);
    frag.appendChild(strip);
    return frag;
  }
  return row;
}

function chip(className, textContent) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = textContent;
  return el;
}

function fmtEffort(min) {
  const n = Number(min);
  if (n >= 60) return n % 60 === 0 ? `${n / 60}h` : `${Math.floor(n / 60)}h${n % 60}`;
  return `${n}m`;
}

// Hover affordances: start/pause, add-subtask (top level only), cancel.
function rowActions(task, subtask) {
  const wrap = document.createElement('span');
  wrap.className = 'row-actions';
  const inProcess = task.status === 'in-process';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'ghost';
  start.textContent = inProcess ? 'pause' : 'start';
  start.title = inProcess ? 'Back to To Do' : 'Mark in progress';
  start.addEventListener('click', () =>
    write('set-status', {
      task_id: task.task_id,
      status: inProcess ? 'needs-action' : 'in-process',
    }),
  );
  wrap.appendChild(start);

  if (!subtask) {
    const sub = document.createElement('button');
    sub.type = 'button';
    sub.className = 'ghost';
    sub.textContent = '+sub';
    sub.title = 'Add a subtask';
    sub.addEventListener('click', () => {
      parentContext = { task_id: task.task_id, title: task.title };
      $('parentChip').hidden = false;
      $('parentChipText').textContent = `Subtask of “${task.title}”`;
      $('titleInput').focus();
    });
    wrap.appendChild(sub);
  }

  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'ghost';
  attach.textContent = '⎘';
  attach.title = 'Attach a file';
  attach.setAttribute('aria-label', 'Attach a file');
  attach.addEventListener('click', () => {
    attachTarget = task.task_id;
    $('attachInput').click();
  });
  wrap.appendChild(attach);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost danger';
  cancel.textContent = '✕';
  cancel.title = 'Cancel this task';
  cancel.addEventListener('click', () =>
    write('set-status', { task_id: task.task_id, status: 'cancelled' }),
  );
  wrap.appendChild(cancel);
  return wrap;
}

// Inline rename: the title swaps for an input; Enter saves, Esc cancels.
function beginRename(row, text, task) {
  if (row.querySelector('input.rename')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = task.title;
  text.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const done = async (save) => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    if (save && title && title !== task.title) {
      await write('edit', { task_id: task.task_id, title });
    } else {
      input.replaceWith(text);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
}

// ---------- Quick add ----------

$('parentClear').addEventListener('click', () => {
  parentContext = null;
  $('parentChip').hidden = true;
});

$('quickAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('titleInput').value.trim();
  if (!title) return;
  const input = { title };
  if ($('dueInput').value) input.due_at = $('dueInput').value;
  const priority = Number($('prioInput').value);
  if (priority > 0) input.priority = priority;
  if (parentContext) input.parent_task_id = parentContext.task_id;
  await write('add', input);
  $('titleInput').value = '';
  $('titleInput').focus();
});

// ---------- Keyboard shortcuts ----------

// `n` focuses quick-add, `Escape` clears the subtask context. Inline-rename
// keys live on the rename input itself; nothing here fires while typing.
document.addEventListener('keydown', (e) => {
  const typing =
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n') {
    e.preventDefault();
    $('titleInput').focus();
  } else if (e.key === 'Escape' && parentContext) {
    parentContext = null;
    $('parentChip').hidden = true;
  }
});

// One hidden file input serves the whole board; the per-row attach button
// sets attachTarget just before triggering it.
wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
refresh();
