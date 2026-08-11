// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505); it is smaller than the served app.tsx + app-inline.tsx it replaces. Splitting it belongs to the app's own code evolution, not this migration.
// People — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. The shell's InlineAppModule
// descriptor imports `Root` and `CHANGE_TABLES` from here and adds the query
// wiring; there is deliberately no parallel served-system-app entry.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactElement } from "react";

import { identityColor } from "@centraid/design";

import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { Activity } from "./components/Activity.tsx";
import { AddPersonModal } from "./components/AddPersonModal.tsx";
import { Attention } from "./components/Attention.tsx";
import { BulkBar } from "./components/BulkBar.tsx";
import { Details } from "./components/Details.tsx";
import { GridCard } from "./components/Grid.tsx";
import { Journal } from "./components/Journal.tsx";
import { ListHead, ListRow, WindowFoot } from "./components/List.tsx";
import { NewMenu } from "./components/NewMenu.tsx";
import { Icon } from "./components/Shared.tsx";
import {
  JournalNav,
  ListList,
  SmartNav,
  Storage,
} from "./components/Sidebar.tsx";
import { StatusChips } from "./components/Toolbar.tsx";
import { TrashCard } from "./components/TrashCard.tsx";
import { avatarColor, listName } from "./format.ts";
import { I } from "./icons.ts";
import {
  closePopover,
  debounce,
  isPopoverOpen,
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
} from "./kit.ts";
import { createLogic } from "./logic.ts";
import type { AppData, AppState, Nav, Person, PersonList } from "./types.ts";

import styles from "./Chrome.module.css";

export const CHANGE_TABLES = [
  "people.profile",
  "people.important_date",
  "tally.obligation",
  "schedule.task",
  "core.party",
  "core.activity",
  "core.link",
  "core.content_item",
  "core.party_identifier",
  "social.contact_channel",
  "core.tag",
  "core.concept",
  "knowledge.note",
  "knowledge.annotation",
];

interface PeoplePayload {
  people?: Person[];
  lists?: PersonList[];
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
}
interface SearchPayload {
  people?: Person[];
}
interface TrashPayload {
  people?: Person[];
  vaultDenied?: { code?: string; message?: string };
}

// Knobs: read the initial default view from the app ROOT element (the host sets
// data-app-* there), not documentElement (#505 trap 5).
function initialView(rootEl: HTMLElement | null): "grid" | "list" {
  return rootEl?.dataset.appView === "list" ? "list" : "grid";
}

function makeState(view: "grid" | "list"): AppState {
  return {
    view,
    nav: { kind: "all" },
    chip: "all",
    sortKey: "last",
    sortDir: -1,
    search: "",
    searchResults: null,
    searchSeq: 0,
    selected: new Set<string>(),
    detailsId: null,
    detailPerson: null,
    detailAdders: {},
    newMenuOpen: false,
    addModalOpen: false,
    addDraft: null,
    creatingList: false,
    renamingListId: null,
    narrow: false,
    peopleWindow: 200,
    peopleTruncated: false,
    journalData: null,
    dashboardData: null,
    visibleRows: [],
  };
}

const TOOLBAR_TITLES: Record<Exclude<Nav["kind"], "list">, string> = {
  all: "All people",
  reconnect: "Reconnect",
  upcoming: "Upcoming",
  starred: "Favorites",
  journal: "Journal",
  activity: "Activity",
  trash: "Trash",
};
const SORT_NAMES: Record<AppState["sortKey"], string> = {
  last: "Last spoke",
  name: "Name",
  cadence: "Cadence",
};

export function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [loaded, setLoaded] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const newWrapRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<AppData>({ people: [], trash: [], lists: [] });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const consentRef = useRef<{ message: string } | null>(null);
  const readFailedShownRef = useRef(false);

  const refresh = useCallback(async () => {
    const state = stateRef.current;
    const data = dataRef.current;
    const logic = logicRef.current;
    // The reload path (issue #738): every full refresh rebuilds the pending
    // overlay from the durable outbox alongside the canonical reads, so a
    // pending row's visibility survives exactly as long as the outbox does.
    void logic?.restorePending();
    let next: PeoplePayload | undefined;
    let trash: TrashPayload | undefined;
    try {
      [next, trash] = await Promise.all([
        window.centraid.read<PeoplePayload>({
          query: "people",
          input: { limit: state.peopleWindow },
        }),
        window.centraid.read<TrashPayload>({
          query: "trash",
          input: {},
        }),
      ]);
    } catch {
      readFailed(document.querySelector<HTMLElement>("#noticeBanner"));
      readFailedShownRef.current = true;
      setLoaded(true);
      return;
    }
    if (readFailedShownRef.current) {
      readFailedShownRef.current = false;
      logic?.notice("");
    }
    const denied = next?.vaultDenied;
    consentRef.current = denied ? { message: denied.message ?? "" } : null;
    if (denied) {
      setLoaded(true);
      bump();
      return;
    }
    const incoming = next ?? data;
    data.people = incoming.people ?? [];
    data.trash = trash?.vaultDenied ? [] : (trash?.people ?? []);
    data.lists = incoming.lists ?? [];
    state.peopleTruncated = Boolean(next?.truncated);
    state.selected = new Set(
      [...state.selected].filter((id) =>
        data.people.some((p) => p.party_id === id)
      )
    );
    if (
      state.detailsId &&
      !data.people.some((p) => p.party_id === state.detailsId)
    ) {
      state.detailsId = null;
      state.detailPerson = null;
    }
    setLoaded(true);
    bump();
  }, []);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      data: dataRef.current,
      render: bump,
      refresh,
      renderRows: bump,
      renderDetails: bump,
      renderModal: bump,
      renderNewMenu: bump,
    });
  }
  const logic = logicRef.current;
  const {
    addJournalEntry: handleAddJournalEntry,
    addPerson: handleAddPerson,
    cancelCreateList: handleCancelCreateList,
    cancelRenameList: handleCancelRenameList,
    clearSelected: handleClearSelected,
    closeAddModal: handleCloseAddModal,
    closeDetails: handleCloseDetails,
    createList: handleCreateList,
    deleteList: handleDeleteList,
    favoriteSelected: handleFavoriteSelected,
    openAddModal: handleOpenAddModal,
    openDetails: handleOpenDetails,
    openPersonMenu: handleOpenPersonMenu,
    renameList: handleRenameList,
    showMorePeople: handleShowMorePeople,
    startCreateList: handleStartCreateList,
    startRenameList: handleStartRenameList,
    toggleAdder: handleToggleAdder,
    toggleAllVisible: handleToggleAllVisible,
    toggleSelect: handleToggleSelect,
    toggleStar: handleToggleStar,
    restorePerson: handleRestorePerson,
  } = logic;

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

  // Nav select is logic.selectNav (verbatim); wrap only to also close the React-
  // controlled narrow drawer (served toggles a class on #root, which is inert here).
  const handleSelectNav = useCallback(
    (nav: Nav) => {
      setSideOpen(false);
      void logic.selectNav(nav);
    },
    [logic]
  );

  const applySearch = useMemo(
    () =>
      debounce(async () => {
        const state = stateRef.current;
        const input = document.querySelector(
          "#searchInput"
        ) as HTMLInputElement | null;
        const q = (input?.value ?? "").trim();
        if (q === state.search) return;
        state.search = q;
        logic.clearSelection();
        if (!q) {
          state.searchResults = null;
          bump();
          return;
        }
        if (state.nav.kind === "journal" || state.nav.kind === "activity")
          state.nav = { kind: "all" };
        const seq = ++state.searchSeq;
        let rows: Person[] = [];
        try {
          const res = await window.centraid.read<SearchPayload>({
            query: "search",
            input: { term: q },
          });
          rows = res?.people ?? [];
        } catch {
          rows = [];
        }
        if (seq !== state.searchSeq) return;
        state.searchResults = rows;
        bump();
      }, 150),
    [logic]
  );

  const onSearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    const inp = e.currentTarget;
    const state = stateRef.current;
    if (!inp.value && !state.search) return;
    inp.value = "";
    state.searchSeq += 1;
    state.search = "";
    state.searchResults = null;
    state.selected.clear();
    bump();
  }, []);

  const onSort = useCallback(() => {
    const state = stateRef.current;
    const keys: AppState["sortKey"][] = ["last", "name", "cadence"];
    const next = keys[(keys.indexOf(state.sortKey) + 1) % keys.length]!;
    state.sortKey = next;
    state.sortDir = next === "name" || next === "cadence" ? 1 : -1;
    bump();
  }, []);

  const onSelectView = useCallback((view: "grid" | "list") => {
    stateRef.current.view = view;
    bump();
  }, []);

  const onToggleNewMenu = useCallback(() => {
    stateRef.current.newMenuOpen = !stateRef.current.newMenuOpen;
    bump();
  }, []);

  // ---- chrome wiring: doorbell, focus, keys, click-outside, width ----
  useEffect(() => {
    const stopDoorbell = onDataChange(CHANGE_TABLES, (detail) => {
      logic.applyPendingChange(detail);
      void refresh();
    });
    const stopFocus = onFocusRefresh(() => void refresh());

    const onKey = (e: globalThis.KeyboardEvent): void => {
      const target = e.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (e.key === "/" && !editing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("#searchInput")?.focus();
        return;
      }
      if (isPopoverOpen()) {
        if (e.key !== "Escape") return;
        closePopover();
        return;
      }
      const state = stateRef.current;
      if (
        e.key.toLowerCase() === "n" &&
        !editing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !state.addModalOpen &&
        !state.detailsId
      ) {
        e.preventDefault();
        handleOpenAddModal();
        return;
      }
      if (e.key !== "Escape") return;
      if (state.addModalOpen) {
        handleCloseAddModal();
        return;
      }
      if (state.detailsId) {
        handleCloseDetails();
        return;
      }
      if (state.newMenuOpen) {
        state.newMenuOpen = false;
        bump();
        return;
      }
      setSideOpen(false);
    };
    const onDocClick = (e: MouseEvent): void => {
      const state = stateRef.current;
      if (
        state.newMenuOpen &&
        newWrapRef.current &&
        e.target instanceof Node &&
        !newWrapRef.current.contains(e.target)
      ) {
        state.newMenuOpen = false;
        bump();
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onDocClick);
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          stateRef.current.narrow = isNarrow;
          setNarrow(isNarrow);
          if (!isNarrow) setSideOpen(false);
        })
      : () => {};

    void refresh();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDocClick);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  // Dismiss any open kebab/move popover on every committed re-render — the React
  // analogue of app.tsx's `render()` calling closePopover() up front. Opening the
  // popover triggers no state change (no commit), so it survives its own open.
  useEffect(() => {
    closePopover();
  });

  // ---------- Derivation (port of render()/renderToolbar()/renderRows()) ----------
  const state = stateRef.current;
  const data = dataRef.current;

  // A list can vanish under us (deleted elsewhere) — fall back to All.
  if (state.nav.kind === "list") {
    const listId = state.nav.listId;
    if (!data.lists.some((c) => c.list_id === listId))
      state.nav = { kind: "all" };
  }
  const nav = state.nav;
  const rows = logic.currentRows();
  state.visibleRows = rows;

  // The pending-write overlay's render-time index (issue #738): add/edit
  // rows key on party_id, trash/restore/log-interaction rows key on
  // profile_id (pending-projection.ts) — a row is pending if either matches.
  const pendingRows = logic.pendingByRowId();
  const isPersonPending = (person: Person): boolean =>
    pendingRows.has(person.party_id) ||
    (person.profile_id !== undefined && pendingRows.has(person.profile_id));

  const isPeople = [
    "all",
    "reconnect",
    "upcoming",
    "starred",
    "list",
    "trash",
  ].includes(nav.kind);
  let title =
    nav.kind === "list" ? listName(data, nav.listId) : TOOLBAR_TITLES[nav.kind];
  if (state.search.trim()) title = `Results for "${state.search.trim()}"`;

  const n = rows.length;
  let sub: string;
  if (nav.kind === "journal")
    sub = "A private line about your days and the people in them";
  else if (nav.kind === "activity")
    sub = "Every touch you have logged, most recent first";
  else if (state.search.trim()) sub = `${n} ${n === 1 ? "match" : "matches"}`;
  else if (nav.kind === "reconnect")
    sub = `${n} overdue · sorted by how long it has been`;
  else if (nav.kind === "upcoming")
    sub = `${n} with reminders · birthdays and dates`;
  else if (nav.kind === "starred") sub = `${n} favorite${n === 1 ? "" : "s"}`;
  else if (nav.kind === "trash")
    sub = `${n} in trash · auto-purge after 30 days`;
  else sub = `${n} ${n === 1 ? "person" : "people"}`;

  const sortLabel = `${SORT_NAMES[state.sortKey]} ${state.sortDir === 1 ? "↑" : "↓"}`;

  // ---------- Board (scroll contents — journal / activity / empty / grid / list) ----------
  let board: ReactElement;
  if (nav.kind === "journal") {
    board = (
      <Journal
        entries={state.journalData?.entries ?? []}
        onSubmit={handleAddJournalEntry}
        onOpenDetails={handleOpenDetails}
      />
    );
  } else if (nav.kind === "activity") {
    board = (
      <Activity
        recent={state.dashboardData?.recent ?? []}
        onOpenDetails={handleOpenDetails}
      />
    );
  } else if (nav.kind === "trash") {
    board =
      rows.length === 0 ? (
        <div className="kit-empty">
          <div className="kit-empty-icon">
            <Icon svg={I.del} />
          </div>
          <div className="kit-empty-title">Trash is empty</div>
          <div className="kit-empty-sub">
            Deleted people stay recoverable here for 30 days.
          </div>
          <button
            type="button"
            className="kit-btn"
            onClick={() => handleSelectNav({ kind: "all" })}
          >
            View people
          </button>
        </div>
      ) : (
        <div className={styles.grid}>
          {rows.map((person) => (
            <TrashCard
              key={person.party_id}
              person={person}
              pending={isPersonPending(person)}
              onRestore={handleRestorePerson}
            />
          ))}
        </div>
      );
  } else if (rows.length === 0) {
    const searching = !!state.search.trim();
    const emptyTitle = searching
      ? "No matches"
      : nav.kind === "starred"
        ? "No favorites yet"
        : nav.kind === "reconnect"
          ? "All caught up"
          : "No one here yet";
    const emptySub = searching
      ? "Try fewer words."
      : nav.kind === "reconnect"
        ? "Nobody is overdue right now — nice."
        : "Add someone from the New button to start keeping in touch.";
    board = (
      <div className="kit-empty">
        <div className="kit-empty-icon">
          <Icon svg={I.people} />
        </div>
        <div className="kit-empty-title">{emptyTitle}</div>
        <div className="kit-empty-sub">{emptySub}</div>
        <button
          type="button"
          className="kit-btn"
          onClick={() => {
            if (searching) {
              const input = document.querySelector(
                "#searchInput"
              ) as HTMLInputElement | null;
              if (input) input.value = "";
              state.searchSeq += 1;
              state.search = "";
              state.searchResults = null;
              bump();
            } else if (nav.kind === "reconnect") {
              handleSelectNav({ kind: "all" });
            } else {
              handleOpenAddModal();
            }
          }}
        >
          {searching
            ? "Clear search"
            : nav.kind === "reconnect"
              ? "View everyone"
              : "Add person"}
        </button>
      </div>
    );
  } else {
    const foot =
      state.peopleTruncated && !state.search.trim() ? (
        <div className={styles.windowFoot}>
          <WindowFoot
            peopleWindow={state.peopleWindow}
            onShowMore={handleShowMorePeople}
          />
        </div>
      ) : null;
    board =
      state.view === "grid" ? (
        <>
          <div className={styles.grid}>
            {rows.map((p) => (
              <GridCard
                key={p.party_id}
                p={p}
                selectedIds={state.selected}
                pending={isPersonPending(p)}
                onOpenDetails={handleOpenDetails}
                onToggleSelect={handleToggleSelect}
                onToggleStar={handleToggleStar}
              />
            ))}
          </div>
          {foot}
        </>
      ) : (
        <>
          <div className={styles.listwrap}>
            {state.narrow ? null : (
              <div className={styles.listHead}>
                <ListHead
                  rows={rows}
                  selectedIds={state.selected}
                  onToggleAll={handleToggleAllVisible}
                />
              </div>
            )}
            <div>
              {rows.map((p) => (
                <ListRow
                  key={p.party_id}
                  p={p}
                  data={data}
                  selectedIds={state.selected}
                  search={state.search}
                  pending={isPersonPending(p)}
                  onOpenDetails={handleOpenDetails}
                  onToggleSelect={handleToggleSelect}
                  onOpenMenu={handleOpenPersonMenu}
                />
              ))}
            </div>
          </div>
          {foot}
        </>
      );
  }

  // ---------- Profile drawer ----------
  let details: ReactElement | null = null;
  if (state.detailsId) {
    const dp = state.detailPerson;
    const nameGuess =
      dp?.name ??
      data.people.find((p) => p.party_id === state.detailsId)?.name ??
      "";
    const color = dp ? avatarColor(dp) : identityColor(nameGuess);
    details = (
      <Details
        key={`${state.detailsId}:${dp ? "loaded" : "loading"}`}
        person={dp}
        nameGuess={nameGuess}
        color={color}
        adders={{ ...state.detailAdders }}
        onClose={handleCloseDetails}
        onMove={(anchor) => handleOpenPersonMenu(anchor, dp!)}
        onMessage={() => logic.logInteraction(dp!, "Message", "Sent a message")}
        onCall={() => logic.logInteraction(dp!, "Call", "Gave them a call")}
        onToggleStar={() => handleToggleStar(dp!)}
        onToggleAdder={handleToggleAdder}
        onAddRelationship={(fields) =>
          logic.drawerAct(
            "add-relationship",
            { party_id: dp!.party_id, ...fields },
            "Relationship added"
          )
        }
        onAddDate={(fields) =>
          logic.drawerAct(
            "add-important-date",
            { party_id: dp!.party_id, ...fields },
            "Date added"
          )
        }
        onToggleReminder={(dateId) =>
          logic.drawerAct(
            "toggle-reminder",
            { date_id: dateId },
            "Reminder updated"
          )
        }
        onAddTask={(fields) =>
          logic.drawerAct(
            "add-task",
            { party_id: dp!.party_id, ...fields },
            "Task added"
          )
        }
        onToggleTask={(taskId) =>
          logic.drawerAct("toggle-task", { task_id: taskId }, "Task updated")
        }
        onAddNote={(fields) =>
          logic.drawerAct(
            "add-note",
            { party_id: dp!.party_id, ...fields },
            "Note added"
          )
        }
        onAddGift={(fields) =>
          logic.drawerAct(
            "add-gift",
            { party_id: dp!.party_id, ...fields },
            "Gift idea added"
          )
        }
        onToggleGift={(giftId) =>
          logic.drawerAct("toggle-gift", { gift_id: giftId }, "Gift updated")
        }
        onAddDebt={(fields) =>
          logic.drawerAct(
            "add-debt",
            { party_id: dp!.party_id, ...fields },
            "Debt added"
          )
        }
        onSettleDebt={(debtId) =>
          logic.drawerAct("settle-debt", { debt_id: debtId }, "Debt settled")
        }
        onSaveContact={(fields) => logic.saveContactChannel(dp!, fields)}
        onDeleteContact={(channelId) =>
          void logic.deleteContactChannel(dp!, channelId)
        }
        onEdit={(fields) => logic.editPerson(dp!, fields)}
        onSetCadence={(cadenceDays) => logic.setCadence(dp!, cadenceDays)}
        onTrash={() => logic.trashPerson(dp!)}
        onUndo={(revisionId) => void logic.undoPerson(dp!.party_id, revisionId)}
        mergeCandidates={data.people.filter(
          (person2) => person2.party_id !== dp?.party_id
        )}
        onMerge={(targetPartyId) => void logic.mergePerson(dp!, targetPartyId)}
      />
    );
  }

  const modal = state.addModalOpen ? (
    // Keyed on the draft so a refused person taken back for correction (issue
    // #738) genuinely reseeds this stateful leaf; without the key its own
    // `useState` initialisers would never run again.
    <AddPersonModal
      key={state.addDraft?.id ?? "add-person"}
      lists={data.lists}
      draft={state.addDraft}
      onSubmit={handleAddPerson}
      onClose={handleCloseAddModal}
    />
  ) : null;

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome gets
    // real width — otherwise it collapses to content width and the component-width
    // narrow observer wrongly flips to the phone drawer layout (#505 trap 1). The
    // People token layer (Chrome.module.css `.appRoot`) rides this same element,
    // which the host also stamps with `.centraid-inline-scope`.
    <div
      ref={setRoot}
      className={styles.appRoot}
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
        sideOpen={sideOpen}
        newMenuOpen={state.newMenuOpen}
        view={state.view}
        title={title}
        sub={sub}
        showPeopleTools={isPeople}
        sortLabel={sortLabel}
        consent={consentRef.current}
        bulkCount={state.selected.size}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onToggleNewMenu={onToggleNewMenu}
        onSelectView={onSelectView}
        onSort={onSort}
        onSearchInput={applySearch}
        onSearchKeyDown={onSearchKeyDown}
        newWrapRef={(el) => {
          newWrapRef.current = el;
        }}
        sidebarNav={
          <SmartNav
            navKind={nav.kind}
            people={data.people}
            trash={data.trash}
            onSelectNav={handleSelectNav}
          />
        }
        sidebarLists={
          <ListList
            lists={data.lists}
            people={data.people}
            navKind={nav.kind}
            navListId={nav.kind === "list" ? nav.listId : undefined}
            renamingListId={state.renamingListId}
            creatingList={state.creatingList}
            onSelectNav={handleSelectNav}
            onStartRename={handleStartRenameList}
            onDeleteList={handleDeleteList}
            onRenameCommit={handleRenameList}
            onRenameCancel={handleCancelRenameList}
            onCreateCommit={handleCreateList}
            onCreateCancel={handleCancelCreateList}
          />
        }
        sidebarJournalNav={
          <JournalNav navKind={nav.kind} onSelectNav={handleSelectNav} />
        }
        sidebarStorage={<Storage people={data.people} lists={data.lists} />}
        newMenu={
          state.newMenuOpen ? (
            <NewMenu
              onAddPerson={handleOpenAddModal}
              onNewList={handleStartCreateList}
            />
          ) : null
        }
        statusChips={
          <StatusChips
            chip={state.chip}
            onSelect={(key) => {
              state.chip = key;
              logic.clearSelection();
              bump();
            }}
          />
        }
        bulk={
          <BulkBar
            n={state.selected.size}
            onFavorite={handleFavoriteSelected}
            onClear={handleClearSelected}
          />
        }
        board={
          <>
            {/* Writes that settled without executing (issue #738). The
                replica stopped overlaying them, so the row they projected is
                no longer among the people at all — this panel above them is
                the only place they still exist, and it holds them until the
                member answers. Restored from the durable attention journal on
                every mount, so a reload never loses one. */}
            <Attention
              rows={logic.attentionRows()}
              isEditable={logic.isEditablePending}
              onEdit={(intentId) => logic.editPending(intentId)}
              onRetry={(intentId) => void logic.retryPending(intentId)}
              onDiscard={(intentId) => logic.dismissPending(intentId)}
            />
            {board}
          </>
        }
        details={details}
        modal={modal}
      />
    </div>
  );
}
