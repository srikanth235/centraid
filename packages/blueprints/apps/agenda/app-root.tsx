// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505/#834); the views, the rail, the editor and the states each live in their own module and this is the wiring between them.
// Agenda — query-free React tree. Holds the `Root` component and everything it
// needs that does NOT depend on the node-side `./queries/*` modules; the
// `app-inline.tsx` descriptor pairs this with the query wiring.
//
// THE APP IS A ROUTE INSIDE THE FRAME. It draws no bar, no status line and no
// navigation column of its own: the range, the view switcher and the one
// filled verb are contributed through `frame.tsx`, outcomes go to the frame's
// single status line, and the shell's stem is the only navigation.
//
// WAVE BOUNDARY. The day-context layers — birthdays from People, due tasks
// from Tasks, subscribed holidays — are NOT dispatched here. The seams they
// mount into are real and named: `Chrome`'s `dayContext` rail slot, and the
// `dayRibbon` / `dayShelf` props the grids and the lists already accept.

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
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { EventDetail } from "./components/EventDetail.tsx";
import { EventEditor } from "./components/EventEditor.tsx";
import { MonthGrid, TimeGrid } from "./components/Grid.tsx";
import { ListView } from "./components/ListViews.tsx";
import { MoreSheet } from "./components/MoreSheet.tsx";
import { QuickAdd } from "./components/QuickAdd.tsx";
import { CalendarList, MiniMonth } from "./components/Rail.tsx";
import { EmptyState } from "./components/Shared.tsx";
import type { RsvpAnswer } from "./edits.ts";
import { calendarHue, localDayKey, rangeLabel } from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { createLogic } from "./logic.ts";
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

/** The vault entities this app's queries read — the shell's change-subscription
 *  filter, unchanged by the rebuild. */
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
  // The day-context projection's own entities (#834 R-daycontext): open tasks
  // coming due, and the starred-flag vocabulary that answers a birthday's
  // relationship tier. Without them a completed task or a newly starred
  // person would leave the grid's decorations stale until the next nav.
  "schedule.task",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
];

/** The `upcoming` payload. A consent denial rides `vaultDenied` — a first-class
 *  outcome, never an error. */
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
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  /** A read that actually came back FAILED — the only honest evidence this app
   *  has for "the gateway is out of reach". */
  const [readFailedState, setReadFailedState] = useState(false);
  /** Calendars whose slice the vault refused. A PARTIAL denial is a normal
   *  state and it names the slice; it never pretends the merge was whole. */
  const [deniedCalendars, setDeniedCalendars] = useState<readonly string[]>([]);

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

  const state = stateRef.current;
  const data = dataRef.current;

  /**
   * One read per paint. The canvas range and the rail's mini month usually
   * coincide (Month), and where they do not the mini month is served from the
   * same rows rather than by a second read — a rail is decoration, and a
   * decoration that doubles the vault traffic is a defect.
   */
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
      // Mutate `data` in place (never reassign): logic.ts closed over this
      // exact object at boot.
      store.events = next.events ?? [];
      store.miniEvents = store.events;
      store.calendars = next.calendars ?? [];
      store.calById = new Map(
        store.calendars.map((cal): [string, Calendar] => [cal.calendar_id, cal])
      );
      // A calendar the read named but returned no rows for is NOT a denial;
      // a calendar the read could not see at all is. The query answers the
      // second by omitting it from `calendars` while events still reference
      // it, so that is exactly what is counted here.
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

    const range = rangeForView(
      resolveView(stateRef.current.view, compact),
      stateRef.current.anchorDay
    );
    try {
      const read = window.centraid.read<UpcomingData>({
        query: "upcoming",
        input: range,
      });
      replaceLive([subscribeReadUpdates<UpcomingData>(read, apply)]);
      apply(await read);
    } catch {
      if (seq !== loadSeqRef.current) return;
      // The attempted live read never established a dependency. Drop the
      // listener so a later doorbell can retry rather than leaving this view
      // inert. A BROKEN VAULT MUST NOT LOOK LIKE AN EMPTY ONE.
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

  /** The invite directory, read ONCE and only when a composer needs it. The
   *  boot read stays a single query, and a member who never opens the editor
   *  never asks People for anything. */
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
        // A denied directory leaves the picker empty; it never takes the
        // editor down with it.
      });
  }, [data]);

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
      if (el) {
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

  // ---- navigation ----
  const view = resolveView(state.view, compact || narrow);

  const setView = useCallback(
    (next: ViewKind) => {
      if (stateRef.current.view === next) return;
      stateRef.current.view = next;
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
          ? new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + direction * 7)
          : shown === "day"
            ? new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + direction)
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

  const toggleCalendar = useCallback((calendarId: string) => {
    const hidden = stateRef.current.hiddenCals;
    if (hidden.has(calendarId)) hidden.delete(calendarId);
    else hidden.add(calendarId);
    bump();
  }, []);

  // ---- overlays ----
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

  const pendingFor = useCallback(
    (ev: AgEvent) =>
      readPendingOverlay(ev as unknown as Record<string, unknown>) as
        | { status: string; action: string }
        | undefined,
    []
  );

  // ---- chrome wiring: attach input, doorbell, focus, width ----
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs
  }, []);

  // ---- derive ----
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
  const editing = state.editorId ? findEvent(data.events, state.editorId) : null;
  const searching = state.search.trim() !== "";

  let canvas: ReactNode;
  if (!loaded) {
    canvas = (
      <div ref={skeletonRef} className={styles.canvas}>
        <LoadingSkeleton rows={8} />
      </div>
    );
  } else if (consent) {
    // The banner above carries the way forward; the canvas draws nothing
    // rather than an empty grid pretending the vault answered.
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
      />
    );
  }

  // The second control row: what is true about this read. It renders only
  // where there is something to declare — an empty band is chrome.
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const stateRow: ReactNode =
    readFailedState || offline || deniedCalendars.length > 0 ? (
      <>
        {readFailedState ? (
          <>
            <span>{STATE_READ_FAILED}</span>
            <button type="button" className="kit-btn" onClick={() => void load()}>
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

  // ---- frame contributions, from EFFECTS only ----
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
        onSearch: () => setMoreOpen(true),
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
        (segment) => setView(segment as ViewKind),
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
      {state.quick ? (
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
              calendar_id: data.calendars[0]?.calendar_id ?? "",
            });
          }}
          onEdit={openCreate}
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
            closeOverlays();
            void logic.proposeEvent(payload);
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
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width — otherwise it collapses to content width and the
    // component-width narrow observer wrongly flips to the phone layout.
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
          // THE SEAM. One line until the layers mount here.
          dayContext: <span>{RAIL_DAY_CONTEXT_EMPTY}</span>,
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
          moreSheet:
            moreOpen && (compact || narrow) ? (
              <MoreSheet
                calendars={data.calendars}
                hidden={state.hiddenCals}
                hueFor={hueFor}
                search={state.search}
                onToggleCalendar={toggleCalendar}
                onSearch={(value) => logic.applySearchInput(value)}
                onClose={() => setMoreOpen(false)}
              />
            ) : null,
        }}
      />
    </div>
  );
}
