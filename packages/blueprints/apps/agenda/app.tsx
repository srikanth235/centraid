// governance: allow-repo-hygiene file-size-limit pre-existing cohesive app blueprint; decomposition is outside issue #417
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
// per stable container — the same docs/tasks/notes pattern. `logic.ts` holds
// the non-visual business logic (vault IO, calendar coloring, activity log,
// parked-write tracking, search); `format.ts` the pure date/range/bucketing
// helpers; `chrome.ts` wires the drawer/keyboard/resize listeners.
// `components/` holds pure functions of props. TS conversion: the module-level
// bags are typed by `AppState`/`AppData` (types.ts); handler/helper modules
// are imported by their real `.ts`/`.tsx` specifiers; the `.module.css` split
// lives in `components/*` while the global shell remainder stays in app.css.
import { createRoot } from './react-core.min.js';
import {
  closePopover,
  h,
  onDataChange,
  openPopover,
  readFailed,
  showSkeleton,
  subscribeReadUpdates,
  wireAttachInput,
} from './kit.js';
import type { ReadSubscription } from './kit.js';
import { createLogic } from './logic.ts';
import { wireChrome } from './chrome.ts';
import {
  bucketByDay,
  fmtDay,
  monthGridRange,
  nextRoundHourOn,
  scheduleFrom,
  segTimeText,
  startOfWeek,
  weekRange,
} from './format.ts';
import { CalendarList, MiniMonth } from './components/Sidebar.tsx';
import { HeaderBar } from './components/HeaderBar.tsx';
import { MonthView } from './components/MonthView.tsx';
import { WeekView } from './components/WeekView.tsx';
import { ScheduleView } from './components/ScheduleView.tsx';
import { EventDrawer } from './components/EventDrawer.tsx';
import { CreateModal } from './components/CreateModal.tsx';
import type {
  AgEvent,
  AppData,
  AppState,
  Calendar,
  CreatePayload,
  Prefill,
  ViewKind,
} from './types.ts';

const $ = (id: string) => document.getElementById(id)!;

/** The `upcoming` query's payload — the canvas read and the mini read share
 *  it; a consent denial rides `vaultDenied` (a first-class outcome, not a
 *  thrown error). */
interface UpcomingData {
  events?: AgEvent[];
  calendars?: Calendar[];
  vaultDenied?: { code?: string; message?: string };
}

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
// The last successful reads (never reassigned — mutated in place so logic.ts's
// closure over `data` stays valid) and all client-side presentation state,
// which is never persisted and never sent to the vault.

const validViews = new Set<ViewKind>(['month', 'week', 'schedule']);
const knobView = document.documentElement.getAttribute('data-app-default-view');

const data: AppData = { events: [], miniEvents: [], calendars: [], calById: new Map() };

const state: AppState = {
  view: validViews.has(knobView as ViewKind) ? (knobView as ViewKind) : 'month',
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
  pendingByIntent: new Map(),
  // Session-scoped, receipted activity per event — see logic.ts's logActivity.
  // Never fabricated: only writes this session actually made appear here.
  activityLog: new Map(),
  readFailedShown: false,
};

// ---------- Logic instance ----------
// `render`/`load` are `function` declarations (hoisted), so `logic` can
// close over them here even though they're defined further down the file.

const logic = createLogic({ state, data, render, refresh: load });

// ---------- Derived helpers ----------

function visibleEvents(list: AgEvent[] | null | undefined): AgEvent[] {
  return (list ?? []).filter((ev) => !ev.calendar_id || !state.hiddenCals.has(ev.calendar_id));
}

/** Event counts per calendar from whatever is currently loaded (bounded — never a full-table count). */
function calendarCounts(): Map<string, number> {
  const map = new Map<string, number>();
  const seen = new Set<string>();
  for (const ev of [...data.events, ...data.miniEvents]) {
    if (!ev.calendar_id || seen.has(ev.event_id)) continue;
    seen.add(ev.event_id);
    map.set(ev.calendar_id, (map.get(ev.calendar_id) ?? 0) + 1);
  }
  return map;
}

function rangeLabel(): string {
  if (state.view === 'week') {
    const start = startOfWeek(state.cursor);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return state.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// ---------- Navigation ----------

function nav(dir: number): void {
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

function goToday(): void {
  state.cursor = new Date();
  load();
}

function setView(v: ViewKind): void {
  if (state.view === v) return;
  state.view = v;
  load();
}

function pickMiniDay(date: Date): void {
  state.cursor = date;
  load();
}

function toggleCalendar(calendarId: string): void {
  if (state.hiddenCals.has(calendarId)) state.hiddenCals.delete(calendarId);
  else state.hiddenCals.add(calendarId);
  render();
}

// ---------- Overlays ----------

function openEventDetail(ev: AgEvent): void {
  state.detailEventId = ev.event_id;
  render();
}
function closeDrawer(): void {
  state.detailEventId = null;
  render();
}

function openCreate(prefill: Prefill | null): void {
  state.createOpen = true;
  state.createPrefill = prefill ?? null;
  render();
}
function closeCreate(): void {
  state.createOpen = false;
  state.createPrefill = null;
  render();
}

function onDayCreate(date: Date): void {
  const start = nextRoundHourOn(date);
  openCreate({ start, end: new Date(start.getTime() + 3600000) });
}
function onSlotCreate(_date: Date, at: Date): void {
  openCreate({ start: at, end: new Date(at.getTime() + 3600000) });
}

async function submitCreate(payload: CreatePayload): Promise<VaultOutcome | undefined> {
  const outcome = await logic.proposeEvent(payload);
  if (
    outcome?.status === 'executed' ||
    outcome?.status === 'parked' ||
    outcome?.status === 'queued' ||
    outcome?.status === 'in-flight'
  ) {
    state.cursor = new Date(payload.dtstart);
    await load();
  }
  return outcome;
}

/** The month cell's "+N more" — a kit popover listing every event that day. */
function openDayPanel(dayKey: string, anchorEl: HTMLElement): void {
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

let sidebarMiniRoot: ReturnType<typeof createRoot>;
let sidebarCalsRoot: ReturnType<typeof createRoot>;
let headerRoot: ReturnType<typeof createRoot>;
let canvasRoot: ReturnType<typeof createRoot>;
let drawerRoot: ReturnType<typeof createRoot>;
let modalRoot: ReturnType<typeof createRoot>;

function render(): void {
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
        calendarName={data.calById.get(detailEv.calendar_id as string)?.name}
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
let liveUnsubscribers: Array<() => void> = [];
let liveReadsOwnData = false;

function replaceLiveReads(reads: ReadSubscription[]): void {
  for (const unsubscribe of liveUnsubscribers) unsubscribe();
  liveUnsubscribers = reads.map((read) => read.unsubscribe);
  liveReadsOwnData = reads.length > 0 && reads.every((read) => read.managed);
}

function subscribeRead(
  read: Promise<UpcomingData>,
  callback: (value: UpcomingData) => void,
): ReadSubscription {
  return subscribeReadUpdates<UpcomingData>(read, callback);
}

function applyLoadedData(seq: number, canvasData: UpcomingData, miniData: UpcomingData): void {
  if (seq !== loadSeq) return;
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
  data.calById = new Map(data.calendars.map((c): [string, Calendar] => [c.calendar_id, c]));
  if (state.detailEventId && !logic.findEvent(state.detailEventId)) state.detailEventId = null;
  render();
}

async function load(): Promise<void> {
  const seq = ++loadSeq;
  const miniRange = monthGridRange(state.cursor);
  const canvasRange =
    state.view === 'month'
      ? miniRange
      : state.view === 'week'
        ? weekRange(state.cursor)
        : { from: scheduleFrom(state.cursor) };
  const needsSecondRead = state.view !== 'month';

  let canvasData: UpcomingData | undefined;
  let miniData: UpcomingData | undefined;
  const publish = () => {
    if (canvasData !== undefined && miniData !== undefined) {
      applyLoadedData(seq, canvasData, miniData);
    }
  };
  try {
    if (needsSecondRead) {
      const canvasRead = window.centraid.read<UpcomingData>({
        query: 'upcoming',
        input: canvasRange,
      });
      const miniRead = window.centraid.read<UpcomingData>({ query: 'upcoming', input: miniRange });
      replaceLiveReads([
        subscribeRead(canvasRead, (value) => {
          canvasData = value;
          publish();
        }),
        subscribeRead(miniRead, (value) => {
          miniData = value;
          publish();
        }),
      ]);
      [canvasData, miniData] = await Promise.all([canvasRead, miniRead]);
    } else {
      const read = window.centraid.read<UpcomingData>({ query: 'upcoming', input: canvasRange });
      replaceLiveReads([
        subscribeRead(read, (value) => {
          canvasData = value;
          miniData = value;
          publish();
        }),
      ]);
      canvasData = await read;
      miniData = canvasData;
    }
  } catch {
    if (seq !== loadSeq) return;
    // The attempted live reads never established dependencies. Drop their
    // listeners and re-enable the compatibility doorbell so a later change
    // can retry instead of leaving this view permanently inert.
    replaceLiveReads([]);
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    state.readFailedShown = true;
    return;
  }
  applyLoadedData(seq, canvasData, miniData);
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
wireAttachInput($('attachInput') as HTMLInputElement, () => logic.getAttachTarget(), {
  act: logic.act,
  narrate: logic.narrate,
  notice: logic.notice,
  refresh: load,
});

// Live reads own data invalidation. Keep the compatibility doorbell only for
// older/non-managed hosts, and use exact terminal intent ids solely to settle
// this session's pending chips.
onDataChange(CHANGE_TABLES, (detail) => {
  const pendingChanged = logic.reconcilePending(detail, liveReadsOwnData);
  if (liveReadsOwnData) {
    if (pendingChanged) render();
    return;
  }
  // A legacy/server `_changes` doorbell cannot name the replica intent. Its
  // relevant table change is the bounded compatibility signal used before
  // exact overlay invalidations existed.
  load();
});

load();
