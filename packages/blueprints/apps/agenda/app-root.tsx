// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505/#834); the views, the rail, the editor and the states each live in their own module and this is the wiring between them.
// Agenda — query-free React tree; keep `./queries/*` out of it.
//
// THE APP IS A ROUTE INSIDE THE FRAME: no bar, status line or nav column of its
// own — bar and band are contributed through `frame.tsx`.
//
// THE DAY-CONTEXT LAYERS (#834) are a second read, not a second store: they
// decorate days, never become event rows, and a refused read degrades to no
// decoration. Due counts read the PERSONAL scope only — no `readAll` fan-out.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
  subscribeReadUpdates,
  wireAttachInput,
} from "@centraid/design/elements";
import type { ReadSubscription } from "@centraid/design/elements";

import { LoadingSkeleton } from "../_shared/LoadingSkeleton.tsx";
import { readPendingOverlay } from "../_shared/pending-overlay.ts";
import { libraryReachability } from "../_shared/view-state-kit.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { CalendarSheet } from "./components/CalendarSheet.tsx";
import { DayRibbon, DayShelf, LayerToggles } from "./components/DayContext.tsx";
import { EventDetail } from "./components/EventDetail.tsx";
import { EventEditor } from "./components/EventEditor.tsx";
import { MonthGrid, TimeGrid } from "./components/Grid.tsx";
import { ListView } from "./components/ListViews.tsx";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { CalendarList, MiniMonth } from "./components/Rail.tsx";
import { EmptyState, SearchField } from "./components/Shared.tsx";
import {
  dueCountFor,
  dueTasksFor,
  NO_DAY_CONTEXT,
  ribbonsFor,
} from "./day-context.ts";
import type { DayContextData, LayerId } from "./day-context.ts";
import type { RsvpAnswer } from "./edits.ts";
import { calendarHue, localDayKey, rangeLabel } from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { createLogic } from "./logic.ts";
import { createMemberPrefs } from "./member-prefs.ts";
import type {
  AgEvent,
  AppData,
  AppState,
  Calendar,
  PartyOption,
  ViewKind,
} from "./types.ts";
import {
  RAIL_DAY_CONTEXT_EMPTY,
  STATE_DAY_ONE,
  STATE_DAY_ONE_ACTION,
  STATE_OFFLINE,
  STATE_READ_FAILED,
  STATE_REFRESH,
  STATE_STALE,
  emptyLine,
  partlyDeniedLine,
} from "./view-copy.ts";
import {
  BAND_SEARCH_ID,
  bucketByDay,
  defaultView,
  findEvent,
  monthGridDays,
  nowAnchor,
  rangeForView,
  resolveView,
  rowKey,
  visibleEvents,
  waitingOn,
  weekDays,
} from "./views.ts";

import styles from "./Chrome.module.css";

export const CHANGE_TABLES = [
  "core.event",
  "schedule.event_ext",
  "schedule.attendee",
  "schedule.recurrence_exception",
  "schedule.calendar",
  "core.party",
  "core.attachment",
  "core.content_item",
  "core.vault",
  // Day-context entities (#834): without them decorations go stale.
  "schedule.task",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
];

/** A consent denial rides `vaultDenied` — an outcome, never an error. */
interface UpcomingData {
  events?: AgEvent[];
  calendars?: Calendar[];
  vaultDenied?: { code?: string; message?: string };
}

function makeState(view: ViewKind): AppState {
  return {
    view,
    anchorDay: new Date(),
    search: "",
    searchResults: null,
    hiddenCals: new Set(),
    selectedId: null,
    quick: null,
    editorId: null,
    createOpen: false,
    narrow: false,
  };
}

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  /** A read that came back FAILED — the only evidence for "out of reach". */
  const [readFailedState, setReadFailedState] = useState(false);
  /** A partial denial is normal and names its slice. */
  const [deniedCalendars, setDeniedCalendars] = useState<readonly string[]>([]);

  /** ONE open shelf at a time: a shelf is a glance, not a second task list. */
  const [openShelf, setOpenShelf] = useState<string | null>(null);

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const readFailedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const liveUnsubRef = useRef<(() => void)[]>([]);
  const partiesReadRef = useRef(false);

  const dataRef = useRef<AppData>({
    events: [],
    miniEvents: [],
    calendars: [],
    calById: new Map(),
    parties: [],
    me: null,
  });
  const stateRef = useRef<AppState>(makeState(defaultView(false)));
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  /** A refused read holds `NO_DAY_CONTEXT` and `layersReady` false. */
  const dayContextRef = useRef<DayContextData>(NO_DAY_CONTEXT);
  const [layersReady, setLayersReady] = useState(false);
  const prefsRef = useRef<ReturnType<typeof createMemberPrefs> | null>(null);
  prefsRef.current ??= createMemberPrefs(() => bump());
  /** The host default-view knob applies once at mount, never after a band tap. */
  const appliedDefaultView = useRef(false);
  const layers = prefsRef.current.read().layers;

  const state = stateRef.current;
  const data = dataRef.current;

  /** One read per paint: the mini month is served from the canvas rows. */
  const load = useCallback(async (): Promise<void> => {
    const logic = logicRef.current;
    if (!logic) return;
    const store = dataRef.current;
    const seq = ++loadSeqRef.current;
    const replaceLive = (reads: ReadSubscription[]): void => {
      for (const stop of liveUnsubRef.current) stop();
      liveUnsubRef.current = reads.map((read) => read.unsubscribe);
    };

    const apply = (next: UpcomingData): void => {
      if (seq !== loadSeqRef.current) return;
      if (readFailedRef.current) {
        readFailedRef.current = false;
        logic.notice("");
      }
      setReadFailedState(false);
      const denied = next?.vaultDenied;
      setConsent(denied ? { message: denied.message ?? "" } : null);
      setLoaded(true);
      if (denied) {
        store.events = [];
        store.miniEvents = [];
        store.calendars = [];
        store.calById = new Map();
        stateRef.current.selectedId = null;
        bump();
        return;
      }
      // Mutate in place: `createLogic` closed over this exact object.
      store.events = next.events ?? [];
      store.miniEvents = store.events;
      store.calendars = next.calendars ?? [];
      store.calById = new Map(
        store.calendars.map((cal): [string, Calendar] => [cal.calendar_id, cal])
      );
      // Denial is a calendar omitted from `calendars` while events still
      // reference it — not one merely returning no rows.
      const named = new Set(store.calendars.map((cal) => cal.calendar_id));
      setDeniedCalendars([
        ...new Set(
          store.events.flatMap((ev) =>
            ev.calendar_id && !named.has(ev.calendar_id) ? [ev.calendar_id] : []
          )
        ),
      ]);
      if (
        stateRef.current.selectedId &&
        !findEvent(store.events, stateRef.current.selectedId)
      )
        stateRef.current.selectedId = null;
      bump();
    };

    /** A denied People or Tasks slice leaves the grid drawn, undecorated. */
    const applyContext = (next: DayContextData | null): void => {
      if (seq !== loadSeqRef.current) return;
      const usable = next && !next.vaultDenied;
      dayContextRef.current = usable ? next : NO_DAY_CONTEXT;
      setLayersReady(Boolean(usable));
      bump();
    };

    const range = rangeForView(
      resolveView(stateRef.current.view, compact),
      stateRef.current.anchorDay
    );
    // Day keys, not instants. Unbounded views take the query's own runway.
    const contextRange = {
      from: localDayKey(new Date(range.from)),
      ...(range.to ? { to: localDayKey(new Date(range.to)) } : {}),
    };
    void window.centraid
      .read<DayContextData>({ query: "day-context", input: contextRange })
      .then(applyContext)
      .catch(() => applyContext(null));
    try {
      const read = window.centraid.read<UpcomingData>({
        query: "upcoming",
        input: range,
      });
      replaceLive([subscribeReadUpdates<UpcomingData>(read, apply)]);
      apply(await read);
    } catch {
      if (seq !== loadSeqRef.current) return;
      // No dependency was established: drop the listener so a doorbell can
      // retry. A BROKEN VAULT MUST NOT LOOK LIKE AN EMPTY ONE.
      replaceLive([]);
      readFailed(document.querySelector<HTMLElement>("#noticeBanner"));
      readFailedRef.current = true;
      setReadFailedState(true);
      setLoaded(true);
    }
  }, [compact]);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      data: dataRef.current,
      frame,
      render: bump,
      refresh: load,
    });
  }
  const logic = logicRef.current;

  /** Read ONCE, and only when a composer needs it: boot stays a single query. */
  const ensureParties = useCallback(() => {
    if (partiesReadRef.current) return;
    partiesReadRef.current = true;
    void window.centraid
      .read<{ parties?: PartyOption[]; me?: string }>({ query: "parties" })
      .then((result) => {
        data.parties = (result?.parties ?? []).filter((party) => !party.is_you);
        data.me = result?.me ?? null;
        bump();
      })
      .catch(() => {
        // A denied directory empties the picker; it never takes the editor down.
      });
  }, [data]);

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
      if (el && !appliedDefaultView.current) {
        appliedDefaultView.current = true;
        const knob =
          el.dataset.appDefaultView ??
          document.documentElement.dataset.appDefaultView;
        const next = defaultView(compact, knob);
        if (next !== stateRef.current.view) {
          stateRef.current.view = next;
          bump();
        }
      }
    },
    [compact, rootRef]
  );

  // ──── navigation ────
  const view = resolveView(state.view, compact || narrow);

  const setView = useCallback(
    (next: ViewKind) => {
      if (stateRef.current.view === next) return;
      stateRef.current.view = next;
      // Light the band destination immediately; load() is the rows, not the tab.
      bump();
      void load();
    },
    [load]
  );

  const step = useCallback(
    (direction: -1 | 1) => {
      const current = stateRef.current;
      const anchor = current.anchorDay;
      const shown = resolveView(current.view, compact || narrow);
      current.anchorDay =
        shown === "week"
          ? new Date(
              anchor.getFullYear(),
              anchor.getMonth(),
              anchor.getDate() + direction * 7
            )
          : shown === "day"
            ? new Date(
                anchor.getFullYear(),
                anchor.getMonth(),
                anchor.getDate() + direction
              )
            : new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
      void load();
    },
    [compact, load, narrow]
  );

  const goToday = useCallback(() => {
    stateRef.current.anchorDay = new Date();
    void load();
  }, [load]);

  const pickDay = useCallback(
    (day: Date) => {
      stateRef.current.anchorDay = day;
      void load();
    },
    [load]
  );

  /** A closed field that still filters is a hidden filter. */
  const closeSearch = useCallback(() => {
    logic.clearSearch();
    setSearchOpen(false);
  }, [logic]);

  const toggleCalendar = useCallback((calendarId: string) => {
    const hidden = stateRef.current.hiddenCals;
    if (hidden.has(calendarId)) hidden.delete(calendarId);
    else hidden.add(calendarId);
    bump();
  }, []);

  // ──── overlays ────
  const openEvent = useCallback((ev: AgEvent) => {
    stateRef.current.selectedId = rowKey(ev);
    bump();
  }, []);

  const openQuick = useCallback((start: Date) => {
    stateRef.current.quick = {
      start,
      end: new Date(start.getTime() + 60 * 60 * 1000),
      title: "",
    };
    bump();
  }, []);

  const openCreate = useCallback(() => {
    ensureParties();
    stateRef.current.createOpen = true;
    stateRef.current.quick = null;
    bump();
  }, [ensureParties]);

  /** THE DRAFT SURVIVES into the full editor — never clear it here. */
  const openCreateFromQuick = useCallback(() => {
    ensureParties();
    stateRef.current.createOpen = true;
    bump();
  }, [ensureParties]);

  const openEditor = useCallback(
    (id: string) => {
      ensureParties();
      stateRef.current.editorId = id;
      bump();
    },
    [ensureParties]
  );

  const closeOverlays = useCallback(() => {
    const current = stateRef.current;
    current.createOpen = false;
    current.editorId = null;
    current.quick = null;
    bump();
  }, []);

  const hueFor = useCallback(
    (calendarId: string | null | undefined): string | null =>
      calendarHue(
        calendarId ? dataRef.current.calById.get(calendarId) : undefined,
        calendarId
      ),
    []
  );

  const toggleLayer = useCallback((id: LayerId) => {
    prefsRef.current?.toggleLayer(id);
  }, []);

  /** A NAVIGATION, never an edit — the task's own room owns it. Absent on
   *  hosts with no way to leave the app. */
  const openInTasks = window.centraid.openApp
    ? (taskId: string): void => {
        window.centraid.openApp?.("tasks", { taskId });
      }
    : undefined;

  const pendingFor = useCallback(
    (ev: AgEvent) =>
      readPendingOverlay(ev as unknown as Record<string, unknown>) as
        | { status: string; action: string }
        | undefined,
    []
  );

  // ──── chrome wiring: attach input, doorbell, focus, width ────
  useEffect(() => {
    const attachInput = attachInputRef.current;
    if (attachInput)
      wireAttachInput(attachInput, () => logic.getAttachTarget(), {
        act: logic.act,
        narrate: logic.narrate,
        notice: logic.notice,
        refresh: load,
      });
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void load());
    const stopFocus = onFocusRefresh(() => void load());
    const stopWidth = observeWidth(rootElRef.current, 860, (isNarrow) => {
      stateRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
    });
    const id = requestAnimationFrame(() => setReady(true));
    void load();
    return () => {
      cancelAnimationFrame(id);
      stopDoorbell();
      stopFocus();
      stopWidth();
      for (const stop of liveUnsubRef.current) stop();
      liveUnsubRef.current = [];
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#834)
  }, []);

  // ──── derive ────
  const events = visibleEvents(
    state.searchResults ?? data.events,
    state.hiddenCals
  );
  const rows = view === "waiting" ? waitingOn(events) : events;
  const buckets = bucketByDay(rows);
  const dayGroups = [...buckets.entries()]
    .map(([dayKey, segments]) => ({ dayKey, segments }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  const anchorMinutes = nowAnchor(state.anchorDay);
  const range = rangeLabel(view, state.anchorDay);
  const selected = state.selectedId
    ? findEvent(data.events, state.selectedId)
    : null;
  const editing = state.editorId
    ? findEvent(data.events, state.editorId)
    : null;
  const searching = state.search.trim() !== "";

  // ──── the day-context seams ────
  // Closures over this render's facts, so a layer switched off just vanishes.
  const dayContext = dayContextRef.current;
  const dayRibbon = (dayKey: string): ReactNode => (
    <DayRibbon facts={ribbonsFor(dayKey, dayContext, layers)} />
  );
  const dayShelf = (dayKey: string): ReactNode => (
    <DayShelf
      dayKey={dayKey}
      count={dueCountFor(dayKey, dayContext, layers)}
      tasks={dueTasksFor(dayKey, dayContext, layers)}
      open={openShelf === dayKey}
      onToggle={(key) =>
        setOpenShelf((current) => (current === key ? null : key))
      }
      {...(openInTasks ? { onOpenTask: openInTasks } : {})}
    />
  );

  let canvas: ReactNode;
  if (!loaded) {
    canvas = (
      <div ref={skeletonRef} className={styles.canvas}>
        <LoadingSkeleton rows={8} />
      </div>
    );
  } else if (consent) {
    // Never draw a grid pretending the vault answered.
    canvas = null;
  } else if (rows.length === 0) {
    canvas = (
      <EmptyState
        line={
          data.events.length === 0 && !searching
            ? STATE_DAY_ONE
            : emptyLine(view, searching)
        }
        actionLabel={searching ? undefined : STATE_DAY_ONE_ACTION}
        onAction={searching ? undefined : openCreate}
      />
    );
  } else if (view === "month") {
    canvas = (
      <MonthGrid
        days={monthGridDays(state.anchorDay)}
        anchorMonth={state.anchorDay.getMonth()}
        buckets={buckets}
        hueFor={hueFor}
        isPending={(ev) => pendingFor(ev) !== undefined}
        onOpen={openEvent}
        onQuickAdd={openQuick}
        onPickDay={pickDay}
        dayRibbon={dayRibbon}
        dayShelf={dayShelf}
      />
    );
  } else if (view === "week" || view === "day") {
    canvas = (
      <TimeGrid
        days={
          view === "week"
            ? weekDays(state.anchorDay)
            : [localDayKey(state.anchorDay)]
        }
        anchorMinutes={anchorMinutes}
        buckets={buckets}
        hueFor={hueFor}
        isPending={(ev) => pendingFor(ev) !== undefined}
        onOpen={openEvent}
        onQuickAdd={openQuick}
        dayRibbon={dayRibbon}
        dayShelf={dayShelf}
      />
    );
  } else {
    canvas = (
      <ListView
        groups={dayGroups}
        hueFor={hueFor}
        pendingFor={pendingFor}
        onOpen={openEvent}
        showAwaiting={view === "waiting"}
        dayShelf={dayShelf}
      />
    );
  }

  // Offline is the host `data-gateway-status` stamp (#864), never the browser
  // online flag. `readFailedState` still takes precedence below.
  const offline =
    libraryReachability({
      hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
      readFailed: readFailedState,
    }) === "unreachable";
  const stateRow: ReactNode =
    readFailedState || offline || deniedCalendars.length > 0 ? (
      <>
        {readFailedState ? (
          <>
            <span>{STATE_READ_FAILED}</span>
            <button
              type="button"
              className="kit-btn"
              onClick={() => void load()}
            >
              {STATE_REFRESH}
            </button>
          </>
        ) : null}
        {offline && !readFailedState ? <span>{STATE_OFFLINE}</span> : null}
        {offline && !readFailedState ? <span>{STATE_STALE}</span> : null}
        {deniedCalendars.length > 0 ? (
          <span>{partlyDeniedLine(deniedCalendars)}</span>
        ) : null}
      </>
    ) : null;

  // ──── frame contributions, from EFFECTS only ────
  useEffect(() => {
    frame.setAppBar(
      appBar({
        view,
        range,
        count: consent ? null : rows.length,
        compact: compact || narrow,
        onSetView: setView,
        onToday: goToday,
        onStep: step,
        onNew: openCreate,
        onSearch: () => setSearchOpen(true),
      })
    );
  }, [
    compact,
    consent,
    frame,
    goToday,
    narrow,
    openCreate,
    range,
    rows.length,
    setView,
    step,
    view,
  ]);

  useEffect(() => {
    if (!(compact || narrow)) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(
        view,
        (segment) => {
          if (segment === BAND_SEARCH_ID) setSearchOpen(true);
          else setView(segment as ViewKind);
        },
        () => setMoreOpen((open) => !open)
      )
    );
  }, [compact, frame, narrow, setView, view]);

  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
    };
  }, [frame]);

  const overlays: ReactNode = (
    <>
      {state.quick && !state.createOpen ? (
        <QuickAdd
          draft={state.quick}
          onTitle={(title) => {
            if (stateRef.current.quick) stateRef.current.quick.title = title;
            bump();
          }}
          onAdd={() => {
            const draft = stateRef.current.quick;
            if (!draft) return;
            stateRef.current.quick = null;
            void logic.proposeEvent({
              summary: draft.title,
              dtstart: draft.start.toISOString(),
              dtend: draft.end.toISOString(),
              start_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              calendar_id: data.calendars[0]?.calendar_id ?? "",
            });
          }}
          onEdit={openCreateFromQuick}
          onDiscard={closeOverlays}
        />
      ) : null}
      {state.createOpen || editing ? (
        <EventEditor
          key={editing ? rowKey(editing) : "new"}
          event={editing}
          {...(state.quick ? { draft: state.quick } : {})}
          calendars={data.calendars}
          parties={data.parties}
          onClose={closeOverlays}
          onCreate={(payload) => {
            void (async () => {
              const outcome = await logic.proposeEvent(payload);
              const status = outcome?.status;
              if (
                status === "executed" ||
                status === "parked" ||
                status === "queued" ||
                status === "in-flight"
              ) {
                closeOverlays();
              }
            })();
          }}
          onEdit={(payload) => {
            closeOverlays();
            void logic.editEvent(payload);
          }}
          onEditOccurrence={(payload) => {
            closeOverlays();
            void logic.editOccurrence(payload);
          }}
        />
      ) : null}
      <input
        ref={attachInputRef}
        id="attachInput"
        type="file"
        multiple
        hidden
        aria-label="Attach a file to an event"
      />
    </>
  );

  return (
    // Fill the app pane so chrome gets real width — content width makes the
    // narrow observer flip to the phone layout.
    <div
      ref={setRoot}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: "relative",
      }}
    >
      <Chrome
        narrow={narrow || compact}
        ready={ready}
        consent={consent}
        slots={{
          miniMonth: (
            <MiniMonth
              anchor={state.anchorDay}
              events={visibleEvents(data.miniEvents, state.hiddenCals)}
              onPickDay={pickDay}
              onStep={step}
            />
          ),
          calendars: (
            <CalendarList
              calendars={data.calendars}
              hidden={state.hiddenCals}
              hueFor={hueFor}
              onToggle={toggleCalendar}
            />
          ),
          // Never offer toggles over facts the app does not have.
          dayContext: layersReady ? (
            <LayerToggles layers={layers} onToggle={toggleLayer} />
          ) : (
            <span>{RAIL_DAY_CONTEXT_EMPTY}</span>
          ),
          searchField: searchOpen ? (
            <SearchField
              value={state.search}
              onSearch={(value) => logic.applySearchInput(value)}
              onClose={closeSearch}
            />
          ) : null,
          stateRow,
          canvas,
          detail: selected ? (
            <EventDetail
              key={rowKey(selected)}
              event={selected}
              calendarName={
                data.calById.get(selected.calendar_id as string)?.name
              }
              hue={hueFor(selected.calendar_id)}
              pending={pendingFor(selected)}
              onClose={() => {
                stateRef.current.selectedId = null;
                bump();
              }}
              onEdit={() => openEditor(rowKey(selected))}
              onRsvp={(partyId: string, answer: RsvpAnswer) =>
                void logic.respondRsvp(selected.event_id, partyId, answer)
              }
              onCancel={() => void logic.cancelEvent(selected.event_id)}
              onAttach={() => {
                logic.setAttachTarget(selected.event_id);
                attachInputRef.current?.click();
              }}
              onDetach={(attachmentId: string) =>
                void logic.removeAttachment(attachmentId)
              }
            />
          ) : null,
          overlays,
          // The rail's filters where there is no rail — never a second Search.
          moreSheet: moreOpen ? (
            <CalendarSheet
              calendars={data.calendars}
              hidden={state.hiddenCals}
              hueFor={hueFor}
              onToggleCalendar={toggleCalendar}
              onClose={() => setMoreOpen(false)}
            />
          ) : null,
        }}
      />
    </div>
  );
}
