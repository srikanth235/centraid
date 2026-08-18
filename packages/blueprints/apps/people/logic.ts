// People's store and its READ side: what is in hand, what each screen is
// showing, and where the member is.
//
// Not a component — no JSX, no props — and never a second copy of mutable
// state. `createLogic()` is a factory `app-root.tsx` calls once at boot,
// closing over the exact `state` and `data` objects it owns (passed by
// reference and mutated in place, never reassigned, so this module always sees
// the live values) plus the one orchestration entry point only `app-root.tsx`
// can define: `render`. It is the shape `docs/logic.ts` uses, for the same
// reason — the app's rules are readable and testable outside a render.
//
// THE WRITE SIDE IS `writes.ts`. Two files rather than one because they answer
// two different questions ("what is true" and "what did this write do"), and
// because one file carrying both is how this app's predecessor reached the
// size where nobody read it.
import { debounce, readFailed } from "@centraid/design/elements";

import { isOverdue } from "./format.ts";
import { STATUS } from "./people-copy.ts";
import { EDIT, LOG, MERGE, PERSON, SEARCH, TOUCH, TRASH } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type {
  AppData,
  AppState,
  DashboardData,
  PersonDetail,
  PersonRow,
  TrashedPerson,
} from "./types.ts";

/** How many people the roster window asks for. The query caps and reports
 *  `truncated`, which the app bar's count reads rather than hiding. */
const ROSTER_WINDOW = 200;

interface DeniedRead {
  vaultDenied?: { message?: string } | null;
}

interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  /** A read has landed (either way) — the gate every empty state is behind. */
  setLoaded: (loaded: boolean) => void;
  setConsent: (consent: { message: string } | null) => void;
  setReadFailed: (failed: boolean) => void;
}

export function createLogic({
  state,
  data,
  render,
  setLoaded,
  setConsent,
  setReadFailed,
}: LogicDeps) {
  const banner = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("#noticeBanner");

  /** The app's one imperative banner. Rendered once by the chrome and never
   *  reconciled, so these writes are never clobbered by React. */
  function notice(text?: string): void {
    const element = banner();
    if (!element) return;
    element.textContent = text ?? "";
    element.hidden = !text;
  }

  let failed = false;

  async function read<T>(
    query: string,
    input?: Record<string, unknown>
  ): Promise<T | null> {
    try {
      return await window.centraid.read<T>({
        query,
        ...(input ? { input } : {}),
      });
    } catch {
      // A THROW IS NOT AN EMPTY SET. The inline client tries the local replica
      // and falls back to the gateway, so a failure means neither answered —
      // which the app says, rather than drawing "nobody here yet".
      readFailed(banner());
      failed = true;
      setReadFailed(true);
      setLoaded(true);
      return null;
    }
  }

  /** Every read this app performs, in one place, so a screen can never open a
   *  sixth. The secondary reads are conditional: a member on the roster has no
   *  use for the dashboard, and asking for it anyway is a read nobody sees. */
  async function refresh(): Promise<void> {
    const roster = await read<
      DeniedRead & { people?: PersonRow[]; truncated?: boolean }
    >("people", { limit: ROSTER_WINDOW });
    if (!roster) return;
    if (failed) {
      failed = false;
      notice("");
    }
    setReadFailed(false);
    const denied = roster.vaultDenied;
    setConsent(denied ? { message: denied.message ?? "" } : null);
    setLoaded(true);
    if (denied) {
      render();
      return;
    }
    data.people = roster.people ?? [];
    data.truncated = Boolean(roster.truncated);

    if (state.shelf === TOUCH) {
      const dashboard = await read<DeniedRead & Partial<DashboardData>>(
        "dashboard"
      );
      // The Reconnect rows say `every <n> days · <ago>`; the query returns
      // identity and role only, so the cadence pair is joined back in from
      // the roster read that landed just above.
      const byId = new Map(
        data.people.map((person) => [person.party_id, person])
      );
      data.dashboard = dashboard
        ? {
            reconnect: (dashboard.reconnect ?? []).map((card) => {
              const row = byId.get(card.party_id);
              return row
                ? {
                    ...card,
                    cadence_days: row.cadence_days,
                    last_contacted_at: row.last_contacted_at,
                    created_at: row.created_at,
                  }
                : card;
            }),
            upcoming: dashboard.upcoming ?? [],
            recent: dashboard.recent ?? [],
            counts: dashboard.counts ?? {
              all: 0,
              reconnect: 0,
              upcoming: 0,
              starred: 0,
            },
          }
        : null;
    }
    if (state.shelf === TRASH) {
      const trash = await read<DeniedRead & { people?: TrashedPerson[] }>(
        "trash"
      );
      data.trash = trash?.people ?? [];
    }
    if (state.personId) {
      const detail = await read<DeniedRead & { person?: PersonDetail }>(
        "person",
        { party_id: state.personId }
      );
      data.person = detail?.person ?? null;
      // The person may have been trashed or merged away in another window. The
      // member is not left on a screen about nobody: they go back to the
      // roster, which is where they reached the person from.
      if (!data.person) {
        state.personId = null;
        state.shelf = null;
      }
    } else {
      data.person = null;
    }
    render();
  }

  /** The search shelf's own read, debounced, sequence-guarded, and honest
   *  about the difference between "no matches" and "could not ask". */
  const applySearch = debounce(async (): Promise<void> => {
    const term = state.search.trim();
    if (!term) {
      state.searchResults = null;
      state.searchStatus = "resting";
      render();
      return;
    }
    const seq = ++state.searchSeq;
    state.searchStatus = "searching";
    render();
    let rows: PersonRow[] = [];
    let reached = true;
    try {
      const result = await window.centraid.read<{ people?: PersonRow[] }>({
        query: "search",
        input: { term },
      });
      rows = result?.people ?? [];
    } catch {
      reached = false;
    }
    if (seq !== state.searchSeq) return;
    state.searchResults = reached ? rows : null;
    state.searchStatus = reached ? "ready" : "unreachable";
    render();
  }, 150);

  function setSearch(term: string): void {
    state.search = term;
    render();
    void applySearch();
  }

  function clearSearch(): void {
    state.search = "";
    state.searchResults = null;
    state.searchStatus = "resting";
    render();
  }

  // ---------- Navigation ----------

  /** Every move goes through here, so the composer, the draft and the confirm
   *  cannot outlive the screen they belong to — a half-typed note reappearing
   *  three screens later is state leaking, not state preserved. */
  function go(shelf: ShelfId, personId?: string | null): void {
    state.shelf = shelf;
    if (personId !== undefined) state.personId = personId;
    state.composer = null;
    state.confirm = null;
    render();
    void refresh();
  }

  function openPerson(partyId: string): void {
    go(PERSON, partyId);
  }

  function goBack(): void {
    // Nested screens return to the person they are about; the person screen
    // and Trash return to the roster (handoff § Navigation).
    if (state.shelf === PERSON || state.shelf === TRASH) {
      go(null, null);
      return;
    }
    if (state.personId) {
      go(PERSON, state.personId);
      return;
    }
    go(null, null);
  }

  function toggleSection(key: string): void {
    state.collapsed = {
      ...state.collapsed,
      [key]: !state.collapsed[key],
    };
    render();
  }

  // ---------- Derivations ----------

  /** The three numbers the roster's status line and app bar are made of. */
  function rosterCounts(): { people: number; due: number; starred: number } {
    const now = Date.now();
    return {
      people: data.people.length,
      due: data.people.filter((person) => isOverdue(person, now)).length,
      starred: data.people.filter((person) => person.starred).length,
    };
  }

  /** The merge screen's candidates: everyone except the person on screen,
   *  with the contract's own duplicates first — the `person` query marks a
   *  channel shared with another party (`duplicate_party_ids`), and a person
   *  the vault already suspects belongs at the top of the pick list. */
  function mergeCandidates(): PersonRow[] {
    const duplicates = new Set(
      (data.person?.contact ?? []).flatMap(
        (channel) => channel.duplicate_party_ids ?? []
      )
    );
    return data.people
      .filter((person) => person.party_id !== state.personId)
      .sort(
        (a, b) =>
          Number(duplicates.has(b.party_id)) -
          Number(duplicates.has(a.party_id))
      );
  }

  function personRow(partyId: string | null): PersonRow | null {
    if (!partyId) return null;
    return data.people.find((person) => person.party_id === partyId) ?? null;
  }

  /**
   * The AMBIENT sentence for the current screen — what the status line says
   * while nothing has just happened. A write's own outcome replaces it in
   * place (`writes.ts`), which is the frame's one status line doing its one
   * job.
   */
  function ambientStatus(): string | null {
    const counts = rosterCounts();
    if (state.shelf === TOUCH) return STATUS.touch(counts.people, counts.due);
    if (state.shelf === SEARCH) {
      if (state.searchStatus === "unreachable") return STATUS.searchUnreachable;
      if (!state.search.trim()) return STATUS.searchResting;
      return STATUS.searchResults(
        state.searchResults?.length ?? 0,
        counts.people
      );
    }
    if (state.shelf === TRASH) return STATUS.trash(data.trash.length);
    if (state.shelf === LOG) return STATUS.logging;
    if (state.shelf === EDIT) return STATUS.editing;
    if (state.shelf === MERGE) return null;
    if (state.shelf === PERSON) return null;
    return STATUS.roster(counts.people, counts.due, counts.starred);
  }

  return {
    notice,
    refresh,
    setSearch,
    clearSearch,
    go,
    goBack,
    openPerson,
    toggleSection,
    rosterCounts,
    mergeCandidates,
    personRow,
    ambientStatus,
  };
}
