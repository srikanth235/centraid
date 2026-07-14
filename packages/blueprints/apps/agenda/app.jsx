// Agenda — a Google-Calendar-bar reinvention that is still a pure projection
// over the personal vault. Every event rendered here lives in core.event;
// every mutation is a typed vault command (schedule.propose_event /
// reschedule_event / respond_rsvp / cancel_event, core.attach/detach) routed
// through this app's action handlers, consent-checked and receipted. The
// app's own data.sqlite stays empty by design: revoke the grant and this
// page goes dark while the model, history and receipts remain the owner's.
//
// React port: module-level `state`/`data` (mutated in place, never
// reassigned) plus a `render()` orchestrator fanning out to one React root
// per stable container — the same docs/tasks/notes pattern. `logic.js` holds
// the non-visual business logic (vault IO, calendar coloring, activity log,
// parked-write tracking, search); `format.js` the pure date/range/bucketing
// helpers; `chrome.js` wires the drawer/keyboard/resize listeners.
// `components/` holds pure functions of props.
import { createRoot } from './react-core.min.js';
import {
  closePopover,
  h,
  onDataChange,
  openPopover,
  readFailed,
  showSkeleton,
  wireAttachInput,
} from './kit.js';
import { createLogic } from './logic.js';
import { wireChrome } from './chrome.js';
import {
  bucketByDay,
  fmtDay,
  monthGridRange,
  nextRoundHourOn,
  scheduleFrom,
  segTimeText,
  startOfWeek,
  weekRange,
} from './format.js';
import { CalendarList, MiniMonth } from './components/Sidebar.jsx';
import { HeaderBar } from './components/HeaderBar.jsx';
import { MonthView } from './components/MonthView.jsx';
import { WeekView } from './components/WeekView.jsx';
import { ScheduleView } from './components/ScheduleView.jsx';
import { EventDrawer } from './components/EventDrawer.jsx';
import { CreateModal } from './components/CreateModal.jsx';

const $ = (id) => document.getElementById(id);

// Vault entities this app's queries read — the doorbell filter re-derives
// only when a change names one of these (or names none, i.e. "this app acted").
const CHANGE_TABLES = [
  'core.event',
  'schedule.event_ext',
  'schedule.attendee',
  'schedule.calendar',
  'core.party',
  'core.attachment',
  'core.content_item',
  'core.vault',
];

// ---------- State ----------
// The last successful reads (never reassigned — mutated in place so logic.js's
// closure over `data` stays valid) and all client-side presentation state,
// which is never persisted and never sent to the vault.

const validViews = new Set(['month', 'week', 'schedule']);
const knobView = document.documentElement.getAttribute('data-app-default-view');

const data = { events: [], miniEvents: [], calendars: [], calById: new Map() };

const state = {
  view: validViews.has(knobView) ? knobView : 'month',
  cursor: new Date(),
  search: '',
  searchResults: null,
  hiddenCals: new Set(),
  detailEventId: null,
  createOpen: false,
  createPrefill: null,
  narrow: false,
  // Parked writes: event_ids with an outstanding reschedule/rsvp/cancel ask.
  // pendingCancelIds is the subset asking specifically to cancel (drives the
  // "cancel asked" chip / "Cancellation pending" button label).
  pendingIds: new Set(),
  pendingCancelIds: new Set(),
  // Session-scoped, receipted activity per event — see logic.js's logActivity.
  // Never fabricated: only writes this session actually made appear here.
  activityLog: new Map(),
  readFailedShown: false,
};

// ---------- Logic instance ----------
// `render`/`load` are `function` declarations (hoisted), so `logic` can
// close over them here even though they're defined further down the file.

const logic = createLogic({ state, data, render, refresh: load });

// ---------- Derived helpers ----------

function visibleEvents(list) {
  return (list ?? []).filter((ev) => !ev.calendar_id || !state.hiddenCals.has(ev.calendar_id));
}

/** Event counts per calendar from whatever is currently loaded (bounded — never a full-table count). */
function calendarCounts() {
  const map = new Map();
  const seen = new Set();
  for (const ev of [...data.events, ...data.miniEvents]) {
    if (!ev.calendar_id || seen.has(ev.event_id)) continue;
    seen.add(ev.event_id);
    map.set(ev.calendar_id, (map.get(ev.calendar_id) ?? 0) + 1);
  }
  return map;
}

function rangeLabel() {
  if (state.view === 'week') {
    const start = startOfWeek(state.cursor);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return state.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// ---------- Navigation ----------

function nav(dir) {
  state.cursor =
    state.view === 'week'
      ? new Date(
          state.cursor.getFullYear(),
          state.cursor.getMonth(),
          state.cursor.getDate() + dir * 7,
        )
      : new Date(state.cursor.getFullYear(), state.cursor.getMonth() + dir, 1);
  load();
}

function goToday() {
  state.cursor = new Date();
  load();
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  load();
}

function pickMiniDay(date) {
  state.cursor = date;
  load();
}

function toggleCalendar(calendarId) {
  if (state.hiddenCals.has(calendarId)) state.hiddenCals.delete(calendarId);
  else state.hiddenCals.add(calendarId);
  render();
}

// ---------- Overlays ----------

function openEventDetail(ev) {
  state.detailEventId = ev.event_id;
  render();
}
function closeDrawer() {
  state.detailEventId = null;
  render();
}

function openCreate(prefill) {
  state.createOpen = true;
  state.createPrefill = prefill ?? null;
  render();
}
function closeCreate() {
  state.createOpen = false;
  state.createPrefill = null;
  render();
}

function onDayCreate(date) {
  const start = nextRoundHourOn(date);
  openCreate({ start, end: new Date(start.getTime() + 3600000) });
}
function onSlotCreate(date, at) {
  openCreate({ start: at, end: new Date(at.getTime() + 3600000) });
}

async function submitCreate(payload) {
  const outcome = await logic.proposeEvent(payload);
  if (outcome?.status === 'executed' || outcome?.status === 'parked') {
    state.cursor = new Date(payload.dtstart);
    await load();
  }
  return outcome;
}

/** The month cell's "+N more" — a kit popover listing every event that day. */
function openDayPanel(dayKey, anchorEl) {
  const segs = bucketByDay(visibleEvents(data.events)).get(dayKey) ?? [];
  openPopover(
    anchorEl,
    (box) => {
      box.appendChild(h('div', { class: 'ag-day-pop-title' }, fmtDay(dayKey)));
      for (const seg of segs) {
        const ev = seg.ev;
        box.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'ag-day-pop-item',
              onclick: () => {
                closePopover();
                openEventDetail(ev);
              },
            },
            h('span', { class: 'ag-dot', style: `background:${logic.colorFor(ev.calendar_id)}` }),
            h('span', { class: 'ag-day-pop-time' }, segTimeText(seg)),
            h('span', { class: 'ag-day-pop-text' }, ev.summary),
          ),
        );
      }
    },
    { className: 'ag-day-pop' },
  );
}

// ---------- Roots ----------

let sidebarMiniRoot;
let sidebarCalsRoot;
let headerRoot;
let canvasRoot;
let drawerRoot;
let modalRoot;

function render() {
  const counts = calendarCounts();
  sidebarMiniRoot.render(
    <MiniMonth
      cursor={state.cursor}
      miniEvents={visibleEvents(data.miniEvents)}
      onPickDay={pickMiniDay}
      onPrev={() => nav(-1)}
      onNext={() => nav(1)}
    />,
  );
  sidebarCalsRoot.render(
    <CalendarList
      calendars={data.calendars}
      hiddenCals={state.hiddenCals}
      counts={counts}
      onToggle={toggleCalendar}
    />,
  );

  headerRoot.render(
    <HeaderBar
      view={state.view}
      rangeLabel={rangeLabel()}
      onToday={goToday}
      onPrev={() => nav(-1)}
      onNext={() => nav(1)}
      onSetView={setView}
    />,
  );

  const events = visibleEvents(data.events);
  let canvas;
  if (state.view === 'month') {
    canvas = (
      <MonthView
        cursor={state.cursor}
        events={events}
        colorFor={logic.colorFor}
        onDayCreate={onDayCreate}
        onEventOpen={openEventDetail}
        onMoreOpen={openDayPanel}
      />
    );
  } else if (state.view === 'week') {
    canvas = (
      <WeekView
        cursor={state.cursor}
        events={events}
        colorFor={logic.colorFor}
        onSlotCreate={onSlotCreate}
        onEventOpen={openEventDetail}
      />
    );
  } else {
    const source = state.searchResults ?? events;
    canvas = (
      <ScheduleView
        events={visibleEvents(source)}
        colorFor={logic.colorFor}
        pendingCancelIds={state.pendingCancelIds}
        search={state.search}
        onEventOpen={openEventDetail}
      />
    );
  }
  canvasRoot.render(canvas);

  const detailEv = state.detailEventId ? logic.findEvent(state.detailEventId) : null;
  drawerRoot.render(
    detailEv ? (
      <EventDrawer
        key={detailEv.event_id}
        event={detailEv}
        calendarName={data.calById.get(detailEv.calendar_id)?.name}
        color={logic.colorFor(detailEv.calendar_id)}
        pending={state.pendingIds.has(detailEv.event_id)}
        pendingCancel={state.pendingCancelIds.has(detailEv.event_id)}
        activity={state.activityLog.get(detailEv.event_id) ?? []}
        onClose={closeDrawer}
        onReschedule={(id, s, e) => logic.rescheduleEvent(id, s, e)}
        onRsvp={(id, p, st) => logic.respondRsvp(id, p, st)}
        onAttach={(id) => {
          logic.setAttachTarget(id);
          $('attachInput').click();
        }}
        onRemoveAttachment={(aid) => logic.removeAttachment(aid)}
        onCancel={(id) => logic.cancelEvent(id)}
      />
    ) : null,
  );

  modalRoot.render(
    state.createOpen ? (
      <CreateModal
        calendars={data.calendars}
        prefill={state.createPrefill}
        onClose={closeCreate}
        onSubmit={submitCreate}
      />
    ) : null,
  );
}

// ---------- Data ----------

let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  const miniRange = monthGridRange(state.cursor);
  const canvasRange =
    state.view === 'month'
      ? miniRange
      : state.view === 'week'
        ? weekRange(state.cursor)
        : { from: scheduleFrom(state.cursor) };
  const needsSecondRead = state.view !== 'month';

  let canvasData;
  let miniData;
  try {
    if (needsSecondRead) {
      [canvasData, miniData] = await Promise.all([
        window.centraid.read({ query: 'upcoming', input: canvasRange }),
        window.centraid.read({ query: 'upcoming', input: miniRange }),
      ]);
    } else {
      canvasData = await window.centraid.read({ query: 'upcoming', input: canvasRange });
      miniData = canvasData;
    }
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    state.readFailedShown = true;
    return;
  }
  if (seq !== loadSeq) return; // a newer navigation superseded this read
  if (state.readFailedShown) {
    state.readFailedShown = false;
    logic.notice('');
  }

  const denied = canvasData?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    data.events = [];
    data.miniEvents = [];
    data.calendars = [];
    data.calById = new Map();
    state.detailEventId = null;
    render();
    return;
  }

  data.events = canvasData?.events ?? [];
  data.miniEvents = miniData?.events ?? [];
  data.calendars = canvasData?.calendars ?? [];
  data.calById = new Map(data.calendars.map((c) => [c.calendar_id, c]));
  if (state.detailEventId && !logic.findEvent(state.detailEventId)) state.detailEventId = null;
  render();
}

// ---------- Boot ----------

sidebarMiniRoot = createRoot($('sidebarMini'));
sidebarCalsRoot = createRoot($('sidebarCals'));
headerRoot = createRoot($('headerBar'));
canvasRoot = createRoot($('canvas'));
drawerRoot = createRoot($('drawerRoot'));
modalRoot = createRoot($('modalRoot'));

showSkeleton($('canvas'), 6);

$('createEventBtn').addEventListener('click', () => {
  $('shell').classList.remove('side-open');
  openCreate(null);
});

wireChrome({
  state,
  load,
  applySearchInput: logic.applySearchInput,
  clearSearch: logic.clearSearch,
  onNav: nav,
  onToday: goToday,
  onSetView: setView,
  closeDrawer,
  closeCreate,
});

// One shared file input for the whole app; the drawer's "Attach" button sets
// the target event, then triggers this.
wireAttachInput($('attachInput'), () => logic.getAttachTarget(), {
  act: logic.act,
  narrate: logic.narrate,
  notice: logic.notice,
  refresh: load,
});

// Reactive data (SKILL.md "Reactive data"): a write elsewhere (chat agent, a
// second window) fires this — re-read, and treat it as the resolution of any
// outstanding parked write (the owner approved or discarded it via another
// surface; there is no per-invocation poll wired here, so this is the
// honest, bounded way to clear a stale pending chip without guessing).
onDataChange(CHANGE_TABLES, () => {
  logic.clearPending();
  load();
});

load();
