// THE BOUNDARY, ON THIS SEAT (README-Locker §2, "build first").
//
// One module-level store, subscribed to with `useSyncExternalStore` — the same
// shape the frame's status line uses (`kit/components/status-line.ts`) — and
// for the same reason: what it holds is process memory, shared by every Locker
// route, and it must not be a React context that a remount could reconstruct
// with a session in it. It BOOTS LOCKED, it locks when the app is hidden, and
// nothing in it is ever handed a durable store.
//
// The rules themselves are NOT here. The session state machine is
// `apps/locker/session.ts`, the reveal's own clock is `reveal.ts`, and the
// enumerated secret-bearing bag plus its wipe are `session.ts`'s
// `SecretBag` / `wipeSecretState` — imported, never restated. This file is the
// seat's adapter: it holds those values, calls this seat's gateway door
// (`locker-gateway.ts`), and clears this seat's clipboard (`locker-clipboard.ts`),
// which the browser-shaped `clipboard.ts` cannot reach.

import type { StagedBatch } from "@centraid/blueprints/apps/locker/import-model";
import { isRevealExpired } from "@centraid/blueprints/apps/locker/reveal";
import type { RevealRequest } from "@centraid/blueprints/apps/locker/reveal";
import {
  afterLockState,
  bootSession,
  emptySecretBag,
  isExpired,
  isOpen,
  lock as lockSession,
  touch,
  wipeSecretState,
} from "@centraid/blueprints/apps/locker/session";
import type {
  SecretBag,
  SessionState,
} from "@centraid/blueprints/apps/locker/session";
import type {
  LockerDetail,
  LockerRow,
} from "@centraid/blueprints/apps/locker/types";

import { getActiveVaultId } from "../../lib/vault-links";
import { clearLockerClipboard } from "./locker-clipboard";
import {
  lockLocker,
  lockerUnlocked,
  removeLockerVaultKey,
} from "./locker-device-auth";
import { revealLockerRow, unlockLockerDoor } from "./locker-door";
import { enrolThisPhoneInLocker } from "./locker-enrol";
import { lockerRevealReceipt } from "./locker-gateway";
import {
  ITEMS_WINDOW,
  lockerItems,
  lockerSearch,
  lockerTrash,
  nextWindow,
} from "./locker-reads";
import type { VaultDenial } from "./locker-reads";

/** The sliding window and every reveal countdown are read from this one tick,
 *  so a reveal cannot outlive its session. */
const TICK_MS = 1000;

export interface LockerVaultState {
  session: SessionState;
  /** The enumerated secret-bearing half. Wiped whole, never field by field. */
  bag: SecretBag;
  /** The vault's refusal, as data. Denial is a screen, not an error. */
  denied: VaultDenial | null;
  /** The browsable window a live session bought. Dropped by a lock with the
   *  bag, so no list is ever left standing behind a lock screen. */
  rows: LockerRow[];
  truncated: boolean;
  limit: number;
  loaded: boolean;
  reading: boolean;
  readError: string;
  /** The door's refusal, in its own words, on the reveal that asked for it. */
  revealError: string;
  /** This phone holds no `K` for this vault, and no gesture here can get one
   *  (#1015 B1, #996 W6). The wall states the absence instead of offering an
   *  unlock that refuses every time. */
  notEnrolled: boolean;
  revealBusy: boolean;
  /** A reveal took itself off the screen with nothing left (STATES.md). */
  reauth: boolean;
  masked: boolean;
  busy: boolean;
  /** `null` before one lands — an audit surface says nothing until it reads. */
  accessWindow: { window: number; truncated: boolean } | null;
  /** Why the receipts could not be read. A refusal is not an empty history. */
  accessError: string;
  /** `null` before the list lands. */
  importBatches: StagedBatch[] | null;
  openBatchId: string | null;
  importNote: string;
  surfaceBusy: boolean;
}

/**
 * The only part of this store anything outside this file may write. `bag` is in
 * the set so Access history and Import fill fields the SHARED bag declares and
 * a lock takes both through `wipeSecretState`, not a second rule.
 */
export type LockerSurfacePatch = Partial<
  Pick<
    LockerVaultState,
    | "accessError"
    | "accessWindow"
    | "bag"
    | "importBatches"
    | "importNote"
    | "openBatchId"
    | "surfaceBusy"
  >
>;

function initialState(): LockerVaultState {
  return {
    session: bootSession(),
    bag: emptySecretBag(),
    denied: null,
    rows: [],
    truncated: false,
    limit: ITEMS_WINDOW,
    loaded: false,
    reading: false,
    readError: "",
    revealError: "",
    notEnrolled: false,
    revealBusy: false,
    reauth: false,
    masked: false,
    busy: false,
    accessWindow: null,
    accessError: "",
    importBatches: null,
    openBatchId: null,
    importNote: "",
    surfaceBusy: false,
  };
}

/** What a lock takes from Access history and Import. Their secret-bearing
 *  halves ride the bag's own wipe; these are the companions. */
function lockedSurfaceState(): LockerSurfacePatch {
  return {
    accessWindow: null,
    accessError: "",
    importBatches: null,
    openBatchId: null,
    importNote: "",
    surfaceBusy: false,
  };
}

let state: LockerVaultState = initialState();
const subscribers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  // Snapshot: a subscriber that unsubscribes as it reacts must not mutate
  // the set mid-iteration.
  for (const notify of Array.from(subscribers)) notify();
}

function set(patch: Partial<LockerVaultState>): void {
  state = { ...state, ...patch };
  emit();
}

export function subscribeLockerVault(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function readLockerVault(): LockerVaultState {
  return state;
}

/** The one door `locker-surfaces.ts` writes through — typed to that slice so it
 *  can never reach the session, the permits or the wipe. `readLockerVault()` is
 *  the matching half, and there is deliberately no general setter. */
export function setLockerSurfaceState(patch: LockerSurfacePatch): void {
  set(patch);
}

/** Test seam. Production never resets — a process restart is the only reset,
 *  and that is the point (the Maestro flow proves it). */
export function resetLockerVault(): void {
  stopTicker();
  state = initialState();
  subscribers.clear();
}

/**
 * S14 (#1015, R-A-15): the exception is a fact about the program. What the
 * transport, the keychain or the SQLite driver throws goes to the log
 * (docs/logs.md); the pane gets Locker's own sentence and the one retry word.
 */
function message(error: unknown): string {
  console.warn("[locker] read failed", error);
  return LOCKER_NOT_READ;
}

/** Locker's ONE read-failure sentence. */
const LOCKER_NOT_READ = "Locker could not be read. Try again.";

// ─── The clock ──────────────────────────────────────────────────────────────

function stopTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    if (isExpired(state.session)) {
      lockNow();
      return;
    }
    // A revealed value outliving the permit that bought it conceals itself.
    const outlived = Object.entries(state.bag.revealedAt).filter(([, at]) =>
      isRevealExpired(at)
    );
    if (outlived.length === 0) return;
    const revealed = { ...state.bag.revealed };
    const revealedAt = { ...state.bag.revealedAt };
    for (const [field] of outlived) {
      delete revealed[field];
      delete revealedAt[field];
    }
    state.bag.revealed = revealed;
    state.bag.revealedAt = revealedAt;
    set({ reauth: true });
  }, TICK_MS);
}

/** Mark member activity. Sliding, never extending. */
export function noteLockerActivity(): void {
  if (!isOpen(state.session)) return;
  state = { ...state, session: touch(state.session) };
}

// ─── Locking ────────────────────────────────────────────────────────────────

/**
 * End the session. The ONE door: the idle path, the hide path and the explicit
 * verb all come through here, so they cannot diverge.
 *
 * It drops `K` from the process too (#996, W6-D2) — `lockLocker()` empties the
 * keychain session cache, so the next reveal costs an OS prompt. Nothing is
 * told to a gateway, because the gateway holds no session to end: what a lock
 * ends here is this device's access to its own vault key.
 */
export function lockNow(): void {
  stopTicker();
  lockLocker();
  wipeSecretState(state.bag);
  clearLockerClipboard();
  set({
    session: lockSession(state.session),
    bag: { ...state.bag },
    rows: [],
    truncated: false,
    limit: ITEMS_WINDOW,
    loaded: false,
    readError: "",
    revealError: "",
    reauth: false,
    ...lockedSurfaceState(),
  });
}

/** A hidden window ends a session AT ONCE, and paints the switcher mask. */
export function onLockerAppState(next: string): void {
  if (next === "active") {
    set({ masked: false });
    return;
  }
  set({ masked: true });
  if (isOpen(state.session)) lockNow();
}

// ─── Opening ────────────────────────────────────────────────────────────────

/**
 * Open the Locker. There is no status read and no passphrase (#996, W6-D2):
 * the boundary is the OS prompt over `K`, so "is it open" is "does this
 * process still hold the key", which the keychain session answers locally.
 */
export async function openLocker(): Promise<void> {
  set({ session: afterLockState(state.session, lockState()), denied: null });
  if (isOpen(state.session)) {
    startTicker();
    await loadLockerItems();
  }
}

/** What the shell's lock is, in the shape the shared state machine reads. */
function lockState(): { status: "locked" | "unlocked" } {
  return { status: lockerUnlocked() ? "unlocked" : "locked" };
}

/**
 * Unlock by proving presence to the OS.
 *
 * The passphrase and the device-credential exchange are both GONE. They
 * existed to buy a gateway session; the gateway has none to sell. What is left
 * is the gesture the phone always had and R13 names as the real boundary:
 * Face ID, Touch ID or the device passcode, enforced by the keychain, which
 * `readLockerVaultKey` triggers on the first reveal of a session. This verb
 * warms that session so the item screen opens unlocked rather than prompting
 * under the member's first tap.
 */
export async function unlockLocker(): Promise<void> {
  const vaultId = getActiveVaultId();
  set({ busy: true });
  try {
    const answer = await unlockLockerDoor(vaultId);
    // The prompt IS the unlock, and a refusal is a lock rather than an error.
    const session = afterLockState(state.session, lockState());
    set({
      session: answer.ok ? session : { ...session, error: answer.message },
      busy: false,
      notEnrolled: !answer.ok && answer.reason === "not_enrolled",
      revealError: "",
    });
    if (isOpen(state.session)) {
      startTicker();
      await loadLockerItems();
    }
  } catch (error) {
    set({ busy: false, readError: message(error) });
  }
}

/**
 * Enrol this phone: fetch `K` over the desktop link and put it in the
 * keychain (#1015, R-NY-19).
 *
 * On success the wall does NOT unlock itself. Holding the key and proving
 * presence are two different facts, and collapsing them would mean the OS
 * prompt the member has not answered yet had been answered for them. The
 * absence is gone, so `notEnrolled` clears and the unlock verb appears.
 */
export async function enrolLockerPhone(): Promise<void> {
  const vaultId = getActiveVaultId();
  set({ busy: true });
  const answer = await enrolThisPhoneInLocker(vaultId);
  set({
    busy: false,
    notEnrolled: !answer.ok,
    session: answer.ok
      ? state.session
      : { ...state.session, error: answer.message },
  });
}

/** Forget `K` on this device — the revoke screen's local half (R13). */
export async function forgetLockerVaultKey(): Promise<void> {
  const vaultId = getActiveVaultId();
  set({ busy: true });
  await removeLockerVaultKey(vaultId);
  lockNow();
  set({ busy: false });
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * The bounded window, read from THIS DEVICE'S replica. `limit` is what
 * *Show more* widens.
 *
 * The read needs no session token — a `locker.item` window is the app grant's
 * (#928) — but it still waits for an open one, because a locker that draws its
 * own list behind its lock screen has not locked anything.
 */
export async function loadLockerItems(limit = state.limit): Promise<void> {
  if (!isOpen(state.session)) return;
  set({ reading: true, readError: "" });
  try {
    const payload = await lockerItems(limit);
    if (payload.vaultDenied) {
      set({ reading: false, denied: payload.vaultDenied, loaded: true });
      return;
    }
    set({
      reading: false,
      denied: null,
      rows: payload.items ?? [],
      truncated: payload.truncated === true,
      limit,
      loaded: true,
    });
  } catch (error) {
    set({ reading: false, readError: message(error), loaded: true });
  }
}

/** One page more, capped by the query's own ceiling. */
export function showMoreLockerItems(): Promise<void> {
  return loadLockerItems(nextWindow(state.limit));
}

/**
 * A change landed in the replica this seat now reads from, so the window has
 * to be re-taken — and with it the trash shelf, but only where the member has
 * already opened it. A locked session holds no rows, so it re-reads none.
 */
export async function refreshLockerItems(): Promise<void> {
  if (!isOpen(state.session)) return;
  const hadTrash = state.bag.trashRows.length > 0;
  await loadLockerItems();
  if (hadTrash) await loadLockerTrash();
}

/** Title, username and address — matched over fields the payload never
 *  returns, by the app's own query, on this device. */
export async function searchLocker(term: string): Promise<void> {
  state.bag.searchTerm = term;
  if (!term.trim()) {
    state.bag.searchResults = null;
    set({ bag: { ...state.bag } });
    return;
  }
  set({ bag: { ...state.bag }, reading: true });
  try {
    const payload = await lockerSearch(term);
    state.bag.searchResults = payload.items ?? [];
    set({ bag: { ...state.bag }, reading: false, readError: "" });
  } catch (error) {
    set({ reading: false, readError: message(error) });
  }
}

export async function loadLockerTrash(): Promise<void> {
  set({ reading: true });
  try {
    const payload = await lockerTrash();
    state.bag.trashRows = payload.items ?? [];
    set({ bag: { ...state.bag }, reading: false, readError: "" });
  } catch (error) {
    set({ reading: false, readError: message(error) });
  }
}

// ─── The reveal ─────────────────────────────────────────────────────────────

/**
 * REVEAL ONE FIELD, THROUGH THIS SEAT'S DOOR (#996, ruling W6-D2).
 *
 * What used to be a gate the member answered with a passphrase, a permit the
 * gateway minted, and a privileged read that carried plaintext back over the
 * wire is now: the OS asks the member to prove they are present, `K` comes out
 * of the keychain, and the value is decrypted here. It works in airplane mode.
 *
 * Nothing is revealed by ASKING — the prompt is the gesture, and a cancelled
 * prompt is a lock, not an error.
 */
export async function revealLockerField(request: RevealRequest): Promise<void> {
  const vaultId = getActiveVaultId();
  const detail = state.bag.detail;
  if (!detail) return;
  set({ revealBusy: true, revealError: "", reauth: false });
  const rowId = request.sidecar?.entityId ?? request.itemId;
  const column = request.sidecar?.column ?? request.field;
  const ciphertext = ciphertextOf(detail, request, column);
  if (ciphertext === null) {
    // A field this row does not carry is nothing to ask for, and asking would
    // spend a receipt on a value that does not exist.
    set({ revealBusy: false });
    return;
  }
  let answer;
  try {
    answer = await revealLockerRow({
      vaultId,
      rowId,
      ...(request.sidecar ? { entity: request.sidecar.entity } : {}),
      ciphertext: { [column]: ciphertext },
      keyId: keyIdOf(detail, request),
      recordReveal: (input) => lockerRevealReceipt(input),
    });
  } catch (error) {
    set({ revealBusy: false, revealError: message(error) });
    return;
  }
  if (!answer.ok) {
    // A locked door is the seat's state, not a refusal to narrate: fall to the
    // lock screen and let the member prove presence again.
    if (answer.reason === "locked" || answer.reason === "not_enrolled") {
      lockNow();
      return;
    }
    set({ revealBusy: false, revealError: answer.message });
    return;
  }
  const value = answer.values[column];
  if (typeof value === "string" && value.length > 0) {
    state.bag.revealed = { ...state.bag.revealed, [request.field]: value };
    state.bag.revealedAt = {
      ...state.bag.revealedAt,
      [request.field]: Date.now(),
    };
  }
  state.session = touch(state.session);
  set({
    bag: { ...state.bag },
    revealBusy: false,
    revealError: "",
    reauth: false,
  });
}

/** The ciphertext this ask names, off the detail this screen already holds. */
function ciphertextOf(
  detail: LockerDetail,
  request: RevealRequest,
  column: string
): string | null {
  if (request.sidecar) {
    const row = (detail as unknown as Record<string, unknown>)[
      request.sidecar.entity === "locker.item_passkey" ? "passkey" : "fields"
    ] as Record<string, unknown>[] | Record<string, unknown> | undefined;
    const found = Array.isArray(row)
      ? row.find((entry) => entry["field_id"] === request.sidecar?.entityId)
      : row;
    const value = found?.[column];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  const value = (detail as unknown as Record<string, unknown>)[column];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Which Locker key that row's ciphertext is under, as the seat holds it. */
function keyIdOf(detail: LockerDetail, request: RevealRequest): string | null {
  const row = detail as unknown as Record<string, unknown>;
  if (!request.sidecar) {
    return typeof row["key_id"] === "string" ? row["key_id"] : null;
  }
  const fields = row["fields"] as Record<string, unknown>[] | undefined;
  const found = fields?.find(
    (entry) => entry["field_id"] === request.sidecar?.entityId
  );
  return typeof found?.["key_id"] === "string" ? found["key_id"] : null;
}

/** Put one revealed value away by hand, before its countdown runs out. */
export function concealLockerField(field: string): void {
  const revealed = { ...state.bag.revealed };
  const revealedAt = { ...state.bag.revealedAt };
  delete revealed[field];
  delete revealedAt[field];
  state.bag.revealed = revealed;
  state.bag.revealedAt = revealedAt;
  set({ bag: { ...state.bag } });
}

/** Leaving the item screen takes every reveal with it. */
export function closeLockerItem(): void {
  state.bag.detail = null;
  state.bag.revealed = {};
  state.bag.revealedAt = {};
  set({ bag: { ...state.bag }, revealError: "", reauth: false });
}

/** The generator's output — a secret nobody has saved, and one of the
 *  enumerated fields a lock wipes. */
export function setLockerGenerated(value: string): void {
  state.bag.generated = value;
  set({ bag: { ...state.bag } });
}
