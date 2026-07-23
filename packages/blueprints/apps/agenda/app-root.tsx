// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505); it is smaller than the served app.tsx + app-inline.tsx it replaces. Splitting it belongs to the app's own code evolution, not this migration.
// Agenda — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. The shell's InlineAppModule
// descriptor imports `Root` and `CHANGE_TABLES` from here and adds the query
// wiring; there is deliberately no parallel served-system-app entry.

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  closePopover,
  h,
  observeWidth,
  onDataChange,
  onFocusRefresh,
  openPopover,
  readFailed,
  subscribeReadUpdates,
  wireAttachInput,
  wireThemeToggle,
} from './kit.ts';
import type { ReadSubscription } from './kit.ts';
import { createLogic } from './logic.ts';
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
import { Chrome } from './Chrome.tsx';
import type {
  AgEvent,
  AppData,
  AppState,
  Calendar,
  CreatePayload,
  Prefill,
  ViewKind,
} from './types.ts';
import type { InlineAppProps } from '../inline-types.ts';
import styles from './Chrome.module.css';

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
export const CHANGE_TABLES = [
  'core.event',
  'schedule.event_ext',
  'schedule.attendee',
  'schedule.calendar',
  'core.party',
  'core.attachment',
  'core.content_item',
  'core.vault',
];

const VALID_VIEWS = new Set<ViewKind>(['month', 'week', 'schedule']);

/** The `upcoming` query's payload — the canvas read and the mini read share it;
 *  a consent denial rides `vaultDenied` (a first-class outcome, not an error). */
interface UpcomingData {
  events?: AgEvent[];
  calendars?: Calendar[];
  vaultDenied?: { code?: string; message?: string };
}

const byId = (id: string): HTMLElement | null => document.getElementById(id);

function initialView(rootEl: HTMLElement | null): ViewKind {
  // The inline shell pushes the default-view knob onto the app's OWN root
  // element; the served shim / boot harness set it on documentElement instead
  // (they mount `Root` into #appRoot and can't reach into it). Read the app
  // root first, then fall back to documentElement so both boot paths honour the
  // knob (#505).
  const knob =
    rootEl?.getAttribute('data-app-default-view') ??
    document.documentElement.getAttribute('data-app-default-view');
  return knob && VALID_VIEWS.has(knob as ViewKind) ? (knob as ViewKind) : 'month';
}

function makeState(view: ViewKind): AppState {
  return {
    view,
    cursor: new Date(),
    search: '',
    searchResults: null,
    hiddenCals: new Set(),
    detailEventId: null,
    createOpen: false,
    createPrefill: null,
    narrow: false,
    pendingIds: new Set(),
    pendingCancelIds: new Set(),
    pendingByIntent: new Map(),
    activityLog: new Map(),
    readFailedShown: false,
  };
}

export function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<AppData>({
    events: [],
    miniEvents: [],
    calendars: [],
    calById: new Map(),
  });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Data-load bookkeeping (the served app's module-level `let`s → refs so the
  // stable `load` closure keeps its own persistent state across calls).
  const loadSeqRef = useRef(0);
  const liveUnsubRef = useRef<Array<() => void>>([]);
  const liveOwnRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const state = stateRef.current;
    const data = dataRef.current;
    const logic = logicRef.current;
    if (!logic) return;
    const seq = ++loadSeqRef.current;

    const replaceLiveReads = (reads: ReadSubscription[]): void => {
      for (const unsubscribe of liveUnsubRef.current) unsubscribe();
      liveUnsubRef.current = reads.map((read) => read.unsubscribe);
      liveOwnRef.current = reads.length > 0 && reads.every((read) => read.managed);
    };

    const applyLoadedData = (canvasData: UpcomingData, miniData: UpcomingData): void => {
      if (seq !== loadSeqRef.current) return;
      if (state.readFailedShown) {
        state.readFailedShown = false;
        logic.notice('');
      }
      const denied = canvasData?.vaultDenied;
      const consentBanner = byId('consentBanner');
      if (consentBanner) consentBanner.hidden = !denied;
      if (denied) {
        const consentDetail = byId('consentDetail');
        if (consentDetail) consentDetail.textContent = denied.message ?? '';
        data.events = [];
        data.miniEvents = [];
        data.calendars = [];
        data.calById = new Map();
        state.detailEventId = null;
        bump();
        return;
      }
      data.events = canvasData?.events ?? [];
      data.miniEvents = miniData?.events ?? [];
      data.calendars = canvasData?.calendars ?? [];
      data.calById = new Map(data.calendars.map((c): [string, Calendar] => [c.calendar_id, c]));
      if (state.detailEventId && !logic.findEvent(state.detailEventId)) state.detailEventId = null;
      bump();
    };

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
    const publish = (): void => {
      if (canvasData !== undefined && miniData !== undefined) {
        applyLoadedData(canvasData, miniData);
      }
    };
    try {
      if (needsSecondRead) {
        const canvasRead = window.centraid.read<UpcomingData>({
          query: 'upcoming',
          input: canvasRange,
        });
        const miniRead = window.centraid.read<UpcomingData>({
          query: 'upcoming',
          input: miniRange,
        });
        replaceLiveReads([
          subscribeReadUpdates<UpcomingData>(canvasRead, (value) => {
            canvasData = value;
            publish();
          }),
          subscribeReadUpdates<UpcomingData>(miniRead, (value) => {
            miniData = value;
            publish();
          }),
        ]);
        [canvasData, miniData] = await Promise.all([canvasRead, miniRead]);
      } else {
        const read = window.centraid.read<UpcomingData>({ query: 'upcoming', input: canvasRange });
        replaceLiveReads([
          subscribeReadUpdates<UpcomingData>(read, (value) => {
            canvasData = value;
            miniData = value;
            publish();
          }),
        ]);
        canvasData = await read;
        miniData = canvasData;
      }
    } catch {
      if (seq !== loadSeqRef.current) return;
      // The attempted live reads never established dependencies. Drop their
      // listeners so a later change can retry instead of leaving this view inert.
      replaceLiveReads([]);
      // A broken vault must not look like an empty one.
      readFailed(byId('noticeBanner'));
      state.readFailedShown = true;
      return;
    }
    applyLoadedData(canvasData, miniData);
  }, []);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      data: dataRef.current,
      render: bump,
      refresh: load,
    });
  }
  const logic = logicRef.current;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
      if (el) {
        const view = initialView(el);
        if (view !== stateRef.current.view && stateRef.current.search === '') {
          stateRef.current.view = view;
          bump();
        }
      }
    },
    [rootRef],
  );

  // ---- Navigation / view (mutate the state bag in place, then reload) ----
  const nav = useCallback(
    (dir: number) => {
      const state = stateRef.current;
      state.cursor =
        state.view === 'week'
          ? new Date(
              state.cursor.getFullYear(),
              state.cursor.getMonth(),
              state.cursor.getDate() + dir * 7,
            )
          : new Date(state.cursor.getFullYear(), state.cursor.getMonth() + dir, 1);
      void load();
    },
    [load],
  );
  const goToday = useCallback(() => {
    stateRef.current.cursor = new Date();
    void load();
  }, [load]);
  const setView = useCallback(
    (v: ViewKind) => {
      if (stateRef.current.view === v) return;
      stateRef.current.view = v;
      void load();
    },
    [load],
  );
  const pickMiniDay = useCallback(
    (date: Date) => {
      stateRef.current.cursor = date;
      void load();
    },
    [load],
  );
  const toggleCalendar = useCallback((calendarId: string) => {
    const hidden = stateRef.current.hiddenCals;
    if (hidden.has(calendarId)) hidden.delete(calendarId);
    else hidden.add(calendarId);
    bump();
  }, []);

  // ---- Overlays ----
  const openEventDetail = useCallback((ev: AgEvent) => {
    stateRef.current.detailEventId = ev.event_id;
    bump();
  }, []);
  const closeDrawer = useCallback(() => {
    stateRef.current.detailEventId = null;
    bump();
  }, []);
  const openCreate = useCallback((prefill: Prefill | null) => {
    stateRef.current.createOpen = true;
    stateRef.current.createPrefill = prefill ?? null;
    bump();
  }, []);
  const closeCreate = useCallback(() => {
    stateRef.current.createOpen = false;
    stateRef.current.createPrefill = null;
    bump();
  }, []);
  const onDayCreate = useCallback(
    (date: Date) => {
      const start = nextRoundHourOn(date);
      openCreate({ start, end: new Date(start.getTime() + 3600000) });
    },
    [openCreate],
  );
  const onSlotCreate = useCallback(
    (_date: Date, at: Date) => {
      openCreate({ start: at, end: new Date(at.getTime() + 3600000) });
    },
    [openCreate],
  );
  const submitCreate = useCallback(
    async (payload: CreatePayload): Promise<VaultOutcome | undefined> => {
      const outcome = await logic.proposeEvent(payload);
      if (
        outcome?.status === 'executed' ||
        outcome?.status === 'parked' ||
        outcome?.status === 'queued' ||
        outcome?.status === 'in-flight'
      ) {
        stateRef.current.cursor = new Date(payload.dtstart);
        await load();
      }
      return outcome;
    },
    [logic, load],
  );

  const visibleEvents = useCallback((list: AgEvent[] | null | undefined): AgEvent[] => {
    const hidden = stateRef.current.hiddenCals;
    return (list ?? []).filter((ev) => !ev.calendar_id || !hidden.has(ev.calendar_id));
  }, []);

  /** The month cell's "+N more" — a kit popover listing every event that day. */
  const openDayPanel = useCallback(
    (dayKey: string, anchorEl: HTMLElement) => {
      const segs = bucketByDay(visibleEvents(dataRef.current.events)).get(dayKey) ?? [];
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
                h('span', {
                  class: 'ag-dot',
                  style: `background:${logic.colorFor(ev.calendar_id)}`,
                }),
                h('span', { class: 'ag-day-pop-time' }, segTimeText(seg)),
                h('span', { class: 'ag-day-pop-text' }, ev.summary),
              ),
            );
          }
        },
        { className: 'ag-day-pop' },
      );
    },
    [logic, openEventDetail, visibleEvents],
  );

  // ---- chrome wiring: theme toggle, attach input, doorbell, focus, keys, width ----
  useEffect(() => {
    if (themeBtnRef.current) wireThemeToggle(themeBtnRef.current);
    const attachInput = byId('attachInput') as HTMLInputElement | null;
    if (attachInput) {
      wireAttachInput(attachInput, () => logic.getAttachTarget(), {
        act: logic.act,
        narrate: logic.narrate,
        notice: logic.notice,
        refresh: load,
      });
    }
    const stopDoorbell = onDataChange(CHANGE_TABLES, (detail) => {
      const pendingChanged = logic.reconcilePending(detail, liveOwnRef.current);
      if (liveOwnRef.current) {
        if (pendingChanged) bump();
        return;
      }
      void load();
    });
    const stopFocus = onFocusRefresh(() => void load());
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const searchInput = searchInputRef.current;
      const state = stateRef.current;
      if (e.key === 'Escape') {
        if (state.createOpen) return void closeCreate();
        if (state.detailEventId) return void closeDrawer();
        if (e.target === searchInput && searchInput?.value) {
          searchInput.value = '';
          logic.clearSearch();
          return;
        }
        setSideOpen(false);
        return;
      }
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (state.createOpen || state.detailEventId) return;
      if (e.key === 'ArrowLeft') nav(-1);
      else if (e.key === 'ArrowRight') nav(1);
      else if (e.key === 't') goToday();
      else if (e.key === 'm') setView('month');
      else if (e.key === 'w') setView('week');
      else if (e.key === 's') setView('schedule');
    };
    window.addEventListener('keydown', onKey);
    const stopWidth = observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
      stateRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
      if (!isNarrow) setSideOpen(false);
    });
    void load();
    return () => {
      window.removeEventListener('keydown', onKey);
      stopDoorbell();
      stopFocus();
      stopWidth();
      for (const unsubscribe of liveUnsubRef.current) unsubscribe();
      liveUnsubRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    const el = searchInputRef.current;
    if (!el?.value && !stateRef.current.search) return;
    if (el) el.value = '';
    logic.clearSearch();
  };

  // ---- Derived render inputs (mirrors app.tsx's imperative render()) ----
  const state = stateRef.current;
  const data = dataRef.current;

  const counts = new Map<string, number>();
  {
    const seen = new Set<string>();
    for (const ev of [...data.events, ...data.miniEvents]) {
      if (!ev.calendar_id || seen.has(ev.event_id)) continue;
      seen.add(ev.event_id);
      counts.set(ev.calendar_id, (counts.get(ev.calendar_id) ?? 0) + 1);
    }
  }

  const rangeLabel =
    state.view === 'week'
      ? (() => {
          const start = startOfWeek(state.cursor);
          const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
          return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        })()
      : state.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const events = visibleEvents(data.events);
  let canvasNode: ReactElement;
  if (state.view === 'month') {
    canvasNode = (
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
    canvasNode = (
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
    canvasNode = (
      <ScheduleView
        events={visibleEvents(source)}
        colorFor={logic.colorFor}
        pendingCancelIds={state.pendingCancelIds}
        search={state.search}
        onEventOpen={openEventDetail}
      />
    );
  }

  const detailEv = state.detailEventId ? logic.findEvent(state.detailEventId) : null;
  const drawerNode = detailEv ? (
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
        (byId('attachInput') as HTMLInputElement | null)?.click();
      }}
      onRemoveAttachment={(aid) => logic.removeAttachment(aid)}
      onCancel={(id) => logic.cancelEvent(id)}
    />
  ) : null;

  const modalNode = state.createOpen ? (
    <CreateModal
      calendars={data.calendars}
      prefill={state.createPrefill}
      onClose={closeCreate}
      onSubmit={submitCreate}
    />
  ) : null;

  return (
    // Fill the route body (a flex child) so the inline chrome gets real width —
    // otherwise it collapses to content width and the component-width narrow
    // observer wrongly flips to the phone drawer layout (issue #505 trap).
    <div ref={setRoot} className={styles.root}>
      <Chrome
        narrow={narrow}
        sideOpen={sideOpen}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onCreate={() => {
          setSideOpen(false);
          openCreate(null);
        }}
        onSearchInput={(value) => logic.applySearchInput(value)}
        onSearchKeyDown={onSearchKeyDown}
        searchRef={(el) => {
          searchInputRef.current = el;
        }}
        themeButtonRef={(el) => {
          themeBtnRef.current = el;
        }}
        sidebarMini={
          <MiniMonth
            cursor={state.cursor}
            miniEvents={visibleEvents(data.miniEvents)}
            onPickDay={pickMiniDay}
            onPrev={() => nav(-1)}
            onNext={() => nav(1)}
          />
        }
        sidebarCals={
          <CalendarList
            calendars={data.calendars}
            hiddenCals={state.hiddenCals}
            counts={counts}
            onToggle={toggleCalendar}
          />
        }
        headerBar={
          <HeaderBar
            view={state.view}
            rangeLabel={rangeLabel}
            onToday={goToday}
            onPrev={() => nav(-1)}
            onNext={() => nav(1)}
            onSetView={setView}
          />
        }
        canvas={canvasNode}
        drawer={drawerNode}
      />
      {modalNode}
      <input id="attachInput" type="file" multiple hidden aria-label="Attach a file to an event" />
    </div>
  );
}
