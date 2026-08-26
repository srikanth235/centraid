// People's READ side. `createLogic()` closes over the `state` and `data`
// objects `app-root.tsx` owns, mutated in place and never reassigned. THE
// WRITE SIDE IS `writes.ts`.
import { debounce, readFailed } from "@centraid/design/elements";

import { isOverdue, linkState } from "./format.ts";
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

/** Roster window size; matches the query's read max. `truncated` names a cap. */
const ROSTER_WINDOW = 9_999;

interface DeniedRead {
  vaultDenied?: { message?: string } | null;
}

interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
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

  /** Never reconciled — the chrome renders it once, so React cannot clobber it. */
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
      // A THROW IS NOT AN EMPTY SET: replica and gateway both failed to answer,
      // which the app says rather than drawing "nobody here yet".
      readFailed(banner());
      failed = true;
      setReadFailed(true);
      setLoaded(true);
      return null;
    }
  }

  async function refresh(): Promise<void> {
    const roster = await read<
      DeniedRead & {
        people?: PersonRow[];
        truncated?: boolean;
        links_available?: boolean;
      }
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
    // THE SHARING PLANE'S OWN FLAG, never inferred from the rows: "nobody is
    // linked" and "link facts are missing" draw differently everywhere.
    data.linksAvailable = Boolean(roster.links_available);

    if (state.shelf === TOUCH) {
      const dashboard = await read<DeniedRead & Partial<DashboardData>>(
        "dashboard"
      );
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
              // Null, not zero: an unanswered dashboard has not said nobody is linked.
              linked: null,
              to_link: null,
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
      // Trashed or merged away elsewhere — never strand the member on nobody.
      if (!data.person) {
        state.personId = null;
        state.shelf = null;
      }
    } else {
      data.person = null;
    }
    render();
  }

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

  /** Composer, draft and confirm must not outlive the screen they belong to. */
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

  /** Counted over the SAME window as the rows in hand, so the status line and
   *  chips cannot disagree. Zero while link facts are absent — gate on
   *  `data.linksAvailable`. */
  function rosterCounts(): {
    people: number;
    due: number;
    starred: number;
    linked: number;
    toLink: number;
  } {
    const now = Date.now();
    return {
      people: data.people.length,
      due: data.people.filter((person) => isOverdue(person, now)).length,
      starred: data.people.filter((person) => person.starred).length,
      linked: data.people.filter((person) => linkState(person) === "linked")
        .length,
      toLink: data.people.filter((person) => linkState(person) === "unlinked")
        .length,
    };
  }

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

  /** Shown while nothing has just happened; a write's outcome replaces it. */
  function ambientStatus(): string | null {
    const counts = rosterCounts();
    const links = data.linksAvailable;
    if (state.shelf === TOUCH)
      return links
        ? STATUS.touchLinked(counts.linked, counts.toLink, counts.due)
        : STATUS.touch(counts.people, counts.due);
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
    return links
      ? STATUS.rosterLinked(
          counts.linked,
          counts.people,
          counts.toLink,
          counts.due,
          counts.starred,
          data.truncated
        )
      : STATUS.roster(
          counts.people,
          counts.due,
          counts.starred,
          data.truncated
        );
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
