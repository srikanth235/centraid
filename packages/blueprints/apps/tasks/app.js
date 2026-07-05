// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Tasks is a finished Things-style product — natural-language quick-add, reschedule popovers, quick find, focus views, keyboard driving, drag-to-bucket — and splitting it would break that "one file" contract.
// Tasks — a Things-style manager that is still a pure projection over the
// personal vault. Every row rendered here lives in schedule.task; every
// mutation is a typed vault command (schedule.add_task / set_task_status /
// edit_task) routed through this app's handlers, consent-checked and
// receipted. The app's own data.sqlite stays empty by design: revoke the
// grant and this page goes dark while the tasks, history and receipts
// remain the owner's.

import {
  armConfirm,
  attachMentionField,
  debounce,
  inlineLinkIds,
  outcomeMessage,
  readFailed,
  removeReference,
  renderReferenceStrip,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

const OPEN_STATUSES = new Set(['needs-action', 'in-process']);
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The quick-add form's optional subtask context: set by the "+" on a row.
let parentContext = null; // { task_id, title }

// Client-side presentation state — never persisted, never sent to the vault.
const state = { view: 'all', search: '' };
let lastData = null; // last successful board read, re-rendered on filter flips
let searchResults = null; // vault FTS matches while a term is active
let searchSnippets = null; // task_id → ⟦…⟧ hit snippet for the matched rows
let readFailedShown = false;

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
  const message = outcomeMessage(outcome);
  if (message) notice(message);
  return false;
}

async function write(action, input) {
  let outcome;
  try {
    outcome = await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return undefined;
  }
  // Executed, and consent-state changes (denied) both warrant a re-read.
  if (narrate(outcome) || outcome?.status === 'denied') await refresh();
  return outcome;
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
      if (!narrate(outcome)) break;
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

// The board window: the board query reads only this many newest open tasks
// (the logbook read is capped at its visible 50). "Show more" grows it;
// search reaches the rest through the vault's FTS index.
let boardWindow = 500;
let boardTruncated = false;

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'board', input: { limit: boardWindow } });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    readFailedShown = true;
    return;
  }
  if (readFailedShown) {
    readFailedShown = false;
    notice('');
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
  lastData = data;
  boardTruncated = Boolean(data?.truncated);
  render();
}

function render() {
  if (!lastData) return;
  renderBoard(lastData.open ?? [], lastData.counts ?? {});
  renderLogbook(lastData.logbook ?? []);
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

// Which buckets each focus view shows; Today folds in Overdue, like Things.
const VIEW_BUCKETS = {
  all: new Set(['overdue', 'today', 'week', 'later', 'anytime']),
  today: new Set(['overdue', 'today']),
  upcoming: new Set(['week', 'later']),
};

// Quick find is a vault question, not a local grep: while a term is active
// the visible set is the FTS match set the search query returned. Keep a
// parent when it matches (with all its subtasks), or slim it down to just
// the matching subtasks when only children hit.
function applySearch(open) {
  if (!state.search.trim()) return open;
  const matched = new Set((searchResults ?? []).map((t) => t.task_id));
  const hit = (t) => matched.has(t.task_id);
  return open
    .map((task) => {
      if (hit(task)) return task;
      const children = (task.children ?? []).filter(hit);
      return children.length ? { ...task, children } : null;
    })
    .filter(Boolean);
}

// Roving keyboard selection over the rows currently on the board.
let boardRows = []; // [{ task, row, text, dueBtn }] rebuilt on each render
let selectedId = null;

function selectedEntry() {
  return boardRows.find((r) => r.task.task_id === selectedId);
}

function setSelected(taskId, { scroll = true } = {}) {
  selectedId = taskId;
  for (const r of boardRows) {
    r.row.classList.toggle('selected', r.task.task_id === taskId);
  }
  if (scroll) selectedEntry()?.row.scrollIntoView({ block: 'nearest' });
}

function moveSelection(dir) {
  if (!boardRows.length) return;
  const i = boardRows.findIndex((r) => r.task.task_id === selectedId);
  const next =
    i < 0
      ? dir > 0
        ? 0
        : boardRows.length - 1
      : Math.min(boardRows.length - 1, Math.max(0, i + dir));
  setSelected(boardRows[next].task.task_id);
}

// Dragging a row onto a bucket header rewrites its due date.
let dragTaskId = null;
const DROP_DUE = {
  overdue: () => todayStr(),
  today: () => todayStr(),
  week: () => plusDays(7),
};

function wireDropTarget(header, key) {
  if (!(key in DROP_DUE) && key !== 'anytime') return;
  header.addEventListener('dragover', (e) => {
    if (!dragTaskId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    header.classList.add('drop');
  });
  header.addEventListener('dragleave', () => header.classList.remove('drop'));
  header.addEventListener('drop', (e) => {
    e.preventDefault();
    header.classList.remove('drop');
    const id = dragTaskId;
    dragTaskId = null;
    if (!id) return;
    const input =
      key === 'anytime'
        ? { task_id: id, clear_due: true }
        : { task_id: id, due_at: DROP_DUE[key]() };
    write('edit', input);
  });
}

function renderBoard(open, counts) {
  const board = $('board');
  board.innerHTML = '';
  boardRows = [];
  closePopover();
  const today = todayStr();
  const dueToday = open.filter((t) => t.due_at && String(t.due_at).slice(0, 10) <= today).length;
  $('subtitle').textContent =
    counts.open > 0
      ? `${counts.open} open · ${dueToday} due today or overdue`
      : 'Your canonical task list, from the vault.';

  const weekEnd = plusDays(7);
  const visible = applySearch(open);
  const groups = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const task of visible) groups.get(bucketFor(task, today, weekEnd)).push(task);

  let shown = 0;
  for (const { key, label } of BUCKETS) {
    if (!VIEW_BUCKETS[state.view].has(key)) continue;
    const tasks = groups.get(key);
    if (!tasks.length) continue;
    shown += tasks.length;
    const h = document.createElement('p');
    h.className = 'section-label muted small';
    h.dataset.bucket = key;
    h.textContent = `${label} · ${tasks.length}`;
    wireDropTarget(h, key);
    board.appendChild(h);
    for (const task of tasks) {
      board.appendChild(renderRow(task));
      for (const child of task.children ?? []) {
        board.appendChild(renderRow(child, { subtask: true }));
      }
    }
  }

  const empty = $('empty');
  if (open.length === 0) {
    empty.textContent = 'Nothing to do — enjoy your day.';
    empty.hidden = false;
  } else if (shown === 0) {
    empty.textContent = state.search.trim()
      ? 'No tasks match your search.'
      : 'Nothing in this view.';
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  // The window is honest about its edge: the board shows the newest open
  // tasks, "Show more" grows the slice, search reaches everything beyond it.
  if (boardTruncated && !state.search.trim()) {
    const footer = document.createElement('div');
    footer.className = 'window-footer';
    const label = document.createElement('span');
    const windowSize = lastData?.window ?? boardWindow;
    label.textContent = `Showing your newest ${windowSize} open tasks — the rest are a search away. `;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost';
    more.textContent = 'Show more';
    more.addEventListener('click', async () => {
      boardWindow += 500;
      more.disabled = true;
      await refresh();
    });
    footer.append(label, more);
    board.appendChild(footer);
  }

  if (selectedId && !selectedEntry()) selectedId = null;
  if (selectedId) setSelected(selectedId, { scroll: false });
}

// ---------- The logbook (closed top-level tasks) ----------

function renderLogbook(logbook) {
  // The logbook consumes the same vault match set as the board — one search,
  // both sides of the app.
  let visible = logbook;
  if (state.search.trim()) {
    const matched = new Set((searchResults ?? []).map((t) => t.task_id));
    visible = logbook.filter((t) => matched.has(t.task_id));
  }
  const details = $('logbook');
  details.hidden = visible.length === 0;
  $('logbookCount').textContent = visible.length ? `· ${visible.length}` : '';
  const list = $('logbookList');
  list.innerHTML = '';
  for (const task of visible) {
    list.appendChild(renderRow(task, { closed: true }));
  }
}

// ---------- Popovers (one shared host: reschedule, priority, effort & notes) ----------

let popoverEl = null;
let popoverCleanup = null; // teardown for the open popover (e.g. detach a mention field)

function closePopover() {
  popoverCleanup?.();
  popoverCleanup = null;
  popoverEl?.remove();
  popoverEl = null;
}

function openPopover(anchor, build) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  build(pop);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  });
  document.body.appendChild(pop);
  popoverEl = pop;
  const r = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - pop.offsetWidth - 8),
  );
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + window.scrollY + 6}px`;
  pop.querySelector('input, select, button')?.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (popoverEl && !popoverEl.contains(e.target)) closePopover();
});

// The reschedule popover: Things' "When" — presets plus an exact date.
function openDuePopover(anchor, task) {
  openPopover(anchor, (pop) => {
    const label = document.createElement('span');
    label.className = 'pop-label';
    label.textContent = 'When';
    pop.appendChild(label);
    const presets = document.createElement('div');
    presets.className = 'pop-row';
    const preset = (text, input) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        closePopover();
        write('edit', { task_id: task.task_id, ...input });
      });
      presets.appendChild(btn);
    };
    preset('Today', { due_at: todayStr() });
    preset('Tomorrow', { due_at: plusDays(1) });
    preset('Next week', { due_at: plusDays(7) });
    if (task.due_at) preset('Clear', { clear_due: true });
    pop.appendChild(presets);
    const date = document.createElement('input');
    date.type = 'date';
    date.setAttribute('aria-label', 'Due date');
    if (task.due_at) date.value = String(task.due_at).slice(0, 10);
    date.addEventListener('change', () => {
      if (!date.value) return;
      closePopover();
      write('edit', { task_id: task.task_id, due_at: date.value });
    });
    pop.appendChild(date);
  });
}

// The details popover: change priority, estimated effort and notes after
// creation. Notes stay out of the quick-add bar (Things-style) — this is
// where they live; an emptied textarea becomes the explicit
// clear_description intent.
function openEditPopover(anchor, task) {
  openPopover(anchor, (pop) => {
    const prioLabel = document.createElement('label');
    prioLabel.className = 'pop-label';
    prioLabel.textContent = 'Priority';
    const sel = document.createElement('select');
    for (const [value, text] of [
      ['0', 'No priority'],
      ['1', 'High'],
      ['5', 'Medium'],
      ['9', 'Low'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
    }
    const p = Number(task.priority ?? 0);
    sel.value = p <= 0 ? '0' : p <= 3 ? '1' : p <= 6 ? '5' : '9';
    prioLabel.appendChild(sel);
    pop.appendChild(prioLabel);

    const effortLabel = document.createElement('label');
    effortLabel.className = 'pop-label';
    effortLabel.textContent = 'Effort (min)';
    const eff = document.createElement('input');
    eff.type = 'number';
    eff.min = '1';
    eff.step = '1';
    eff.placeholder = 'Est. min';
    if (task.effort_min) eff.value = String(task.effort_min);
    effortLabel.appendChild(eff);
    pop.appendChild(effortLabel);

    const notesLabel = document.createElement('label');
    notesLabel.className = 'pop-label';
    notesLabel.textContent = 'Notes';
    const notes = document.createElement('textarea');
    notes.rows = 3;
    notes.placeholder = 'Add a note… (@ to mention, ⌘↵ saves)';
    notes.setAttribute('aria-label', 'Notes');
    if (task.description) notes.value = String(task.description);
    notesLabel.appendChild(notes);
    pop.appendChild(notesLabel);

    // @-mentions on the note (issues #272 + #282): the kit field owns the
    // popover, the pick→insert→assert, and (on save) the reconcile. The
    // reference strip is the durable home; a note has no read-view render, so
    // the strip is where a reference shows.
    const refsOf = () => (task.references ||= []);
    const strip = document.createElement('div');
    strip.className = 'kit-ref-strip pop-refs';
    const renderStrip = () =>
      renderReferenceStrip(strip, refsOf(), {
        inlineIds: inlineLinkIds(notes.value, refsOf()),
        onRemove: async (ref) => {
          const outcome = await removeReference(ref.link_id);
          if (outcome?.status === 'executed') {
            task.references = refsOf().filter((r) => r.link_id !== ref.link_id);
          }
          renderStrip();
        },
      });
    const field = attachMentionField(notes, {
      from: () => ({ type: 'schedule.task', id: task.task_id }),
      references: refsOf,
      onChange: renderStrip,
    });
    popoverCleanup = field.detach;
    pop.appendChild(strip);
    renderStrip();

    const mention = document.createElement('button');
    mention.type = 'button';
    mention.className = 'pop-mention';
    mention.textContent = '＋ Mention';
    mention.addEventListener('click', () => field.startMention());
    pop.appendChild(mention);

    const doSave = async () => {
      const input = { task_id: task.task_id, priority: Number(sel.value) };
      const minutes = Number(eff.value);
      if (minutes > 0) input.effort_min = Math.round(minutes);
      // Notes: send only what changed — a new text sets, an emptied
      // textarea clears; untouched notes stay out of the command.
      const note = notes.value.trim();
      const prev = String(task.description ?? '');
      const changed = (note && note !== prev) || (!note && prev);
      if (note && note !== prev) input.description = note;
      if (!note && prev) input.clear_description = true;
      const subject = { type: 'schedule.task', id: task.task_id };
      const references = refsOf();
      closePopover();
      await write('edit', input);
      // The saved note is the settled text — reconcile the anchors against it
      // (re-baseline live selectors, retract orphaned mentions with Undo),
      // then re-read so the board reflects any retraction.
      if (changed) {
        await field.reconcile(note, { from: subject, references });
        await refresh();
      }
    };

    // Keyboard flow inside the textarea: Cmd/Ctrl+Enter saves (Escape
    // already closes via the popover's own handler).
    notes.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        doSave();
      }
    });

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'pop-save';
    save.textContent = 'Save';
    save.addEventListener('click', doSave);
    pop.appendChild(save);
  });
}

// ---------- Completing and cancelling, with an undo window ----------

async function completeTask(task, row, circle) {
  const prev = task.status;
  if (!REDUCED_MOTION.matches && row && circle) {
    circle.textContent = '✓';
    row.classList.add('completing');
    await delay(450);
  }
  const outcome = await write('set-status', { task_id: task.task_id, status: 'completed' });
  if (outcome?.status === 'executed') {
    toast(`Completed “${task.title}”`, {
      undoLabel: 'Undo',
      onUndo: () => write('set-status', { task_id: task.task_id, status: prev }),
    });
  } else {
    row?.classList.remove('completing');
  }
}

async function cancelTask(task) {
  const prev = task.status;
  const outcome = await write('set-status', { task_id: task.task_id, status: 'cancelled' });
  if (outcome?.status === 'executed') {
    toast(`Cancelled “${task.title}”`, {
      undoLabel: 'Undo',
      onUndo: () => write('set-status', { task_id: task.task_id, status: prev }),
    });
  }
}

// ---------- One task row ----------

// Render a vault search snippet from text nodes only — the ⟦…⟧ hit markers
// the vault returns become <mark>, and task text never parses as HTML.
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

// A clean inline-SVG "text lines" marker for rows that carry a note — no
// emoji, inherits currentColor so themes and hover states just work.
const NOTE_GLYPH_SVG =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M1.5 2.5h9M1.5 6h9M1.5 9.5h5.5"/></svg>';

function renderRow(task, { subtask = false, closed = false } = {}) {
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
  circle.addEventListener('click', () => {
    if (isDone) {
      write('set-status', { task_id: task.task_id, status: 'needs-action' });
    } else {
      completeTask(task, row, circle);
    }
  });

  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = task.title;
  if (!closed) {
    text.title = 'Click to rename';
    text.addEventListener('click', () => beginRename(row, text, task));
  }

  // The title column: the title line (title + note glyph when the task
  // carries one), with the note's first line beneath it, muted and truncated.
  const main = document.createElement('span');
  main.className = 'row-main';
  const titleLine = document.createElement('span');
  titleLine.className = 'row-title-line';
  titleLine.appendChild(text);
  main.appendChild(titleLine);
  const note = String(task.description ?? '').trim();
  if (note) {
    let glyph;
    if (closed) {
      glyph = document.createElement('span');
    } else {
      glyph = document.createElement('button');
      glyph.type = 'button';
      glyph.title = 'Notes';
      glyph.setAttribute('aria-label', `Notes for “${task.title}”`);
      glyph.addEventListener('click', () => openEditPopover(glyph, task));
    }
    glyph.className = 'note-glyph';
    glyph.innerHTML = NOTE_GLYPH_SVG;
    titleLine.appendChild(glyph);
  }
  // A vault match carries its own snippet, already centered on the hit —
  // while a term is active it takes the note line's place.
  const snippet = searchSnippets?.get(task.task_id);
  if (snippet || note) {
    const noteLine = document.createElement('span');
    noteLine.className = 'row-note';
    if (snippet) snippetInto(noteLine, snippet);
    else noteLine.textContent = note.split('\n')[0];
    main.appendChild(noteLine);
  }

  row.append(circle, main);

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

  let dueBtn = null;
  if (!closed) {
    // Every open row can be rescheduled in place — dated rows show the date,
    // undated ones a quiet "＋ date" that appears on hover (always on touch).
    dueBtn = document.createElement('button');
    dueBtn.type = 'button';
    if (task.due_at) {
      const overdue = String(task.due_at).slice(0, 10) < todayStr();
      dueBtn.className = `due-btn${overdue ? ' overdue' : ''}`;
      dueBtn.textContent = fmtDay(task.due_at);
    } else {
      dueBtn.className = 'due-btn due-add';
      dueBtn.textContent = '＋ date';
    }
    dueBtn.title = 'Reschedule';
    dueBtn.setAttribute('aria-label', `Reschedule “${task.title}”`);
    dueBtn.addEventListener('click', () => openDuePopover(dueBtn, task));
    row.appendChild(dueBtn);
  } else {
    if (task.due_at) row.appendChild(chip('row-due muted small', fmtDay(task.due_at)));
    if (task.completed_at) row.appendChild(chip('row-due muted small', fmtDay(task.completed_at)));
  }

  if (!closed) {
    row.appendChild(rowActions(task, subtask));
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragTaskId = task.task_id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.task_id);
    });
    row.addEventListener('dragend', () => {
      dragTaskId = null;
    });
    row.addEventListener('pointerdown', () => setSelected(task.task_id, { scroll: false }));
    boardRows.push({ task, row, text, dueBtn });
  }

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

// Hover affordances: start/pause, add-subtask (top level only), details,
// attach, cancel. Visible at reduced opacity on touch devices.
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

  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'ghost';
  info.textContent = 'ⓘ';
  info.title = 'Edit priority, effort and notes';
  info.setAttribute('aria-label', 'Edit priority, effort and notes');
  info.addEventListener('click', () => openEditPopover(info, task));
  wrap.appendChild(info);

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
  cancel.addEventListener('click', () => {
    // Destructive-feeling: first click arms, second confirms.
    if (armConfirm(cancel, { armedLabel: 'Sure?' })) cancelTask(task);
  });
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

// ---------- Natural-language dates in quick-add ----------
// A trailing token in the title ("tomorrow", "fri", "jul 12", "+3d") becomes
// the due date, previewed live before submit. The explicit date input always
// wins; when it is set the title is left untouched.

const NL_WEEKDAYS = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const NL_MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseNlDue(title) {
  const t = String(title).trim();
  let m = t.match(/^(.*\S)\s+\+(\d{1,3})([dw])$/i);
  if (m) {
    const n = Number(m[2]) * (m[3].toLowerCase() === 'w' ? 7 : 1);
    return { clean: m[1], due: plusDays(n), token: `+${m[2]}${m[3]}` };
  }
  m = t.match(/^(.*\S)\s+(today|tod|tomorrow|tmr|tom)$/i);
  if (m) {
    const w = m[2].toLowerCase();
    const due = w === 'today' || w === 'tod' ? todayStr() : plusDays(1);
    return { clean: m[1], due, token: m[2] };
  }
  m = t.match(/^(.*\S)\s+([a-z]{3,9})$/i);
  if (m && NL_WEEKDAYS[m[2].toLowerCase()] !== undefined) {
    const target = NL_WEEKDAYS[m[2].toLowerCase()];
    const diff = (target - new Date().getDay() + 7) % 7 || 7;
    return { clean: m[1], due: plusDays(diff), token: m[2] };
  }
  m = t.match(/^(.*\S)\s+([a-z]{3,9})\s+(\d{1,2})$/i);
  if (m && NL_MONTHS[m[2].toLowerCase()] !== undefined) {
    const now = new Date();
    const day = Number(m[3]);
    if (day < 1 || day > 31) return null;
    const d = new Date(now.getFullYear(), NL_MONTHS[m[2].toLowerCase()], day, 12);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d < startOfToday) d.setFullYear(d.getFullYear() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      clean: m[1],
      due: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      token: `${m[2]} ${m[3]}`,
    };
  }
  return null;
}

function updateNlPreview() {
  const el = $('nlPreview');
  const parsed = $('dueInput').value ? null : parseNlDue($('titleInput').value);
  if (!parsed) {
    el.hidden = true;
    return;
  }
  el.textContent = `→ due ${fmtDay(parsed.due)} (“${parsed.token}” leaves the title)`;
  el.hidden = false;
}

// ---------- Quick add ----------

$('parentClear').addEventListener('click', () => {
  parentContext = null;
  $('parentChip').hidden = true;
});

$('titleInput').addEventListener('input', updateNlPreview);
$('dueInput').addEventListener('change', updateNlPreview);

$('quickAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('titleInput').value.trim();
  if (!raw) return;
  const parsed = $('dueInput').value ? null : parseNlDue(raw);
  const input = { title: parsed ? parsed.clean : raw };
  const due = $('dueInput').value || parsed?.due;
  if (due) input.due_at = due;
  const priority = Number($('prioInput').value);
  if (priority > 0) input.priority = priority;
  const effort = Number($('effortInput').value);
  if (effort > 0) input.effort_min = Math.round(effort);
  if (parentContext) input.parent_task_id = parentContext.task_id;
  await write('add', input);
  $('titleInput').value = '';
  $('effortInput').value = '';
  updateNlPreview();
  $('titleInput').focus();
});

// ---------- Quick find + view switcher ----------

// Quick find asks the vault, not a local copy: the FTS5 index matches over
// every task (title + description) inside SQLite and returns only the hits,
// so the app never greps an unbounded table in memory. `searchSeq` drops
// stale replies when the owner types faster than the vault answers.
let searchSeq = 0;
const applySearchInput = debounce(async () => {
  const raw = $('searchInput').value.trim();
  state.search = raw;
  if (!raw) {
    searchResults = null;
    searchSnippets = null;
    render();
    return;
  }
  const seq = ++searchSeq;
  let rows = [];
  try {
    const data = await window.centraid.read({ query: 'search', input: { term: raw } });
    rows = data?.tasks ?? [];
  } catch {
    rows = [];
  }
  if (seq !== searchSeq) return;
  searchResults = rows;
  searchSnippets = new Map(rows.filter((t) => t.snippet).map((t) => [t.task_id, t.snippet]));
  render();
}, 120);
$('searchInput').addEventListener('input', applySearchInput);

$('viewSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  for (const b of $('viewSwitch').querySelectorAll('button')) {
    const on = b === btn;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  render();
});

// ---------- Keyboard shortcuts ----------

// `n` quick-add, `/` or `f` search, ↑/↓ roving selection, `e` rename,
// space complete, `d` reschedule, Escape closes popover / clears context.
// Inline-rename keys live on the rename input itself; nothing fires while
// typing in an input.
document.addEventListener('keydown', (e) => {
  const typing =
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (popoverEl) {
      closePopover();
      return;
    }
    if (typing && e.target === $('searchInput')) {
      e.target.value = '';
      state.search = '';
      searchResults = null;
      searchSnippets = null;
      render();
      e.target.blur();
      return;
    }
    if (!typing && parentContext) {
      parentContext = null;
      $('parentChip').hidden = true;
    }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n') {
    e.preventDefault();
    $('titleInput').focus();
  } else if (e.key === '/' || e.key === 'f') {
    e.preventDefault();
    $('searchInput').focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'e') {
    const entry = selectedEntry();
    if (entry) {
      e.preventDefault();
      beginRename(entry.row, entry.text, entry.task);
    }
  } else if (e.key === ' ') {
    const entry = selectedEntry();
    if (entry) {
      e.preventDefault();
      completeTask(entry.task, entry.row, entry.row.querySelector('.circle'));
    }
  } else if (e.key === 'd') {
    const entry = selectedEntry();
    if (entry?.dueBtn) {
      e.preventDefault();
      openDuePopover(entry.dueBtn, entry.task);
    }
  }
});

// One hidden file input serves the whole board; the per-row attach button
// sets attachTarget just before triggering it.
wireAttachInput($('attachInput'), () => attachTarget);

window.addEventListener('focus', refresh);
showSkeleton($('board'), 6);
refresh();
