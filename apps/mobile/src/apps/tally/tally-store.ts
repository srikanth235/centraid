// THE READ PLANE, ON THIS SEAT.
//
// One module-level store, subscribed to with `useSyncExternalStore` — the same
// shape the frame's status line uses (`kit/components/status-line.ts`), and the
// same shape Locker's boundary uses — because what it holds is process memory
// shared by every Tally route. A React context would let a remount somewhere in
// the stack hand a fresh subtree a payload the previous route had already
// navigated away from.
//
// THE DASHBOARD IS THE SPINE and every route reads it; a route that needs a
// second payload asks for exactly that one and no other. That law is
// `apps/tally/ledger-reads.ts`'s, restated here rather than imported because
// the web seat's version is a React hook bound to `window.centraid`, and this
// seat's door is `tally-gateway.ts`.
//
// NOTHING HERE FOLDS A FIGURE. Every net, share and total arrives derived from
// `queries/dashboard.ts`'s one balance engine; this module moves payloads and
// records when they landed.

// `ACTIVITY_WINDOW` / `ACTIVITY_STEP` are imported rather than restated: the
// feed's window and its step are the shared fold's numbers, and two spellings
// of 60 is exactly the drift `activity-model.ts` exists to prevent.
import {
  ACTIVITY_STEP,
  ACTIVITY_WINDOW,
} from "@centraid/blueprints/apps/tally/activity-model";
import type {
  ActivityData,
  DashboardData,
  ExportData,
  FriendData,
  GroupData,
  HistoryData,
  SearchData,
  VaultDenied,
} from "@centraid/blueprints/apps/tally/types";

import {
  tallyActivity,
  tallyDashboard,
  tallyExport,
  tallyFriend,
  tallyGroup,
  tallyHistory,
  tallySearch,
} from "./tally-gateway";

/** How long a landed read may stand before the screen says it is behind the
 *  vault. Ten minutes: long enough that a member reading one expense is not
 *  told their ledger is stale, short enough that one left open overnight is. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** How often the store re-examines its own freshness. The stale verdict is
 *  decided on this tick rather than by a screen reading the clock during
 *  render, which is a purity violation and an unstable result besides. */
const TICK_MS = 30_000;

const EMPTY_DASHBOARD: DashboardData = {
  me: null,
  currency: "USD",
  friends: [],
  groups: [],
  trash: [],
  recurring: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};

export interface TallySearchState {
  term: string;
  data: SearchData | null;
  searching: boolean;
}

export interface TallyVaultState {
  dashboard: DashboardData;
  /** The route's own payload, beside the spine. `null` for a route that asked
   *  for none — never an empty object, which would read as "it answered". */
  group: GroupData | null;
  friend: FriendData | null;
  activity: ActivityData | null;
  history: HistoryData | null;
  search: TallySearchState;
  exported: ExportData | null;
  /** A read has LANDED. False covers both "still in flight" and "every read so
   *  far failed": in neither case may a view claim a set is empty. */
  loaded: boolean;
  reading: boolean;
  /** A read that actually came back failed — evidence, not a guess. */
  readError: string;
  /** The vault's refusal, as data. Denial is a screen, not an error. */
  denied: VaultDenied | null;
  /** When the last read that ACTUALLY LANDED did — the stale sentence's clock. */
  lastReadAt: string | null;
  stale: boolean;
  /** The clock the whole room reads, so a day heading and the rows under it
   *  cannot straddle midnight and disagree about what "today" is. */
  now: string;
  /** How much of the feed is on screen. `activity-model.ts` owns the numbers. */
  window: number;
}

function initialState(): TallyVaultState {
  return {
    dashboard: EMPTY_DASHBOARD,
    group: null,
    friend: null,
    activity: null,
    history: null,
    search: { term: "", data: null, searching: false },
    exported: null,
    loaded: false,
    reading: false,
    readError: "",
    denied: null,
    lastReadAt: null,
    stale: false,
    now: new Date().toISOString(),
    window: ACTIVITY_WINDOW,
  };
}

let state: TallyVaultState = initialState();
const subscribers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  // Snapshot: a subscriber that unsubscribes as it reacts must not mutate
  // the set mid-iteration.
  for (const notify of Array.from(subscribers)) notify();
}

function set(patch: Partial<TallyVaultState>): void {
  state = { ...state, ...patch };
  emit();
}

export function readTallyVault(): TallyVaultState {
  return state;
}

export function subscribeTallyVault(notify: () => void): () => void {
  subscribers.add(notify);
  startTicker();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) stopTicker();
  };
}

function startTicker(): void {
  if (ticker !== null) return;
  ticker = setInterval(() => {
    const now = new Date().toISOString();
    const matchedAt = state.lastReadAt;
    const stale =
      matchedAt !== null && Date.now() - Date.parse(matchedAt) > STALE_AFTER_MS;
    if (stale === state.stale && now.slice(0, 10) === state.now.slice(0, 10))
      return;
    set({ now, stale });
  }, TICK_MS);
}

function stopTicker(): void {
  if (ticker === null) return;
  clearInterval(ticker);
  ticker = null;
}

/** Reset for a fresh process — the tests' door, and nothing production calls. */
export function resetTallyVault(): void {
  stopTicker();
  state = initialState();
  emit();
}

// ─── The reads ──────────────────────────────────────────────────────────────

/** A denial carried on ANY payload is the app's denial: the grant is on the
 *  app, not on one query, so the first refusal that lands puts up the gate. */
function deniedOf(payload: {
  vaultDenied?: VaultDenied | null;
}): VaultDenied | null {
  return payload.vaultDenied ?? null;
}

function markLanded(
  patch: Partial<TallyVaultState>,
  denied: VaultDenied | null
): void {
  set({
    ...patch,
    denied,
    loaded: true,
    reading: false,
    readError: "",
    lastReadAt: new Date().toISOString(),
    now: new Date().toISOString(),
    stale: false,
  });
}

function failed(error: unknown): void {
  set({
    reading: false,
    readError: error instanceof Error ? error.message : String(error),
  });
}

/** The spine. Called by the frame on arrival and by every refresh. */
export async function openTally(): Promise<void> {
  set({ reading: true });
  try {
    const dashboard = await tallyDashboard();
    markLanded({ dashboard }, deniedOf(dashboard));
  } catch (error) {
    failed(error);
  }
}

/** The spine plus whatever the route standing on it already asked for, in one
 *  moment — so a change event can never land the spine and the route's own
 *  rows a render apart. */
export async function refreshTally(): Promise<void> {
  const openGroup = state.group?.group?.group_id ?? null;
  const openFriend = state.friend?.friend?.party_id ?? null;
  const hadActivity = state.activity !== null;
  await openTally();
  await Promise.all([
    openGroup ? loadTallyGroup(openGroup) : Promise.resolve(),
    openFriend ? loadTallyFriend(openFriend) : Promise.resolve(),
    hadActivity ? loadTallyActivity() : Promise.resolve(),
  ]);
}

export async function loadTallyGroup(groupId: string): Promise<void> {
  if (!groupId) return;
  set({ reading: true });
  try {
    const group = await tallyGroup(groupId);
    markLanded({ group }, deniedOf(group));
  } catch (error) {
    failed(error);
  }
}

export async function loadTallyFriend(partyId: string): Promise<void> {
  if (!partyId) return;
  set({ reading: true });
  try {
    const friend = await tallyFriend(partyId);
    markLanded({ friend }, deniedOf(friend));
  } catch (error) {
    failed(error);
  }
}

export async function loadTallyActivity(): Promise<void> {
  set({ reading: true });
  try {
    const activity = await tallyActivity();
    markLanded({ activity }, deniedOf(activity));
  } catch (error) {
    failed(error);
  }
}

export async function loadTallyHistory(expenseId: string): Promise<void> {
  if (!expenseId) return;
  try {
    const history = await tallyHistory(expenseId);
    set({ history, denied: deniedOf(history) });
  } catch (error) {
    failed(error);
  }
}

/**
 * Descriptions only, and the surface says so.
 *
 * A cleared field DROPS the previous answer rather than leaving it on screen:
 * results standing under an empty query are results about nothing.
 */
export async function searchTally(term: string): Promise<void> {
  const trimmed = term.trim();
  set({ search: { term, data: null, searching: trimmed !== "" } });
  if (trimmed === "") return;
  try {
    const data = await tallySearch(trimmed);
    // A slower answer to an older query must not overwrite a newer one.
    if (state.search.term !== term) return;
    set({ search: { term, data, searching: false }, denied: deniedOf(data) });
  } catch (error) {
    if (state.search.term === term)
      set({ search: { term, data: null, searching: false } });
    failed(error);
  }
}

/** Read for its counts alone: the file is saved beside the gateway, and this
 *  seat states honestly how much WOULD leave (`tally-seat-copy.ts`). */
export async function loadTallyExport(groupId: string): Promise<void> {
  if (!groupId) return;
  try {
    const exported = await tallyExport(groupId);
    set({ exported, denied: deniedOf(exported) });
  } catch (error) {
    failed(error);
  }
}

/** Drop a cached payload the member is navigating away from, so the next
 *  group's ledger never paints under the previous group's name. */
export function forgetTally(
  which: "group" | "friend" | "history" | "export"
): void {
  if (which === "group") set({ group: null });
  else if (which === "friend") set({ friend: null });
  else if (which === "history") set({ history: null });
  else set({ exported: null });
}

/** One page more of the feed. The window is a window, and its foot says so. */
export function showMoreTallyActivity(): void {
  set({ window: state.window + ACTIVITY_STEP });
}
