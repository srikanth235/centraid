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
  closePopover,
  debounce,
  inlineLinkIds,
  isPopoverOpen,
  localDayKey,
  openPopover,
  outcomeMessage,
  readFailed,
  removeReference,
  renderAttachments,
  renderReferenceStrip,
  showSkeleton,
  snippetInto,
  toast,
  wireAttachInput,
} from './kit.js';
// Aliased: the app already has a module-level `render()` orchestrator
// (re-renders the board + logbook from `lastData`); `litRender` is Lit's
// standalone DOM-commit function used to drive the two list containers and
// the popover boxes (kit-owned containers, per the app's Lit conventions).
import { createRef, html, nothing, ref, render as litRender, repeat, svg } from './lit-core.min.js';

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
  return localDayKey(new Date());
}

function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDayKey(d);
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

// ---------- Attachments (kit renderAttachments / wireAttachInput) ----------
// The task a click on a row's attach button will pin the next file onto. One
// hidden file input is shared across the whole board; the button sets this.
let attachTarget = null;

async function removeAttachment(attachmentId) {
  const outcome = await act('detach', { attachment_id: attachmentId });
  if (narrate(outcome) || outcome?.status === 'denied') await refresh();
  return outcome;
}

// The board window: the board query reads only this many newest open tasks
// (the logbook read is capped at its visible 50). "Show more" grows it;
// search reaches the rest through the vault's FTS index.
let boardWindow = 500;
let boardTruncated = false;

// `#board` starts out holding the kit's raw (non-Lit) skeleton markup
// (`showSkeleton`, below). Lit's standalone `render()` never clears a
// container's pre-existing children on its first call into it — it only
// appends past them — so the very first Lit commit into `#board` must clear
// that skeleton itself; every commit after that must go through `litRender`
// alone (a raw clear once Lit owns the container corrupts its part cache).
let boardMounted = false;
function mountBoard(templateResult) {
  const board = $('board');
  if (!boardMounted) {
    board.replaceChildren();
    boardMounted = true;
  }
  litRender(templateResult, board);
}

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
    mountBoard(nothing);
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

function renderBoard(open, counts) {
  closePopover();
  const today = todayStr();
  const dueToday = open.filter((t) => t.due_at && String(t.due_at).slice(0, 10) <= today).length;
  $('subtitle').textContent =
    counts.open > 0
      ? `${counts.open} open · ${dueToday} due today or overdue`
      : 'Your canonical task list, from the vault.';

  const weekEnd = plusDays(7);
  const visible = applySearch(open);
  const grouped = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const task of visible) grouped.get(bucketFor(task, today, weekEnd)).push(task);

  // Groups feed the template; flatOrder mirrors the exact order the template
  // will emit `.row` elements in, so it can be zipped with the post-render
  // DOM query below to rebuild `boardRows`.
  let shown = 0;
  const groups = [];
  const flatOrder = [];
  for (const { key, label } of BUCKETS) {
    if (!VIEW_BUCKETS[state.view].has(key)) continue;
    const tasks = grouped.get(key);
    if (!tasks.length) continue;
    shown += tasks.length;
    groups.push({ key, label, tasks });
    for (const task of tasks) {
      flatOrder.push(task);
      for (const child of task.children ?? []) flatOrder.push(child);
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
  const footer =
    boardTruncated && !state.search.trim() ? { windowSize: lastData?.window ?? boardWindow } : null;

  mountBoard(boardTemplate(groups, footer));

  const rowEls = [...$('board').querySelectorAll('.row[data-task-id]')];
  boardRows = flatOrder.map((task, i) => {
    const row = rowEls[i];
    return {
      task,
      row,
      text: row?.querySelector('.row-text'),
      dueBtn: row?.querySelector('.due-btn'),
    };
  });

  if (selectedId && !selectedEntry()) selectedId = null;
  if (selectedId) setSelected(selectedId, { scroll: false });
}

/** Bucket header + its rows (open board only — the logbook has no buckets). */
function boardTemplate(groups, footer) {
  return html`${groups.map(
    (g) => html`<p
        class="section-label muted small"
        data-bucket=${g.key}
        @dragover=${(e) => {
          if (!(g.key in DROP_DUE) && g.key !== 'anytime') return;
          if (!dragTaskId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          e.currentTarget.classList.add('drop');
        }}
        @dragleave=${(e) => e.currentTarget.classList.remove('drop')}
        @drop=${(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('drop');
          const id = dragTaskId;
          dragTaskId = null;
          if (!id) return;
          const input =
            g.key === 'anytime'
              ? { task_id: id, clear_due: true }
              : { task_id: id, due_at: DROP_DUE[g.key]() };
          write('edit', input);
        }}
      >
        ${g.label} · ${g.tasks.length}
      </p>
      ${repeat(
        g.tasks,
        (t) => t.task_id,
        (t) =>
          html`${taskRowTpl(t)}${(t.children ?? []).map((c) => taskRowTpl(c, { subtask: true }))}`,
      )}`,
  )}${footer
    ? html`<div class="window-footer">
        <span
          >Showing your newest ${footer.windowSize} open tasks — the rest are a search away.
        </span>
        <button
          type="button"
          class="kit-btn"
          @click=${async (e) => {
            e.target.disabled = true;
            boardWindow += 500;
            await refresh();
          }}
        >
          Show more
        </button>
      </div>`
    : nothing}`;
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
  litRender(
    html`${repeat(
      visible,
      (t) => t.task_id,
      (t) => taskRowTpl(t, { closed: true }),
    )}`,
    $('logbookList'),
  );
}

// ---------- Popovers (kit openPopover: reschedule, priority, effort & notes) ----------

// Both of tasks' popovers are little forms, not menus: focus the first field,
// announce as a dialog, and let `.t-pop` carry the app's width/spacing deltas
// on top of the kit surface. `onClose` tears down document-level helpers
// (the details popover's mention field) on any close path.
function openTaskPopover(anchor, build, { onClose } = {}) {
  openPopover(anchor, build, { focus: true, className: 't-pop', role: 'dialog', onClose });
}

// The reschedule popover: Things' "When" — presets plus an exact date.
function openDuePopover(anchor, task) {
  openTaskPopover(anchor, (pop) => {
    const presets = [
      ['Today', { due_at: todayStr() }],
      ['Tomorrow', { due_at: plusDays(1) }],
      ['Next week', { due_at: plusDays(7) }],
    ];
    if (task.due_at) presets.push(['Clear', { clear_due: true }]);
    litRender(
      html`
        <span class="pop-label">When</span>
        <div class="pop-row">
          ${presets.map(
            ([label, input]) => html`<button
              type="button"
              class="kit-btn"
              @click=${() => {
                closePopover();
                write('edit', { task_id: task.task_id, ...input });
              }}
            >
              ${label}
            </button>`,
          )}
        </div>
        <input
          type="date"
          aria-label="Due date"
          .value=${task.due_at ? String(task.due_at).slice(0, 10) : ''}
          @change=${(e) => {
            if (!e.target.value) return;
            closePopover();
            write('edit', { task_id: task.task_id, due_at: e.target.value });
          }}
        />
      `,
      pop,
    );
  });
}

// The details popover: change priority, estimated effort and notes after
// creation. Notes stay out of the quick-add bar (Things-style) — this is
// where they live; an emptied textarea becomes the explicit
// clear_description intent.
function openEditPopover(anchor, task) {
  let detachMention = null;
  openTaskPopover(
    anchor,
    (pop) => {
      const priorityOptions = [
        ['0', 'No priority'],
        ['1', 'High'],
        ['5', 'Medium'],
        ['9', 'Low'],
      ];
      const p = Number(task.priority ?? 0);
      const currentPriority = p <= 0 ? '0' : p <= 3 ? '1' : p <= 6 ? '5' : '9';

      const selRef = createRef();
      const effRef = createRef();
      const notesRef = createRef();
      const stripRef = createRef();
      // Assigned once the form is built (below); the template's own click/
      // keydown handlers close over this binding and only ever invoke it
      // after the whole synchronous build has finished.
      let doSave = () => {};

      // A one-time build (the popover isn't re-rendered reactively while
      // open), so plain initial-value bindings suffice — no live().
      litRender(
        html`
          <label class="pop-label"
            >Priority
            <select ${ref(selRef)}>
              ${priorityOptions.map(
                ([value, text]) =>
                  html`<option value=${value} ?selected=${value === currentPriority}>
                    ${text}
                  </option>`,
              )}
            </select></label
          >
          <label class="pop-label"
            >Effort (min)
            <input
              ${ref(effRef)}
              type="number"
              min="1"
              step="1"
              placeholder="Est. min"
              .value=${task.effort_min ? String(task.effort_min) : ''}
          /></label>
          <label class="pop-label"
            >Notes
            <textarea
              ${ref(notesRef)}
              rows="3"
              placeholder="Add a note… (@ to mention, ⌘↵ saves)"
              aria-label="Notes"
              .value=${task.description ? String(task.description) : ''}
              @keydown=${(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  doSave();
                }
              }}
            ></textarea>
          </label>
          <div class="kit-ref-strip pop-refs" ${ref(stripRef)}></div>
          <button type="button" class="pop-mention" @click=${() => field.startMention()}>
            ＋ Mention
          </button>
          <button type="button" class="kit-btn primary" @click=${() => doSave()}>Save</button>
        `,
        pop,
      );

      const sel = selRef.value;
      const eff = effRef.value;
      const notes = notesRef.value;
      const strip = stripRef.value;

      // @-mentions on the note (issues #272 + #282): the kit field owns the
      // popover, the pick→insert→assert, and (on save) the reconcile. The
      // reference strip is the durable home; a note has no read-view render, so
      // the strip is where a reference shows.
      const refsOf = () => (task.references ||= []);
      const renderStrip = () =>
        renderReferenceStrip(strip, refsOf(), {
          inlineIds: inlineLinkIds(notes.value, refsOf()),
          onRemove: async (r) => {
            const outcome = await removeReference(r.link_id);
            if (outcome?.status === 'executed') {
              task.references = refsOf().filter((x) => x.link_id !== r.link_id);
            }
            renderStrip();
          },
        });
      const field = attachMentionField(notes, {
        from: () => ({ type: 'schedule.task', id: task.task_id }),
        references: refsOf,
        onChange: renderStrip,
      });
      detachMention = field.detach;
      renderStrip();

      doSave = async () => {
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
    },
    { onClose: () => detachMention?.() },
  );
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

// A clean inline-SVG "text lines" marker for rows that carry a note — no
// emoji, inherits currentColor so themes and hover states just work.
const NOTE_GLYPH_PATH = svg`<path d="M1.5 2.5h9M1.5 6h9M1.5 9.5h5.5"/>`;
function noteGlyphSvg() {
  return html`<svg
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    aria-hidden="true"
  >
    ${NOTE_GLYPH_PATH}
  </svg>`;
}

function fmtEffort(min) {
  const n = Number(min);
  if (n >= 60) return n % 60 === 0 ? `${n / 60}h` : `${Math.floor(n / 60)}h${n % 60}`;
  return `${n}m`;
}

/**
 * One task row (+ its attachment strip, when it carries files) as a Lit
 * template. Kept as a plain function — not a component — so `.row` elements
 * stay DIRECT siblings inside `#board`/`#logbookList`: app.css leans on that
 * flat adjacency (`.row:hover + .row`, `.row:last-child`), which a per-row
 * custom element would break.
 */
function taskRowTpl(task, { subtask = false, closed = false } = {}) {
  const isDone = !OPEN_STATUSES.has(task.status);
  const note = String(task.description ?? '').trim();
  const snippet = searchSnippets?.get(task.task_id);
  const overdue = Boolean(task.due_at && String(task.due_at).slice(0, 10) < todayStr());
  const level = task.priority <= 3 ? 'high' : task.priority <= 6 ? 'medium' : 'low';

  return html`<div
      class=${subtask ? 'row subtask' : 'row'}
      data-status=${task.status}
      data-done=${String(isDone)}
      data-task-id=${task.task_id}
      draggable=${closed ? nothing : 'true'}
      @dragstart=${(e) => {
        if (closed) return;
        dragTaskId = task.task_id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.task_id);
      }}
      @dragend=${() => {
        if (closed) return;
        dragTaskId = null;
      }}
      @pointerdown=${() => {
        if (closed) return;
        setSelected(task.task_id, { scroll: false });
      }}
    >
      <button
        type="button"
        class="circle"
        data-on=${String(task.status === 'completed')}
        title=${isDone ? 'Reopen' : 'Complete'}
        aria-label=${isDone ? 'Reopen' : 'Complete'}
        @click=${(e) => {
          if (isDone) {
            write('set-status', { task_id: task.task_id, status: 'needs-action' });
          } else {
            completeTask(task, e.currentTarget.closest('.row'), e.currentTarget);
          }
        }}
      >
        ${task.status === 'completed' ? '✓' : task.status === 'cancelled' ? '✕' : nothing}
      </button>

      <span class="row-main">
        <span class="row-title-line">
          <span
            class="row-text"
            title=${closed ? nothing : 'Click to rename'}
            @click=${(e) => {
              if (closed) return;
              beginRename(e.currentTarget.closest('.row'), e.currentTarget, task);
            }}
            >${task.title}</span
          >${note
            ? closed
              ? html`<span class="note-glyph">${noteGlyphSvg()}</span>`
              : html`<button
                  type="button"
                  class="note-glyph"
                  title="Notes"
                  aria-label="Notes for “${task.title}”"
                  @click=${(e) => openEditPopover(e.currentTarget, task)}
                >
                  ${noteGlyphSvg()}
                </button>`
            : nothing}
        </span>
        ${snippet || note
          ? html`<span
              class="row-note"
              ${ref((el) => {
                if (!el) return;
                el.replaceChildren();
                if (snippet) snippetInto(el, snippet);
                else el.textContent = note.split('\n')[0];
              })}
            ></span>`
          : nothing}
      </span>

      ${task.status === 'in-process' ? html`<span class="badge doing">in progress</span>` : nothing}
      ${task.priority >= 1 ? html`<span class="badge flag ${level}">⚑</span>` : nothing}
      ${task.effort_min
        ? html`<span class="badge muted small">${fmtEffort(task.effort_min)}</span>`
        : nothing}
      ${task.rrule ? html`<span class="badge muted small">↻</span>` : nothing}
      ${!closed && task.children?.length
        ? html`<span class="badge muted small">${task.done_children}/${task.children.length}</span>`
        : nothing}
      ${!closed
        ? html`<button
            type="button"
            class=${task.due_at ? `due-btn${overdue ? ' overdue' : ''}` : 'due-btn due-add'}
            title="Reschedule"
            aria-label="Reschedule “${task.title}”"
            @click=${(e) => openDuePopover(e.currentTarget, task)}
          >
            ${task.due_at ? fmtDay(task.due_at) : '＋ date'}
          </button>`
        : html`${task.due_at
            ? html`<span class="row-due muted small">${fmtDay(task.due_at)}</span>`
            : nothing}${task.completed_at
            ? html`<span class="row-due muted small">${fmtDay(task.completed_at)}</span>`
            : nothing}`}
      ${!closed ? rowActionsTpl(task, subtask) : nothing}
    </div>
    ${task.attachments?.length
      ? html`<div
          class=${subtask
            ? 'kit-attach-strip row-attachments subtask'
            : 'kit-attach-strip row-attachments'}
          ${ref((el) => {
            if (el) renderAttachments(el, task.attachments, closed ? null : removeAttachment);
          })}
        ></div>`
      : nothing}`;
}

// Hover affordances: start/pause, add-subtask (top level only), details,
// attach, cancel. Visible at reduced opacity on touch devices.
function rowActionsTpl(task, subtask) {
  const inProcess = task.status === 'in-process';
  return html`<span class="row-actions">
    <button
      type="button"
      class="kit-btn"
      title=${inProcess ? 'Back to To Do' : 'Mark in progress'}
      @click=${() =>
        write('set-status', {
          task_id: task.task_id,
          status: inProcess ? 'needs-action' : 'in-process',
        })}
    >
      ${inProcess ? 'pause' : 'start'}
    </button>
    ${!subtask
      ? html`<button
          type="button"
          class="kit-btn"
          title="Add a subtask"
          @click=${() => {
            parentContext = { task_id: task.task_id, title: task.title };
            $('parentChip').hidden = false;
            $('parentChipText').textContent = `Subtask of “${task.title}”`;
            $('titleInput').focus();
          }}
        >
          +sub
        </button>`
      : nothing}
    <button
      type="button"
      class="kit-btn"
      title="Edit priority, effort and notes"
      aria-label="Edit priority, effort and notes"
      @click=${(e) => openEditPopover(e.currentTarget, task)}
    >
      ⓘ
    </button>
    <button
      type="button"
      class="kit-btn"
      title="Attach a file"
      aria-label="Attach a file"
      @click=${() => {
        attachTarget = task.task_id;
        $('attachInput').click();
      }}
    >
      ⎘
    </button>
    <button
      type="button"
      class="kit-btn danger"
      title="Cancel this task"
      @click=${(e) => {
        // Destructive-feeling: first click arms, second confirms.
        if (armConfirm(e.currentTarget, { armedLabel: 'Sure?' })) cancelTask(task);
      }}
    >
      ✕
    </button>
  </span>`;
}

// Inline rename: the title swaps for an input; Enter saves, Esc cancels. Kept
// as a small imperative island (not Lit-templated): it mutates the row's live
// DOM directly, same as the kit's own node-mutating helpers.
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
    // Escape pressed INSIDE the popover never reaches here (the kit box stops
    // propagation and closes itself); this only catches a stray Escape while
    // a popover is open but focus sits elsewhere on the page.
    if (isPopoverOpen()) {
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
wireAttachInput($('attachInput'), () => attachTarget, { act, narrate, notice, refresh });

window.addEventListener('focus', refresh);
showSkeleton($('board'), 6);
refresh();
