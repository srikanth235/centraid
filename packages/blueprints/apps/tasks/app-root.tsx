// governance: allow-repo-hygiene file-size-limit — this file holds the room's whole orchestration as one React tree by design (#834); splitting it belongs to the app's own code evolution, not this rebuild.
// Tasks — the commitments room, query-free React tree (#505, rebuilt for
// #834). Holds `Root` plus every constant and helper it needs that does NOT
// depend on the node-side `./queries/*` handler modules; `app-inline.tsx` pairs
// it with those and with the pending projection.
//
// THE STATE IDIOM IS DOCS'. A mutable bag in a ref plus a bump reducer, because
// the room is one tree with a dozen routes over one read: putting twenty
// independent `useState`s over the same board would make "the board changed"
// twenty renders instead of one, and would put the ordering of those renders
// beyond anyone's reach. What genuinely belongs to React — has a read landed,
// is the vault denied, how wide is the pane — stays `useState`.
//
// EVERY FRAME CONTRIBUTION COMES FROM AN EFFECT. The bar and the band render
// ABOVE this app, so contributing during render would be updating a component
// that is already painting.
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

import {
  debounce,
  observeWidth,
  onDataChange,
  onFocusRefresh,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { readPendingOverlay } from "../_shared/pending-overlay.ts";
import {
  canWriteScope,
  mountedScopes,
  ownScopeId,
} from "../_shared/scope-kit.ts";
import type { ScopeSearchReach } from "../_shared/search-scaffold.ts";
import { libraryReachability } from "../_shared/view-state-kit.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { Board } from "./components/Board.tsx";
import type { RowContext } from "./components/Board.tsx";
import { Confirm } from "./components/Confirm.tsx";
import { Editor } from "./components/Editor.tsx";
import { MoreSheet, QuickAdd, Shortcuts } from "./components/Panels.tsx";
import { Rail } from "./components/Rail.tsx";
import {
  ConsentGate,
  LogbookRoute,
  NotifyRoute,
  ProjectRoute,
  ProjectsRoute,
  ReentryRoute,
  SearchRoute,
} from "./components/Screens.tsx";
import { EmptyState, Notices } from "./components/States.tsx";
import { dayKey, weekdayName } from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import {
  absence,
  allGroups,
  anytimeGroups,
  boardState,
  inboxGroup,
  isOpen,
  landsToday,
  reentryBuckets,
  todayGroups,
  upcomingGroups,
  windowEnd,
} from "./logic.ts";
import { readBoard } from "./scope-fanout.ts";
import {
  ALL,
  ANYTIME,
  INBOX,
  LOGBOOK,
  NOTIFY,
  PROJECT,
  PROJECTS,
  REENTRY,
  SEARCH,
  TASK,
  UPCOMING,
  projectIdFrom,
  projectShelf,
  railShelf,
  shelfFromSegment,
  showsBoard,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { AppState, BoardData, Overlay, Task } from "./types.ts";
import {
  DONE,
  GROUPS,
  REENTRY_BUCKETS,
  REMINDER_NOTE_B,
  SEARCH_COPY,
  doneNext,
  inboxMeta,
} from "./view-copy.ts";

/** The vault entities this app's queries read — the shell's change-subscription
 *  filter. */
export const CHANGE_TABLES = [
  "schedule.task",
  "schedule.project",
  "schedule.section",
  "core.tag",
  "core.concept",
  "core.attachment",
  "core.content_item",
  "core.link",
];

interface BoardResult extends Partial<BoardData> {
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string } | null;
  reach?: ScopeSearchReach[];
}

/** The palette slots a project dot may take — a CONTENT marker, assigned by
 *  position so two projects are never the same colour by accident. */
const PROJECT_HUES = [
  "ochre",
  "teal",
  "violet",
  "forest",
  "indigo",
  "rose",
  "amber",
  "slate",
];

function makeState(): AppState {
  return {
    search: "",
    searchResults: null,
    searchStatus: "resting",
    searchSeq: 0,
    searchScope: "everywhere",
    boardWindow: 500,
    boardTruncated: false,
    boardReach: [],
    openTaskId: null,
    collapsed: new Set<string>(),
    cursorId: null,
    overlay: null,
    landsIn: null,
    narrow: false,
  };
}

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [shelf, setShelf] = useState<ShelfId>(null);
  const [narrow, setNarrow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  // The clock the whole room reads. One value per read rather than a fresh
  // `Date.now()` per render, so a group header and the rows under it cannot
  // straddle midnight and disagree about what "today" is.
  const [now, setNow] = useState(() => new Date().toISOString());

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const captureRef = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const readFailedRef = useRef(false);
  const stateRef = useRef<AppState>(makeState());
  const dataRef = useRef<BoardData>({
    open: [],
    logbook: [],
    counts: {},
    projects: [],
    sections: [],
    tags: [],
    window: 500,
  });

  const state = stateRef.current;
  const data = dataRef.current;

  const refresh = useCallback(async (): Promise<void> => {
    let next: BoardResult;
    try {
      next = (await readBoard({
        limit: stateRef.current.boardWindow,
      })) as BoardResult;
    } catch {
      readFailedRef.current = true;
      setReadFailedState(true);
      setLoaded(true);
      return;
    }
    readFailedRef.current = false;
    setReadFailedState(false);
    const denied = next?.vaultDenied;
    setConsent(denied ? { message: denied.message ?? "" } : null);
    setNow(new Date().toISOString());
    setLoaded(true);
    if (denied) {
      bump();
      return;
    }
    // Mutated in place, never reassigned: the closures below hold this object.
    const board = dataRef.current;
    board.open = next.open ?? [];
    board.logbook = next.logbook ?? [];
    board.projects = next.projects ?? [];
    board.sections = next.sections ?? [];
    board.tags = next.tags ?? [];
    board.counts = next.counts ?? {};
    board.window = next.window ?? board.window;
    stateRef.current.boardTruncated = Boolean(next.truncated);
    stateRef.current.boardReach = next.reach ?? [];
    bump();
  }, []);

  /** Every write goes through one door, so every outcome lands on the ONE
   *  status line and every failure is narrated rather than swallowed. */
  const act = useCallback(
    async (
      action: string,
      input: Record<string, unknown>,
      outcome?: string
    ): Promise<void> => {
      try {
        await window.centraid.write({ action, input });
        if (outcome) publishOutcome(frame, { text: outcome });
      } catch (error) {
        publishOutcome(frame, {
          text: String((error as { message?: string })?.message ?? error),
        });
        return;
      }
      await refresh();
    },
    [frame, refresh]
  );

  // ──── first read, live changes, focus recovery, width ──────────────────────

  useEffect(() => {
    void refresh();
    const stopChanges = onDataChange(CHANGE_TABLES, () => void refresh());
    const stopFocus = onFocusRefresh(() => void refresh());
    return () => {
      stopChanges?.();
      stopFocus?.();
    };
  }, [refresh]);

  useEffect(() => {
    const element = rootElRef.current;
    if (!element) return;
    return observeWidth(element, 720, (isNarrow: boolean) => {
      stateRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
    });
  }, []);

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef]
  );

  // ──── what the room knows about itself ────────────────────────────────────

  const reach = libraryReachability({
    hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
    readFailed: readFailedState,
  });

  const scopes = mountedScopes();
  const own = ownScopeId(scopes);
  const projectById = useMemo(
    () =>
      new Map(data.projects.map((project) => [project.project_id, project])),
    [data.projects]
  );
  const hueOf = useCallback(
    (projectId: string | null | undefined): string | null => {
      if (!projectId) return null;
      const index = data.projects.findIndex(
        (project) => project.project_id === projectId
      );
      return index < 0
        ? null
        : (PROJECT_HUES[index % PROJECT_HUES.length] ?? null);
    },
    [data.projects]
  );

  const pendingWriteCount = data.open.filter((task) =>
    readPendingOverlay(task as unknown as Record<string, unknown>)
  ).length;

  // A scope that could not be asked is a NAMED slice of the board that is
  // missing, never rows that quietly are not there (#726).
  const unreachedScope = state.boardReach.find(
    (entry) => entry.state !== "reached"
  );
  const unreachedLabel = scopes.find(
    (scope) => scope.id === unreachedScope?.scope
  )?.label;
  const ownOpen = data.open.filter(
    (task) => (task.scope_id ?? own) === own
  ).length;

  const away = absence(data.open, now);

  // ──── navigation ───────────────────────────────────────────────────────────

  const go = useCallback((next: ShelfId) => {
    setShelf(next);
    stateRef.current.overlay = null;
    stateRef.current.cursorId = null;
    bump();
  }, []);

  const openTask = useCallback((taskId: string) => {
    stateRef.current.openTaskId = taskId;
    setShelf(TASK);
    bump();
  }, []);

  const openSearch = useCallback(() => {
    go(SEARCH);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [go]);

  const openQuickAdd = useCallback(() => {
    stateRef.current.overlay = { kind: "quick-add" };
    bump();
    requestAnimationFrame(() => captureRef.current?.focus());
  }, []);

  const closeOverlay = useCallback(() => {
    stateRef.current.overlay = null;
    bump();
  }, []);

  // ──── the acts ─────────────────────────────────────────────────────────────

  const complete = useCallback(
    (task: Task) => {
      // A repeating task's check-off says where the next one landed: the
      // outcome carries `next_due`, which the query already collapsed. It is
      // never re-derived here — one summariser, one answer.
      const text =
        task.rrule && task.next_due
          ? doneNext(weekdayName(task.next_due))
          : DONE;
      void window.centraid
        .write({
          action: "set-status",
          input: { task_id: task.task_id, status: "completed" },
        })
        .then(() => {
          publishOutcome(frame, {
            text,
            // Undo IS reopening — the status goes back to needs-action rather
            // than a second, parallel notion of "undone".
            undo: () => {
              void act("set-status", {
                task_id: task.task_id,
                status: "needs-action",
              });
            },
          });
          return refresh();
        })
        .catch((error: unknown) => {
          publishOutcome(frame, { text: String(error) });
        });
    },
    [act, frame, refresh]
  );

  const reopen = useCallback(
    (task: Task) => {
      void act("set-status", { task_id: task.task_id, status: "needs-action" });
    },
    [act]
  );

  const moveToToday = useCallback(
    (rows: readonly Task[]) => {
      const due = dayKey(now);
      for (const task of rows) {
        void act("edit", { task_id: task.task_id, due_at: due });
      }
    },
    [act, now]
  );

  const release = useCallback(
    (taskId: string) => {
      void act("set-status", { task_id: taskId, status: "cancelled" });
    },
    [act]
  );

  const removeTask = useCallback(
    (taskId: string) => {
      // The platform destroys on its own schedule; releasing a task is what a
      // member means by "delete this" and what the vault records.
      void act("set-status", { task_id: taskId, status: "cancelled" });
    },
    [act]
  );

  /** Recurrence anchor and filing both travel through `organize-task`, the ONE
   *  door for them — and it needs `sort_order`, so the row's own is preserved
   *  rather than reset to zero behind the member's manual order. */
  const organize = useCallback(
    (task: Task, patch: Record<string, unknown>) => {
      void act("organize-task", {
        task_id: task.task_id,
        sort_order: task.sort_order ?? 0,
        ...patch,
      });
    },
    [act]
  );

  const applySearch = useMemo(
    () =>
      debounce(async () => {
        const field = searchRef.current;
        if (!field) return;
        const term = field.value.trim();
        const bag = stateRef.current;
        if (term === bag.search) return;
        bag.search = term;
        if (!term) {
          bag.searchResults = null;
          bag.searchStatus = "resting";
          bump();
          return;
        }
        const seq = ++bag.searchSeq;
        bag.searchStatus = "searching";
        bump();
        let rows: Task[] = [];
        let reached = true;
        try {
          const result = await window.centraid.read<{ tasks?: Task[] }>({
            query: "search",
            input: { term },
          });
          rows = result?.tasks ?? [];
        } catch {
          // A THROW IS NOT AN EMPTY RESULT SET: the index lives on the gateway,
          // and "nothing matches" would be a claim nobody verified.
          reached = false;
        }
        if (seq !== bag.searchSeq) return;
        bag.searchResults = reached ? rows : null;
        bag.searchStatus = reached ? "ready" : "unreachable";
        bump();
      }, 150),
    []
  );

  // ──── the keyboard map (§7) ────────────────────────────────────────────────

  useEffect(() => {
    const rows = (): Task[] => dataRef.current.open.filter(isOpen);
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(?:INPUT|TEXTAREA)$/u.test(target.tagName)) {
        if (event.key === "Escape") closeOverlay();
        return;
      }
      const bag = stateRef.current;
      const list = rows();
      const index = list.findIndex((task) => task.task_id === bag.cursorId);
      const focused = index >= 0 ? list[index] : undefined;
      switch (event.key) {
        case "q":
        case "c":
          openQuickAdd();
          break;
        case "/":
          event.preventDefault();
          openSearch();
          break;
        case "t":
          if (focused) moveToToday([focused]);
          break;
        case "e":
          if (focused) complete(focused);
          break;
        case "j":
        case "k": {
          const step = event.key === "j" ? 1 : -1;
          const next =
            list[Math.max(0, Math.min(list.length - 1, index + step))];
          bag.cursorId = next?.task_id ?? bag.cursorId;
          bump();
          break;
        }
        case "1":
        case "2":
        case "3":
        case "4":
          if (focused) {
            void act("edit", {
              task_id: focused.task_id,
              priority: Number(event.key) - 1,
            });
          }
          break;
        case "Escape":
          closeOverlay();
          break;
        case "?":
          stateRef.current.overlay = { kind: "shortcuts" };
          bump();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, closeOverlay, complete, moveToToday, openQuickAdd, openSearch]);

  // ──── the rows this route paints ──────────────────────────────────────────

  const rowCtx: RowContext = {
    now,
    projectName: (id) => projectById.get(id ?? "")?.name ?? null,
    projectHue: (id) => hueOf(id),
    isShared: (task) => Boolean(task.scope_id) && task.scope_id !== own,
    collapsed: (taskId) => stateRef.current.collapsed.has(taskId),
    cursorId: state.cursorId,
    onToggleFamily: (taskId) => {
      const set = stateRef.current.collapsed;
      if (set.has(taskId)) set.delete(taskId);
      else set.add(taskId);
      bump();
    },
    onOpen: openTask,
    onComplete: complete,
    onReopen: reopen,
  };

  const openProjectId = projectIdFrom(shelf);
  const projectRows = data.open.filter(
    (task) => task.project_id === openProjectId
  );
  const dayLabel = useCallback((day: string) => weekdayName(day), []);
  const projectNameOf = useCallback(
    (id: string | null | undefined) =>
      projectById.get(id ?? "")?.name ?? GROUPS.inbox,
    [projectById]
  );

  const groups = (() => {
    if (shelf === UPCOMING) return upcomingGroups(data.open, now, dayLabel);
    if (shelf === ANYTIME) return anytimeGroups(data.open, projectNameOf);
    if (shelf === ALL) return allGroups(data.open);
    if (shelf === INBOX) {
      const group = inboxGroup(data.open);
      return group.rows.length > 0 ? [group] : [];
    }
    if (openProjectId || shelf === PROJECT) return [];
    return todayGroups(data.open, now);
  })();

  const state12 = boardState({
    loaded,
    denied: consent !== null,
    rows: data.open,
    logbook: data.logbook,
    projects: data.projects,
    now,
  });

  const nextDue = data.open
    .filter((task) => isOpen(task) && !landsToday(task, now))
    .map((task) => task.next_due ?? task.due_at ?? "")
    .filter(Boolean)
    .toSorted()[0];

  const emptyBlock = (
    <EmptyState
      variant={
        state12 === "day-one"
          ? "day-one"
          : state12 === "all-done"
            ? "all-done"
            : "nothing-scheduled"
      }
      nextDay={nextDue ? weekdayName(nextDue) : null}
      onQuickAdd={openQuickAdd}
      onNewProject={() => void act("save-project", { name: GROUPS.inbox })}
      {...(away ? { onCatchUp: () => go(REENTRY) } : {})}
    />
  );

  const boardBody = (
    <Board
      groups={groups}
      ctx={rowCtx}
      narrow={narrow}
      overdueVerbs={[
        {
          label: GROUPS.moveAll,
          run: () =>
            moveToToday(groups.find((group) => group.attention)?.rows ?? []),
        },
        { label: GROUPS.catchUp, run: () => go(REENTRY) },
      ]}
      windowEnd={windowEnd(data, state.boardTruncated)}
      onShowMore={() => {
        stateRef.current.boardWindow += 500;
        void refresh();
      }}
      empty={emptyBlock}
    />
  );

  const openTaskRow =
    data.open.find((task) => task.task_id === state.openTaskId) ??
    data.logbook.find((task) => task.task_id === state.openTaskId);

  const scroll = ((): ReactNode => {
    if (consent) {
      return (
        <ConsentGate
          receipt={consent.message}
          scope="schedule.task"
          when={now.slice(0, 16).replace("T", " ")}
          onWhatWeHold={() => go(null)}
        />
      );
    }
    if (shelf === PROJECTS) {
      return (
        <ProjectsRoute
          projects={data.projects}
          counts={Object.fromEntries(
            data.projects.map((project) => [
              project.project_id,
              data.open.filter(
                (task) => task.project_id === project.project_id && isOpen(task)
              ).length,
            ])
          )}
          projectHue={(project) => hueOf(project.project_id)}
          onOpen={(projectId) => go(projectShelf(projectId))}
          onNewProject={() => void act("save-project", { name: GROUPS.inbox })}
        />
      );
    }
    if (openProjectId || shelf === PROJECT) {
      return (
        <ProjectRoute
          sections={data.sections.filter(
            (section) => section.project_id === openProjectId
          )}
          rows={projectRows}
          ctx={rowCtx}
          narrow={narrow}
          onAddSection={() =>
            void act("save-section", {
              project_id: openProjectId ?? "",
              name: GROUPS.today,
            })
          }
          onAddTask={openQuickAdd}
        />
      );
    }
    if (shelf === REENTRY) {
      return (
        <ReentryRoute
          days={away?.days ?? 0}
          due={away?.due ?? 0}
          buckets={reentryBuckets(data.open, now, REENTRY_BUCKETS)}
          ctx={rowCtx}
          narrow={narrow}
          onBulk={(bucket) => moveToToday(bucket.rows)}
        />
      );
    }
    if (shelf === LOGBOOK) {
      return (
        <LogbookRoute
          groups={[{ key: "logbook", label: GROUPS.dated, rows: data.logbook }]}
          ctx={rowCtx}
          narrow={narrow}
          total={String(data.counts.closed ?? data.logbook.length)}
        />
      );
    }
    if (shelf === SEARCH) {
      return (
        <SearchRoute
          status={state.searchStatus}
          scope={state.searchScope}
          rows={state.searchResults ?? []}
          ctx={rowCtx}
          narrow={narrow}
          inputRef={(el) => {
            searchRef.current = el;
          }}
          onInput={applySearch}
          onScope={(scope) => {
            stateRef.current.searchScope = scope;
            bump();
          }}
        />
      );
    }
    if (shelf === NOTIFY) {
      return (
        <NotifyRoute
          title={data.open[0]?.title ?? SEARCH_COPY.placeholder}
          when={now.slice(11, 16)}
          supported={false}
          note={REMINDER_NOTE_B}
        />
      );
    }
    if (shelf === TASK && openTaskRow) {
      return (
        <Editor
          task={openTaskRow}
          now={now}
          projects={data.projects}
          home={null}
          onTitle={(title) =>
            void act("edit", { task_id: openTaskRow.task_id, title })
          }
          onPriority={(priority) =>
            void act("edit", { task_id: openTaskRow.task_id, priority })
          }
          onEffort={(effort_min) =>
            void act("edit", { task_id: openTaskRow.task_id, effort_min })
          }
          onAnchor={(anchor) =>
            organize(openTaskRow, {
              recurrence_anchor: anchor,
              recurrence_tz:
                openTaskRow.recurrence_tz ??
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            })
          }
          onProject={(projectId) =>
            organize(
              openTaskRow,
              projectId ? { project_id: projectId } : { clear_project: true }
            )
          }
          onAddTag={(label) =>
            void act("add-tag", { task_id: openTaskRow.task_id, label })
          }
          onRemoveTag={(tagId) => void act("remove-tag", { tag_id: tagId })}
          onAttach={() =>
            void act("attach", { subject_id: openTaskRow.task_id })
          }
          onDetach={(attachmentId) =>
            void act("detach", { attachment_id: attachmentId })
          }
          onPromote={() =>
            void act("save-project", { name: openTaskRow.title })
          }
          onRelease={() => {
            stateRef.current.overlay = {
              kind: "release",
              taskId: openTaskRow.task_id,
            };
            bump();
          }}
          onDelete={() => {
            stateRef.current.overlay = {
              kind: "delete",
              taskId: openTaskRow.task_id,
            };
            bump();
          }}
        />
      );
    }
    return boardBody;
  })();

  // ──── the overlays ─────────────────────────────────────────────────────────

  const overlay: Overlay | null = state.overlay;
  const writeTarget = state.landsIn ?? own;
  const overlays = ((): ReactNode => {
    if (overlay?.kind === "quick-add") {
      const blocked = !canWriteScope(writeTarget);
      return (
        <QuickAdd
          narrow={narrow}
          place={
            openProjectId
              ? (projectById.get(openProjectId)?.name ?? GROUPS.inbox)
              : GROUPS.inbox
          }
          scopes={scopes.map((scope) => ({
            id: scope.id,
            label: scope.label,
            canWrite: scope.canWrite,
          }))}
          landsIn={state.landsIn}
          onLandsIn={(scopeId) => {
            stateRef.current.landsIn = scopeId;
            bump();
          }}
          priority={0}
          onPriority={() => bump()}
          {...(blocked ? { disabledReason: REMINDER_NOTE_B } : {})}
          inputRef={(el) => {
            captureRef.current = el;
          }}
          onCancel={closeOverlay}
          onAdd={() => {
            const title = captureRef.current?.value.trim();
            if (!title) return;
            closeOverlay();
            void act("add", {
              title,
              // add_task does not take project_id; membership is organize-task.
              ...(shelf === null ? { due_at: dayKey(now) } : {}),
            });
          }}
        />
      );
    }
    if (overlay?.kind === "release" || overlay?.kind === "delete") {
      const taskId = overlay.taskId;
      return (
        <Confirm
          kind={overlay.kind}
          onCancel={closeOverlay}
          onConfirm={() => {
            closeOverlay();
            if (overlay.kind === "release") release(taskId);
            else removeTask(taskId);
          }}
        />
      );
    }
    if (overlay?.kind === "shortcuts") {
      return <Shortcuts onClose={closeOverlay} />;
    }
    return null;
  })();

  // ──── what Tasks contributes to the FRAME ─────────────────────────────────

  const handedOff = compact || narrow;
  const barCountValue = showsBoard(shelf)
    ? groups.reduce((sum, group) => sum + group.rows.length, 0)
    : null;
  const projectTitle = openProjectId
    ? projectById.get(openProjectId)?.name
    : undefined;

  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf,
        ...(projectTitle ? { projectName: projectTitle } : {}),
        count: barCountValue,
        compact: handedOff,
        onSearch: openSearch,
        // Withheld while the capture panel is open: the panel's own Add is the
        // one filled control then, and two filled buttons is two answers to
        // one question.
        ...(overlay === null ? { onQuickAdd: openQuickAdd } : {}),
      })
    );
  }, [
    frame,
    shelf,
    projectTitle,
    barCountValue,
    handedOff,
    openSearch,
    openQuickAdd,
    overlay,
  ]);

  useEffect(() => {
    if (!narrow) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(
        railShelf(shelf),
        (segment) => go(shelfFromSegment(segment)),
        () => {
          stateRef.current.overlay = { kind: "more" };
          bump();
        }
      )
    );
  }, [frame, shelf, narrow, go]);

  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
    };
  }, [frame]);

  return (
    <div
      ref={setRoot}
      data-gateway-status={reach === "unreachable" ? "down" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome
        narrow={narrow}
        loading={!loaded}
        consent={consent}
        slots={{
          rail: narrow ? null : (
            <Rail
              current={railShelf(shelf)}
              counts={{
                null: todayGroups(data.open, now).reduce(
                  (sum, group) => sum + group.rows.length,
                  0
                ),
                [String(UPCOMING)]: upcomingGroups(data.open, now, dayLabel)
                  .length,
                [String(ANYTIME)]: anytimeGroups(data.open, projectNameOf)
                  .length,
                [String(ALL)]: data.open.filter(isOpen).length,
                [String(INBOX)]: inboxGroup(data.open).rows.length,
              }}
              projects={data.projects}
              projectHue={(project) => hueOf(project.project_id)}
              onSelect={go}
            />
          ),
          toolbar: showsBoard(shelf) ? (
            <span className="kit-small">{inboxMeta(barCountValue ?? 0)}</span>
          ) : null,
          notices: (
            <Notices
              absence={away}
              onCatchUp={() => go(REENTRY)}
              staleAt={reach === "unreachable" ? now.slice(11, 16) : null}
              onRefresh={() => void refresh()}
              partial={
                unreachedScope
                  ? { vault: unreachedLabel ?? "House", own: ownOpen }
                  : null
              }
              onRetry={() => void refresh()}
              pendingWriteCount={pendingWriteCount}
            />
          ),
          scroll,
          overlays,
          moreSheet:
            overlay?.kind === "more" ? (
              <MoreSheet onSelect={go} onClose={closeOverlay} />
            ) : null,
        }}
      />
    </div>
  );
}
