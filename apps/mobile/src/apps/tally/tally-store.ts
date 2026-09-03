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

const STALE_AFTER_MS = 10 * 60 * 1000;

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
  group: GroupData | null;
  friend: FriendData | null;
  activity: ActivityData | null;
  history: HistoryData | null;
  search: TallySearchState;
  exported: ExportData | null;
  loaded: boolean;
  reading: boolean;
  readError: string;
  denied: VaultDenied | null;
  lastReadAt: string | null;
  stale: boolean;
  now: string;
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

export function resetTallyVault(): void {
  stopTicker();
  state = initialState();
  emit();
}

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

export async function openTally(): Promise<void> {
  set({ reading: true });
  try {
    const dashboard = await tallyDashboard();
    markLanded({ dashboard }, deniedOf(dashboard));
  } catch (error) {
    failed(error);
  }
}

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

export async function searchTally(term: string): Promise<void> {
  const trimmed = term.trim();
  set({ search: { term, data: null, searching: trimmed !== "" } });
  if (trimmed === "") return;
  try {
    const data = await tallySearch(trimmed);
    if (state.search.term !== term) return;
    set({ search: { term, data, searching: false }, denied: deniedOf(data) });
  } catch (error) {
    if (state.search.term === term)
      set({ search: { term, data: null, searching: false } });
    failed(error);
  }
}

export async function loadTallyExport(groupId: string): Promise<void> {
  if (!groupId) return;
  try {
    const exported = await tallyExport(groupId);
    set({ exported, denied: deniedOf(exported) });
  } catch (error) {
    failed(error);
  }
}

export function forgetTally(
  which: "group" | "friend" | "history" | "export"
): void {
  if (which === "group") set({ group: null });
  else if (which === "friend") set({ friend: null });
  else if (which === "history") set({ history: null });
  else set({ exported: null });
}

export function showMoreTallyActivity(): void {
  set({ window: state.window + ACTIVITY_STEP });
}
