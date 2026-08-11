// governance: allow-repo-hygiene file-size-limit (#630) — this factory is the
// cohesive controller for one blueprint; splitting its shared mutable app
// closure would obscure write/outcome and undo sequencing.
import { createPendingOverlayModel } from "../_shared/pending-overlay.ts";
import {
  PALETTE,
  listColor,
  daysSince,
  daysUntilAnnual,
  statusOf,
} from "./format.ts";
// Non-visual business logic: vault IO (write/act), row derivation, selection,
// the kebab/move-to-list popover (stays plain DOM, built with kit's
// `h()`/`popItem()` — no React root needed there), every person/list write,
// the profile drawer's load/reload + "+ add" write helper, journal/activity
// reads, navigation state transitions, and the pending-write overlay (issue
// #738). `createLogic()` is a factory app.tsx calls once at boot, closing
// over the exact `state`/`data` objects app.tsx owns (passed by reference:
// app.tsx mutates their properties in place, never reassigns the bindings, so
// this module always sees the live values) plus the render entry points only
// app.tsx can define. Everything returned here is then wired into app.tsx's
// render functions and JSX props, exactly like any other value flowing down.
// Same factory pattern as tasks/logic.ts and notes/logic.ts.
import {
  closePopover,
  h,
  openPopover,
  outcomeMessage,
  popItem,
  runBulk as runBulkBase,
  statusLine,
} from "./kit.ts";
import { peoplePendingProjection } from "./pending-projection.ts";
import type {
  DashboardData,
  DetailPerson,
  JournalData,
  LogicDeps,
  Nav,
  Person,
  PersonList,
} from "./types.ts";

const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

export function createLogic({
  state,
  data,
  render,
  refresh,
  renderRows,
  renderDetails,
  renderModal,
  renderNewMenu,
}: LogicDeps) {
  // The shared pending-write overlay (issue #738): one model, created once,
  // that every write wraps through `act()` below. No app state carries
  // pending rows — `model.byRowId()` is the render-time source for the
  // list/grid pending-chip decoration app-root.tsx applies.
  const model = createPendingOverlayModel(peoplePendingProjection);

  function notice(text: string) {
    const b = $("noticeBanner");
    b.textContent = text || "";
    b.hidden = !text;
  }

  // Returns true when the write executed; otherwise narrates the outcome and
  // returns false.
  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    notice(outcomeMessage(outcome) ?? "");
    return false;
  }

  /** Row id → pending state (party ids for add-person/edit-person,
   *  profile ids for trash/restore/log-interaction — see pending-projection.ts). */
  function pendingByRowId() {
    return model.byRowId();
  }

  /** The reload path (issue #738): rebuild overlay-status rows from the
   *  durable outbox alone. Feature-detected — the visual-harness mock and
   *  older hosts lack `pendingWrites()`. */
  async function restorePending(): Promise<void> {
    const durable = (await window.centraid.pendingWrites?.()) ?? [];
    model.restore(durable);
    render();
  }

  /** Fold one change-feed event into the pending model; true when it moved. */
  function applyPendingChange(detail: CentraidChangeDetail): boolean {
    return model.applyChangeDetail(detail);
  }

  // Every write goes through here, so the pending overlay tracks every write
  // uniformly: mint the intent id, project the app's declared optimistic
  // mutations, and fold the outcome (or the transport failure) into the
  // model. An action absent from pending-projection.ts projects nothing —
  // `begin()` is then a no-op and this is exactly the old fire-and-forget act().
  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const intentId = globalThis.crypto.randomUUID();
    const optimistic = model.begin(action, input, intentId);
    try {
      const outcome = await window.centraid.write({
        action,
        input,
        intentId,
        ...(optimistic.length > 0 ? { optimistic } : {}),
      });
      model.applyOutcome(outcome.invocationId ?? intentId, {
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.conflict === undefined
          ? {}
          : { conflict: outcome.conflict }),
      });
      return outcome;
    } catch (error) {
      // Nothing reached the outbox — settle to `failed` instead of hanging as
      // `queued` forever.
      model.applyOutcome(intentId, { status: "failed" });
      notice(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  // ---------- Row derivation (client-side, like the prototype's in-memory list) ----------

  function currentRows(): Person[] {
    const { nav, chip, search } = state;
    let base: Person[];
    if (search.trim()) {
      base = state.searchResults ?? [];
    } else {
      base = nav.kind === "trash" ? data.trash.slice() : data.people.slice();
      if (nav.kind === "reconnect")
        base = base.filter((p) => daysSince(p) >= (p.cadence_days ?? 30));
      else if (nav.kind === "upcoming")
        base = base.filter((p) => (p.reminders || []).length > 0);
      else if (nav.kind === "starred") base = base.filter((p) => p.starred);
      else if (nav.kind === "list")
        base = base.filter((p) => (p.list_id ?? null) === nav.listId);
    }
    if (chip !== "all") base = base.filter((p) => statusOf(p).key === chip);

    if (search.trim()) return base; // keep vault rank order
    if (nav.kind === "reconnect") {
      return base
        .slice()
        .sort(
          (a, b) =>
            daysSince(b) -
            (b.cadence_days ?? 30) -
            (daysSince(a) - (a.cadence_days ?? 30))
        );
    }
    if (nav.kind === "upcoming") {
      const near = (p: Person) =>
        Math.min(
          ...(p.reminders || []).map((d) => daysUntilAnnual(d.month_day)),
          999
        );
      return base.slice().sort((a, b) => near(a) - near(b));
    }
    const dir = state.sortDir;
    return base.slice().sort((a, b) => {
      let r: number;
      if (state.sortKey === "name")
        r = String(a.name).localeCompare(String(b.name));
      else if (state.sortKey === "cadence")
        r = (a.cadence_days ?? 0) - (b.cadence_days ?? 0);
      else r = daysSince(a) - daysSince(b);
      return r * dir;
    });
  }

  // ---------- Selection ----------

  function clearSelection() {
    state.selected.clear();
  }
  function toggleSelect(id: string) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
  }
  function toggleAllVisible(rows: Person[], allSelected: boolean) {
    if (allSelected) for (const p of rows) state.selected.delete(p.party_id);
    else for (const p of rows) state.selected.add(p.party_id);
    render();
  }
  function clearSelected() {
    clearSelection();
    render();
  }

  // ---------- Popover (kebab + move-to-list) ----------
  // Reused for both the row kebab menu and the drawer's "Move to list"
  // button (same target list), exactly as the old version did.

  function openPersonMenu(anchor: HTMLElement, p: Person) {
    openPopover(anchor, (box) => {
      box.append(
        popItem("Open profile", () => {
          closePopover();
          void openDetails(p.party_id);
        }),
        popItem(p.starred ? "Remove favorite" : "Add to favorites", () => {
          closePopover();
          void toggleStar(p);
        }),
        h("div", { class: "kit-popover-sep" }),
        h("p", { class: "kit-popover-head" }, "Move to list"),
        popItem(
          "No list",
          () => {
            closePopover();
            void movePerson(p, null, "no list");
          },
          { disabled: p.list_id == null, dotColor: "var(--text-faint)" }
        ),
        ...data.lists.map((c) =>
          popItem(
            c.name,
            () => {
              closePopover();
              void movePerson(p, c.list_id, c.name);
            },
            {
              disabled: p.list_id === c.list_id,
              dotColor: listColor(c.list_id),
            }
          )
        )
      );
    });
  }

  // ---------- Person writes ----------

  // refresh() re-renders the open drawer, but from the stale `detailPerson`
  // snapshot — so any write that can land while the drawer is open on the
  // same person must also reload the detail read, or the drawer keeps
  // showing the pre-write state (star glyph, list, history) until it's
  // closed and reopened.
  async function reloadOpenDetail(partyId: string) {
    if (state.detailsId === partyId) await loadDetail(partyId);
  }

  async function toggleStar(p: Person | DetailPerson) {
    const outcome = await act(p.starred ? "unstar-person" : "star-person", {
      party_id: p.party_id,
    });
    if (!narrate(outcome)) return;
    statusLine(
      p.starred ? "Favorite removed · receipted." : "Favorited · receipted."
    );
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  async function movePerson(
    p: Person | DetailPerson,
    listId: string | null,
    name: string
  ) {
    const input = {
      party_id: p.party_id,
      ...(listId == null ? {} : { list_id: listId }),
    };
    const outcome = await act("move-person", input);
    if (!narrate(outcome)) return;
    statusLine(`Moved to ${name} · receipted.`);
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  async function undoPerson(
    partyId: string,
    revisionId: string
  ): Promise<void> {
    const outcome = await act("undo-person", {
      party_id: partyId,
      revision_id: revisionId,
    });
    if (!narrate(outcome)) return;
    statusLine("Change undone · receipt");
    await refresh();
    await reloadOpenDetail(partyId);
  }

  async function editPerson(
    p: DetailPerson,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    const outcome = await act("edit-person", {
      party_id: p.party_id,
      ...(p.profile_id ? { profile_id: p.profile_id } : {}),
      ...fields,
    });
    if (!narrate(outcome)) return false;
    const revisionId = String(outcome?.output?.revision_id ?? "");
    statusLine("Profile updated · receipt", {
      duration: revisionId ? 10_000 : undefined,
      undoLabel: revisionId ? "Undo" : undefined,
      onUndo: revisionId
        ? () => void undoPerson(p.party_id, revisionId)
        : undefined,
    });
    await refresh();
    await reloadOpenDetail(p.party_id);
    return true;
  }

  async function setCadence(
    p: DetailPerson,
    cadenceDays: number
  ): Promise<boolean> {
    const outcome = await act("set-cadence", {
      party_id: p.party_id,
      cadence_days: cadenceDays,
    });
    if (!narrate(outcome)) return false;
    const revisionId = String(outcome?.output?.revision_id ?? "");
    statusLine("Cadence updated · receipt", {
      duration: revisionId ? 10_000 : undefined,
      undoLabel: revisionId ? "Undo" : undefined,
      onUndo: revisionId
        ? () => void undoPerson(p.party_id, revisionId)
        : undefined,
    });
    await refresh();
    await reloadOpenDetail(p.party_id);
    return true;
  }

  async function trashPerson(p: DetailPerson): Promise<void> {
    const outcome = await act("trash-person", {
      party_id: p.party_id,
      ...(p.profile_id ? { profile_id: p.profile_id } : {}),
    });
    if (!narrate(outcome)) return;
    const revisionId = String(outcome?.output?.revision_id ?? "");
    closeDetails();
    statusLine(`${p.name} moved to trash`, {
      duration: revisionId ? 10_000 : undefined,
      undoLabel: revisionId ? "Undo" : undefined,
      onUndo: revisionId
        ? () => void undoPerson(p.party_id, revisionId)
        : undefined,
    });
    await refresh();
  }

  async function restorePerson(p: Person): Promise<void> {
    const outcome = await act("restore-person", {
      party_id: p.party_id,
      ...(p.profile_id ? { profile_id: p.profile_id } : {}),
    });
    if (!narrate(outcome)) return;
    statusLine(`${p.name} restored · receipt`);
    await refresh();
  }

  async function logInteraction(p: DetailPerson, kind: string, text: string) {
    const outcome = await act("log-interaction", {
      party_id: p.party_id,
      kind,
      text,
      ...(p.profile_id ? { profile_id: p.profile_id } : {}),
    });
    if (!narrate(outcome)) return;
    statusLine(`Logged · receipted.`);
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  // Bulk actions run through the kit's runBulk with the app's own voice.
  const bulkOpts = {
    notice,
    friendly: (outcome: VaultOutcome | undefined) =>
      outcome?.reason ?? outcome?.predicate ?? null,
    after: async () => {
      clearSelection();
      await refresh();
    },
  };
  function favoriteSelected() {
    return runBulkBase(
      [...state.selected],
      (id) => act("star-person", { party_id: id }),
      {
        progress: "Favoriting",
        done: "Favorited",
        ...bulkOpts,
      }
    );
  }

  // ---------- List writes ----------

  async function createList(name: string) {
    const outcome = await act("create-list", { name });
    if (narrate(outcome)) {
      state.creatingList = false;
      statusLine(`List "${name}" created · receipted.`);
      await refresh();
    } else {
      render();
    }
  }
  async function renameList(listId: string, name: string) {
    const outcome = await act("rename-list", { list_id: listId, name });
    if (narrate(outcome)) {
      state.renamingListId = null;
      statusLine("List renamed · receipted.");
      await refresh();
    } else {
      render();
    }
  }
  async function deleteList(list: PersonList) {
    const outcome = await act("delete-list", { list_id: list.list_id });
    if (narrate(outcome)) {
      if (state.nav.kind === "list" && state.nav.listId === list.list_id)
        state.nav = { kind: "all" };
      statusLine("List deleted · receipted.");
      await refresh();
    }
  }
  function startRenameList(listId: string) {
    state.renamingListId = listId;
    render();
  }
  function cancelCreateList() {
    state.creatingList = false;
    render();
  }
  function cancelRenameList() {
    state.renamingListId = null;
    render();
  }

  // ---------- Profile drawer ----------

  async function openDetails(id: string) {
    state.detailsId = id;
    state.detailPerson = null;
    state.detailAdders = {};
    renderDetails(); // paints a shell immediately
    await loadDetail(id);
  }
  function closeDetails() {
    state.detailsId = null;
    state.detailPerson = null;
    renderDetails();
  }
  async function loadDetail(id: string) {
    try {
      const res = await window.centraid.read<{
        person?: DetailPerson;
        vaultDenied?: unknown;
      }>({
        query: "person",
        input: { party_id: id },
      });
      if (res?.vaultDenied) return;
      if (state.detailsId !== id) return;
      state.detailPerson = res?.person ?? null;
      renderDetails();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    }
  }
  function toggleAdder(key: string) {
    state.detailAdders[key] = !state.detailAdders[key];
    renderDetails();
  }

  // Returns true when the write executed (the AddRows components clear their
  // own fields only then — a failed/parked write leaves the typed draft in
  // place instead of silently discarding it).
  async function drawerAct(
    action: string,
    input: Record<string, unknown>,
    message: string
  ): Promise<boolean> {
    const outcome = await act(action, input);
    if (!narrate(outcome)) return false;
    statusLine(`${message} · receipted.`);
    await refresh();
    if (state.detailsId) await loadDetail(state.detailsId);
    return true;
  }

  async function saveContactChannel(
    person: DetailPerson,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    const outcome = await act("save-contact-channel", {
      party_id: person.party_id,
      ...fields,
    });
    if (!narrate(outcome)) return false;
    const channelId = String(outcome?.output?.channel_id ?? "");
    const revisionId = String(outcome?.output?.revision_id ?? "");
    const duplicates = Array.isArray(outcome?.output?.duplicate_party_ids)
      ? outcome.output.duplicate_party_ids.length
      : 0;
    statusLine(
      duplicates > 0
        ? `Contact saved · ${duplicates} possible duplicate${duplicates === 1 ? "" : "s"}`
        : "Contact saved · receipt",
      {
        duration: revisionId ? 10_000 : undefined,
        undoLabel: revisionId ? "Undo" : undefined,
        onUndo:
          revisionId && channelId
            ? () =>
                void undoContactChannel(person.party_id, channelId, revisionId)
            : undefined,
      }
    );
    await loadDetail(person.party_id);
    return true;
  }

  async function deleteContactChannel(
    person: DetailPerson,
    channelId: string
  ): Promise<void> {
    const outcome = await act("delete-contact-channel", {
      channel_id: channelId,
    });
    if (!narrate(outcome)) return;
    const revisionId = String(outcome?.output?.revision_id ?? "");
    statusLine("Contact deleted · receipt", {
      duration: revisionId ? 10_000 : undefined,
      undoLabel: revisionId ? "Undo" : undefined,
      onUndo: revisionId
        ? () => void undoContactChannel(person.party_id, channelId, revisionId)
        : undefined,
    });
    await loadDetail(person.party_id);
  }

  async function undoContactChannel(
    partyId: string,
    channelId: string,
    revisionId: string
  ): Promise<void> {
    const outcome = await act("undo-contact-channel", {
      channel_id: channelId,
      revision_id: revisionId,
    });
    if (!narrate(outcome)) return;
    statusLine("Contact restored · receipt");
    await loadDetail(partyId);
  }

  async function mergePerson(
    source: DetailPerson,
    targetPartyId: string
  ): Promise<void> {
    const outcome = await act("merge-people", {
      source_party_id: source.party_id,
      target_party_id: targetPartyId,
    });
    if (!narrate(outcome)) return;
    closeDetails();
    await refresh();
    // core.merge_party is irreversible by design (#290 / #306 Tier 4).
    statusLine(`${source.name} merged · receipt`);
  }

  // ---------- Add-person modal ----------

  async function addPerson({
    name,
    role,
    listId,
    cadence,
  }: {
    name: string;
    role: string;
    listId: string | null;
    cadence: number;
  }): Promise<boolean> {
    const avatar_color = PALETTE[data.people.length % PALETTE.length];
    const input = {
      display_name: name,
      cadence_days: cadence,
      avatar_color,
      ...(role ? { role } : {}),
      ...(listId == null ? {} : { list_id: listId }),
    };
    const outcome = await act("add-person", input);
    if (!narrate(outcome)) return false;
    state.addModalOpen = false;
    renderModal();
    statusLine("Added · receipted.");
    await refresh();
    const newId = outcome?.output?.party_id;
    if (typeof newId === "string") await openDetails(newId);
    return true;
  }
  function openAddModal() {
    state.newMenuOpen = false;
    renderNewMenu();
    state.addModalOpen = true;
    renderModal();
  }
  function closeAddModal() {
    state.addModalOpen = false;
    renderModal();
  }
  function startCreateList() {
    state.newMenuOpen = false;
    renderNewMenu();
    state.creatingList = true;
    render();
  }

  // ---------- Journal / Activity ----------

  async function loadJournal() {
    try {
      const res = await window.centraid.read<
        JournalData & { vaultDenied?: unknown }
      >({
        query: "journal",
        input: {},
      });
      state.journalData = res?.vaultDenied
        ? { entries: [] }
        : (res ?? { entries: [] });
    } catch {
      state.journalData = { entries: [] };
    }
  }
  async function loadDashboard() {
    try {
      const res = await window.centraid.read<
        DashboardData & { vaultDenied?: unknown }
      >({
        query: "dashboard",
        input: {},
      });
      state.dashboardData = res?.vaultDenied
        ? { recent: [] }
        : (res ?? { recent: [] });
    } catch {
      state.dashboardData = { recent: [] };
    }
  }
  async function addJournalEntry(mood: string, text: string): Promise<boolean> {
    const outcome = await act("add-journal-entry", { mood, text });
    if (!narrate(outcome)) return false;
    statusLine("Entry added · receipted.");
    await loadJournal();
    renderRows();
    return true;
  }

  // ---------- Navigation ----------

  async function selectNav(nav: Nav) {
    state.nav = nav;
    clearSelection();
    state.detailsId = null;
    state.detailPerson = null;
    state.search = "";
    state.searchResults = null;
    ($("searchInput") as HTMLInputElement).value = "";
    state.chip = "all";
    state.newMenuOpen = false;
    state.creatingList = false;
    state.renamingListId = null;
    if (state.narrow) $("root").classList.remove("side-open");
    renderDetails();
    if (nav.kind === "journal") await loadJournal();
    if (nav.kind === "activity") await loadDashboard();
    render();
  }

  async function showMorePeople() {
    state.peopleWindow += 200;
    await refresh();
  }

  return {
    notice,
    narrate,
    act,
    pendingByRowId,
    restorePending,
    applyPendingChange,
    currentRows,
    clearSelection,
    toggleSelect,
    toggleAllVisible,
    clearSelected,
    openPersonMenu,
    toggleStar,
    movePerson,
    undoPerson,
    editPerson,
    setCadence,
    trashPerson,
    restorePerson,
    logInteraction,
    favoriteSelected,
    createList,
    renameList,
    deleteList,
    startRenameList,
    cancelCreateList,
    cancelRenameList,
    openDetails,
    closeDetails,
    loadDetail,
    toggleAdder,
    drawerAct,
    saveContactChannel,
    deleteContactChannel,
    mergePerson,
    addPerson,
    openAddModal,
    closeAddModal,
    startCreateList,
    loadJournal,
    loadDashboard,
    addJournalEntry,
    selectNav,
    showMorePeople,
  };
}
