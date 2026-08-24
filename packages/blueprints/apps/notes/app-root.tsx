// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505/#834); every screen's BODY lives in its own component under ./components, and what is left here is the routing, the reads and the frame contributions.
// Notes — the query-free React tree (#505, rebuilt for #834).
//
// This file decides WHICH screen; each screen decides what it looks like
// (`components/*`). It holds the mutable state bag, the library read, the
// route switch and the three frame contributions — the app bar, the compact
// band and the one status line — and it draws nothing itself.
//
// The shell's `InlineAppModule` descriptor (`app-inline.tsx`) imports `Root`
// and `CHANGE_TABLES` from here and adds the query wiring; there is
// deliberately no parallel served entry point.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { SearchScaffold } from "../_shared/SearchScaffold.tsx";
import { libraryReachability } from "../_shared/view-state-kit.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { Editor } from "./components/Editor.tsx";
import { NoteSet } from "./components/Library.tsx";
import { Confirm, MoreSheet, Powerbox } from "./components/Overlays.tsx";
import {
  HistoryRoute,
  NotebooksRoute,
  Rail,
  TagsRoute,
  TrashRoute,
} from "./components/Places.tsx";
import {
  CaptureRoute,
  Conflict,
  DayOne,
  Denied,
  Skeletons,
  Stale,
  VoiceRoute,
  WindowEnd,
} from "./components/States.tsx";
import { hasConcurrentVersions } from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import {
  createLogic,
  notebookCounts,
  rowsFor,
  tagCounts,
  unfiledCount,
} from "./logic.ts";
import { probeAt } from "./powerbox.ts";
import {
  BOOKS,
  CAPTURE,
  HISTORY,
  JOURNAL,
  NOTE,
  SEARCH,
  TAGS,
  TRASH,
  VOICE,
  isEditing,
  notebookIdFrom,
  shelfFromSegment,
  showsViewToggle,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { AppData, AppState, LinkTarget, Note, Notebook } from "./types.ts";
import {
  DELETE_NOTE_BODY,
  DELETE_NOTE_TITLE,
  DELETE_NOTE_VERB,
  DELETE_NOTEBOOK_KEPT,
  DELETE_NOTEBOOK_VERB,
  SEARCH_COPY,
  SEARCH_EXAMPLES,
  SEARCH_SCOPE,
  captionFor,
  deleteNotebookBody,
  deleteNotebookTitle,
  editorStatus,
  historyStatus,
  pendingStatus,
  searchNoMatch,
} from "./view-copy.ts";

import styles from "./Chrome.module.css";

/** The vault entities this app's queries read — the shell's change filter.
 *  The concept scheme joins the list with the Journal place: its marker is a
 *  concept in a scheme, so a change there changes what Journal holds. */
export const CHANGE_TABLES = [
  "knowledge.note",
  "core.content_item",
  "core.attachment",
  "core.link",
  "core.link_anchor",
  "core.collection",
  "core.collection_entry",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
];

interface LibraryResult {
  notes?: Note[];
  trash?: Note[];
  notebooks?: Notebook[];
  tags?: Array<{ concept_id: string; label: string }>;
  truncated?: boolean;
  window?: number;
  vaultDenied?: { message?: string } | null;
}

interface JournalResult {
  entries?: Note[];
  vaultDenied?: { message?: string } | null;
}

/** The default arrangement comes from the app's own knob; `masonry` is the
 *  knob's word for the card wall. */
function initialView(rootEl: HTMLElement | null): AppState["view"] {
  return rootEl?.dataset.appDefaultView === "list" ? "list" : "cards";
}

function makeState(view: AppState["view"]): AppState {
  return {
    shelf: null,
    view,
    noteId: null,
    conceptId: null,
    unfiledOnly: false,
    search: "",
    searchScope: "everywhere",
    scopeNotebookId: null,
    searchResults: null,
    searchStatus: "resting",
    searchSeq: 0,
    powerbox: {
      open: false,
      term: "",
      targets: [],
      anchor: { exact: "", prefix: "", suffix: "", start: 0 },
    },
    versions: null,
    libraryWindow: 200,
    creatingNotebook: false,
    renamingNotebookId: null,
    queued: 0,
  };
}

interface Core {
  logic: ReturnType<typeof createLogic>;
  refresh: () => Promise<void>;
  refreshJournal: () => Promise<void>;
}

/** What a confirm is standing over. Both confirms are the same component
 *  and the same dialog; only the subject differs. */
type ConfirmTarget =
  | { kind: "note"; note: Note }
  | { kind: "notebook"; book: Notebook; notes: number }
  | null;

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmTarget>(null);
  // A read that actually came back FAILED — the only evidence this app has
  // for "the gateway is out of reach". A replica that answered but lagged is
  // the STALE state, which is a different sentence.
  const [readFailedState, setReadFailedState] = useState(false);

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const readFailedRef = useRef(false);
  const dataRef = useRef<AppData>({
    notes: [],
    trash: [],
    journal: [],
    notebooks: [],
    tags: [],
    truncated: false,
    window: 200,
  });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const coreRef = useRef<Core | null>(null);

  if (!coreRef.current) {
    const state = stateRef.current;
    const data = dataRef.current;
    const render = (): void => bump();
    let core = undefined as unknown as Core;

    const refresh = async (): Promise<void> => {
      let next: LibraryResult;
      try {
        next = await window.centraid.read<LibraryResult>({
          query: "library",
          input: { limit: state.libraryWindow },
        });
      } catch {
        readFailed(document.querySelector<HTMLElement>("#noticeBanner"));
        readFailedRef.current = true;
        setReadFailedState(true);
        setLoaded(true);
        return;
      }
      if (readFailedRef.current) {
        readFailedRef.current = false;
        core.logic.notice("");
      }
      setReadFailedState(false);
      const denied = next?.vaultDenied;
      setConsent(denied ? { message: denied.message ?? "" } : null);
      setLoaded(true);
      if (denied) {
        bump();
        return;
      }
      // Mutated in place — logic.ts closed over this exact object at boot.
      data.notes = next?.notes ?? [];
      data.trash = next?.trash ?? [];
      data.notebooks = next?.notebooks ?? [];
      data.tags = next?.tags ?? [];
      data.truncated = Boolean(next?.truncated);
      data.window = Number(next?.window ?? state.libraryWindow);
      bump();
    };

    const refreshJournal = async (): Promise<void> => {
      try {
        const answer = await window.centraid.read<JournalResult>({
          query: "journal",
          input: { limit: state.libraryWindow },
        });
        // The Journal place answers for itself: a denial here darkens Journal
        // and nothing else, because no other route reads this query.
        data.journal = answer?.vaultDenied ? [] : (answer?.entries ?? []);
      } catch {
        data.journal = [];
      }
      bump();
    };

    core = { refresh, refreshJournal } as Core;
    core.logic = createLogic({
      state,
      data,
      render,
      refresh: core.refresh,
      status: (text, undo) =>
        publishOutcome(frame, undo ? { text, undo } : { text }),
      go: (shelf) => {
        state.shelf = shelf;
        bump();
      },
    });
    coreRef.current = core;
  }

  const core = coreRef.current;
  const { logic } = core;
  const state = stateRef.current;
  const data = dataRef.current;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
      if (el) {
        const view = initialView(el);
        if (view !== stateRef.current.view) {
          stateRef.current.view = view;
          bump();
        }
      }
    },
    [rootRef]
  );

  /** Every navigation inside Notes clears what was open over it, and leaves
   *  the query behind on the route it belonged to. */
  const go = useCallback(
    (shelf: ShelfId) => {
      if (shelf !== SEARCH && state.search) logic.clearSearch();
      // Reaching Search FROM a notebook is what gives the scope pair its
      // second option; reaching it from anywhere else leaves Everywhere as
      // the only honest answer.
      if (shelf === SEARCH) {
        state.scopeNotebookId = notebookIdFrom(state.shelf);
        if (!state.scopeNotebookId) state.searchScope = "everywhere";
      }
      state.shelf = shelf;
      state.creatingNotebook = false;
      state.renamingNotebookId = null;
      setMoreOpen(false);
      if (shelf === JOURNAL) void core.refreshJournal();
      if (shelf === HISTORY && state.noteId)
        void logic.loadHistory(state.noteId);
      bump();
    },
    [core, logic, state]
  );

  const openSearch = useCallback(() => {
    go(SEARCH);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [go]);

  const newNote = useCallback(() => {
    void logic.createNote();
  }, [logic]);

  // ──── mount wiring: the doorbell, focus, width and the keyboard map ────
  useEffect(() => {
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void core.refresh());
    const stopFocus = onFocusRefresh(() => void core.refresh());

    const onKey = (event: globalThis.KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newNote();
        return;
      }
      if (meta && event.key === "1") {
        state.view = "cards";
        bump();
        return;
      }
      if (meta && event.key === "2") {
        state.view = "list";
        bump();
        return;
      }
      if (event.key === "Escape") {
        if (state.powerbox.open) {
          state.powerbox.open = false;
          bump();
          return;
        }
        setMoreOpen(false);
        setConfirming(null);
        return;
      }
      // `/` reaches Search, but never out of a field the member is typing in.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (event.key === "/" && !typing) {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);

    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) =>
          setNarrow(isNarrow)
        )
      : () => {};

    void core.refresh();
    return () => {
      window.removeEventListener("keydown", onKey);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  // ──── derive the render ────

  const shelf = state.shelf;
  const openNotebookId = notebookIdFrom(shelf);
  const openNotebookName = openNotebookId
    ? logic.notebookName(openNotebookId)
    : undefined;
  const rows = shelf === JOURNAL ? data.journal : rowsFor(data, state, shelf);
  const openNote = state.noteId ? logic.findNote(state.noteId) : null;
  const offline =
    libraryReachability({
      hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
      readFailed: readFailedState,
    }) === "unreachable";
  const searching = Boolean(state.search.trim());

  const onOpen = useCallback(
    (noteId: string) => void logic.openNote(noteId),
    [logic]
  );
  const onTogglePin = useCallback(
    (note: Note) => void logic.togglePin(note),
    [logic]
  );

  /** The powerbox, from the `[[` sigil and from the bar's filled Link — one
   *  sheet, two doors, and the same anchor in both. */
  const openPowerbox = useCallback(
    (
      anchor: {
        exact: string;
        prefix: string;
        suffix: string;
        start: number;
      } | null
    ) => {
      state.powerbox.open = true;
      state.powerbox.anchor = anchor ?? {
        exact: "",
        prefix: "",
        suffix: "",
        start: 0,
      };
      bump();
    },
    [state]
  );

  const onProbe = useCallback(
    (body: string, caret: number) => {
      const probe = probeAt(body, caret);
      if (!probe) return;
      state.powerbox.open = true;
      logic.probeTargets(probe.term);
      bump();
    },
    [logic, state]
  );

  const onPick = useCallback(
    (target: LinkTarget) => {
      const noteId = state.noteId;
      state.powerbox.open = false;
      bump();
      if (!noteId) return;
      const anchor = state.powerbox.anchor;
      void logic.linkNote(noteId, target, anchor.exact ? anchor : null);
    },
    [logic, state]
  );

  // A body edit is debounced INSIDE logic; the draft is the row itself, so
  // the editor paints from the same object the library does.
  const onEdit = useCallback(
    (patch: { title?: string; body_text?: string }) => {
      const noteId = state.noteId;
      if (!noteId) return;
      const note = logic.findNote(noteId);
      if (note) {
        if (patch.title != null) note.title = patch.title;
        if (patch.body_text != null) note.body = patch.body_text;
      }
      bump();
      logic.saveNote(noteId, patch);
    },
    [logic, state]
  );

  const runSearchInput = useCallback(
    (value: string) => {
      logic.runSearch(value);
    },
    [logic]
  );

  const onShowOlder = useCallback(() => {
    state.libraryWindow = Math.min(2000, state.libraryWindow * 2);
    void core.refresh();
  }, [core, state]);

  // ──── the route switch ────

  let routeBody: ReactNode;
  if (!loaded) {
    routeBody = <Skeletons />;
  } else if (consent) {
    routeBody = <Denied message={consent.message} />;
  } else if (shelf === BOOKS) {
    routeBody = (
      <NotebooksRoute
        notebooks={data.notebooks}
        counts={notebookCounts(data)}
        unfiled={unfiledCount(data)}
        creating={state.creatingNotebook}
        renamingId={state.renamingNotebookId}
        onOpen={go}
        onCreate={(name) => void logic.createNotebook(name)}
        onStartCreate={() => {
          state.creatingNotebook = true;
          bump();
        }}
        onRename={(id, name) => void logic.renameNotebook(id, name)}
        onStartRename={(id) => {
          state.renamingNotebookId = id;
          state.creatingNotebook = false;
          bump();
        }}
        onDelete={(book) =>
          setConfirming({
            kind: "notebook",
            book,
            notes: notebookCounts(data).get(book.notebook_id) ?? 0,
          })
        }
      />
    );
  } else if (shelf === TAGS) {
    routeBody = (
      <TagsRoute
        tags={data.tags}
        counts={tagCounts(data)}
        conceptId={state.conceptId}
        onSelectTag={(conceptId) => {
          state.conceptId = conceptId;
          state.shelf = null;
          bump();
        }}
      />
    );
  } else if (shelf === TRASH) {
    routeBody = (
      <TrashRoute
        notes={data.trash}
        onRestore={(noteId) => void logic.restoreNote(noteId)}
      />
    );
  } else if (shelf === HISTORY) {
    routeBody = (
      <HistoryRoute
        versions={state.versions ?? []}
        onRestore={(contentId) => {
          if (state.noteId) void logic.restoreVersion(state.noteId, contentId);
        }}
      />
    );
  } else if (shelf === CAPTURE) {
    // The origin acts belong to the phone. This seat states that rather than
    // drawing a camera button that cannot open one.
    routeBody = <CaptureRoute />;
  } else if (shelf === VOICE) {
    routeBody = <VoiceRoute />;
  } else if (shelf === NOTE && openNote) {
    routeBody = (
      <Editor
        note={openNote}
        body={typeof openNote.body === "string" ? openNote.body : undefined}
        onEdit={onEdit}
        onToggleCheck={(line) => {
          if (state.noteId) void logic.toggleCheck(state.noteId, line);
        }}
        onSendToTasks={(line, text) => {
          if (state.noteId)
            void logic.sendLineToTasks(state.noteId, line, text);
        }}
        onLink={openPowerbox}
        onProbe={onProbe}
        onAddTag={(label) => {
          if (state.noteId) void logic.addTag(state.noteId, label);
        }}
        onRemoveTag={(tagId) => void logic.removeTag(tagId)}
        onAttach={(file) => {
          if (state.noteId) void logic.attachFile(state.noteId, file);
        }}
        onDetach={(attachmentId) => void logic.removeAttachment(attachmentId)}
        onOpenHistory={() => go(HISTORY)}
        onDelete={() => setConfirming({ kind: "note", note: openNote })}
        onTogglePin={() => void logic.togglePin(openNote)}
      />
    );
  } else {
    routeBody = (
      <NoteSet
        notes={rows}
        view={state.view}
        onOpen={onOpen}
        onTogglePin={onTogglePin}
        {...(searching ? { search: state.search } : {})}
        empty={
          searching ? (
            <p className={styles.caption}>{searchNoMatch(state.search)}</p>
          ) : (
            <DayOne onNew={newNote} onCapture={() => go(CAPTURE)} />
          )
        }
        foot={
          data.truncated && !searching ? (
            <WindowEnd
              shown={rows.length}
              total={data.window}
              onMore={onShowOlder}
            />
          ) : null
        }
      />
    );
  }

  // The Search route is the row set under a field, with the shared four-state
  // scaffold above it — the same module Docs and Photos render, so two apps
  // do not grow two grammars for "nothing matches".
  const scroll = (
    <>
      {/* OFFLINE IS READ, NEVER INVENTED: the host stamps its own answer on
          this app's root (`data-gateway-status`), and a failed read is only
          the fallback evidence. A replica that ANSWERED but lagged is stale,
          which is this notice — not an error. */}
      {offline && loaded ? (
        <Stale
          at={new Date().toISOString().slice(11, 16)}
          onRefresh={() => void core.refresh()}
        />
      ) : null}
      {/* Two writes stamped at the same instant in the append-only chain —
          the only evidence of a conflict this vault hands over. Both bodies
          are already kept, so the panel reports and offers no fill. */}
      {shelf === NOTE && hasConcurrentVersions(state.versions ?? []) ? (
        <Conflict onOpenHistory={() => go(HISTORY)} />
      ) : null}
      {shelf === SEARCH ? (
        <>
          {/* THE FIELD IS THE SEARCH ROUTE'S OWN FIRST BLOCK, not chrome
              standing above every other route. The scaffold below it owns the
              four states and none of the placement. */}
          <input
            ref={searchInputRef}
            className={styles.field}
            type="search"
            aria-label="Search notes"
            defaultValue={state.search}
            onChange={(event) => runSearchInput(event.target.value)}
          />
          <SearchScaffold
            query={state.search}
            status={state.searchStatus}
            count={rows.length}
            scope={SEARCH_SCOPE}
            copy={SEARCH_COPY}
            examples={SEARCH_EXAMPLES}
            onQuery={runSearchInput}
            onClear={() => {
              if (searchInputRef.current) searchInputRef.current.value = "";
              logic.clearSearch();
            }}
            onRetry={() => runSearchInput(state.search)}
          >
            {routeBody}
          </SearchScaffold>
        </>
      ) : (
        routeBody
      )}
      {captionFor(shelf) ? (
        <p className={styles.caption}>{captionFor(shelf)}</p>
      ) : null}
    </>
  );

  const rail =
    narrow || compact ? null : (
      <div className={styles.rail}>
        <Rail
          shelf={shelf}
          notebooks={data.notebooks}
          counts={notebookCounts(data)}
          unfiled={unfiledCount(data)}
          tags={data.tags}
          tagCounts={tagCounts(data)}
          conceptId={state.conceptId}
          unfiledOnly={state.unfiledOnly}
          onSelect={go}
          onSelectTag={(conceptId) => {
            state.conceptId = conceptId;
            bump();
          }}
          onToggleUnfiled={() => {
            state.unfiledOnly = !state.unfiledOnly;
            state.shelf = null;
            bump();
          }}
        />
      </div>
    );

  const scopePair =
    shelf === SEARCH && state.scopeNotebookId ? (
      <div>
        {(["everywhere", "notebook"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            className="kit-btn"
            aria-pressed={state.searchScope === scope}
            onClick={() => {
              state.searchScope = scope;
              bump();
            }}
          >
            {scope === "everywhere" ? "Everywhere" : "This notebook"}
          </button>
        ))}
      </div>
    ) : null;

  const toolbar = showsViewToggle(shelf) ? (
    // The pair sits inside the chrome's own `role="toolbar"`, which is where
    // the row is named; a second group label here would announce the same
    // furniture twice.
    <div>
      <button
        type="button"
        className="kit-btn"
        aria-pressed={state.view === "cards"}
        onClick={() => {
          state.view = "cards";
          bump();
        }}
      >
        Cards
      </button>
      <button
        type="button"
        className="kit-btn"
        aria-pressed={state.view === "list"}
        onClick={() => {
          state.view = "list";
          bump();
        }}
      >
        List
      </button>
      {scopePair}
    </div>
  ) : null;

  const overlays = (
    <>
      <Powerbox
        open={state.powerbox.open}
        term={state.powerbox.term}
        targets={state.powerbox.targets}
        anchored={state.powerbox.anchor.exact !== ""}
        onTerm={(term) => {
          state.powerbox.term = term;
          logic.probeTargets(term);
          bump();
        }}
        onPick={onPick}
        onClose={() => {
          state.powerbox.open = false;
          bump();
        }}
      />
      <Confirm
        open={confirming !== null}
        title={
          confirming?.kind === "notebook"
            ? deleteNotebookTitle(confirming.book.name ?? "")
            : DELETE_NOTE_TITLE
        }
        lines={
          confirming?.kind === "notebook"
            ? [deleteNotebookBody(confirming.notes), DELETE_NOTEBOOK_KEPT]
            : [DELETE_NOTE_BODY]
        }
        verb={
          confirming?.kind === "notebook"
            ? DELETE_NOTEBOOK_VERB
            : DELETE_NOTE_VERB
        }
        destructive
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target?.kind === "note") void logic.deleteNote(target.note);
          if (target?.kind === "notebook")
            void logic.deleteNotebook(target.book.notebook_id);
        }}
        onClose={() => setConfirming(null)}
      />
    </>
  );

  // ──── what Notes contributes to the FRAME ────

  const barCountValue =
    shelf === NOTE || shelf === CAPTURE || shelf === VOICE ? null : rows.length;
  const onPrimary = useCallback(() => {
    if (isEditing(stateRef.current.shelf)) openPowerbox(null);
    else newNote();
  }, [newNote, openPowerbox]);

  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf,
        ...(openNotebookName ? { notebookName: openNotebookName } : {}),
        count: barCountValue,
        compact: compact && narrow,
        onSearch: openSearch,
        onPrimary,
      })
    );
  }, [
    frame,
    shelf,
    openNotebookName,
    barCountValue,
    compact,
    narrow,
    openSearch,
    onPrimary,
  ]);

  // The status line, per route. Three sentences and no fourth: what the
  // editor promises, what the chain promises, and what is still queued.
  useEffect(() => {
    if (state.queued > 0) {
      publishOutcome(frame, { text: pendingStatus(state.queued) });
      return;
    }
    if (shelf === HISTORY)
      publishOutcome(frame, {
        text: historyStatus((state.versions ?? []).length),
      });
    else if (shelf === NOTE)
      publishOutcome(frame, {
        text: editorStatus((state.versions ?? []).length),
      });
  }, [frame, shelf, state.queued, state.versions]);

  useEffect(() => {
    if (!narrow) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(
        shelf,
        (segment) =>
          segment === "search" ? openSearch() : go(shelfFromSegment(segment)),
        () => setMoreOpen((open) => !open)
      )
    );
  }, [frame, shelf, narrow, go, openSearch]);

  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
    };
  }, [frame]);

  return (
    // Fill the app pane so the chrome gets real width — otherwise it collapses
    // to content width and the width observer wrongly reads a phone.
    <div
      ref={setRoot}
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
        consent={consent}
        slots={{
          toolbar,
          rail,
          scroll,
          overlays,
          moreSheet: moreOpen ? (
            <MoreSheet
              shelf={shelf}
              onSelect={go}
              onClose={() => setMoreOpen(false)}
            />
          ) : null,
        }}
      />
    </div>
  );
}
