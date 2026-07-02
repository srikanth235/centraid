// Tasks — a pure projection over the personal vault. Every row rendered
// here lives in schedule.task; nothing is stored in this app and nothing
// is written back. The schedule domain's typed task commands don't exist
// yet, so this page is deliberately a window, not a pen: revoke the grant
// and it goes dark while the model, history and receipts remain the
// owner's.

const $ = (id) => document.getElementById(id);

// schedule_task's status CHECK constraint, in display order.
const SECTIONS = [
  { status: 'needs-action', label: 'To do' },
  { status: 'in-process', label: 'In progress' },
  { status: 'completed', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
];

const DONE_STATUSES = new Set(['completed', 'cancelled']);

function fmtDue(iso) {
  try {
    const label = new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    return `Due ${label}`;
  } catch {
    return `Due ${iso}`;
  }
}

function isOverdue(task) {
  if (!task.due_at || DONE_STATUSES.has(task.status)) return false;
  return String(task.due_at).slice(0, 10) < new Date().toISOString().slice(0, 10);
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'list' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('taskList').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  renderTasks(data?.tasks ?? []);
}

function renderTasks(tasks) {
  const list = $('taskList');
  list.innerHTML = '';
  $('empty').hidden = tasks.length > 0;
  const byStatus = new Map();
  for (const task of tasks) {
    if (!byStatus.has(task.status)) byStatus.set(task.status, []);
    byStatus.get(task.status).push(task);
  }
  for (const { status, label } of SECTIONS) {
    const sectionTasks = byStatus.get(status);
    if (!sectionTasks?.length) continue;
    const h = document.createElement('p');
    h.className = 'section-label muted small';
    h.textContent = label;
    list.appendChild(h);
    for (const task of sectionTasks) {
      list.appendChild(renderRow(task));
    }
  }
}

function renderRow(task) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.status = task.status;
  row.dataset.done = String(DONE_STATUSES.has(task.status));
  // A static marker, not a control — done-ness can't be toggled from here.
  const circle = document.createElement('span');
  circle.className = 'circle';
  circle.dataset.on = String(task.status === 'completed');
  circle.setAttribute('aria-hidden', 'true');
  if (task.status === 'completed') circle.textContent = '✓';
  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = task.title;
  row.append(circle, text);
  if (task.due_at) {
    const due = document.createElement('span');
    due.className = `row-due muted small${isOverdue(task) ? ' overdue' : ''}`;
    due.textContent = fmtDue(task.due_at);
    row.appendChild(due);
  }
  return row;
}

window.addEventListener('focus', refresh);
refresh();
