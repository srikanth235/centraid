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
// `apps/locker/session.ts`, the permit arithmetic is `permits.ts`, and the
// enumerated secret-bearing bag plus its wipe are `session.ts`'s
// `SecretBag` / `wipeSecretState` — imported, never restated. This file is the
// seat's adapter: it holds those values, calls this seat's gateway door
// (`locker-gateway.ts`), and clears this seat's clipboard (`locker-clipboard.ts`),
// which the browser-shaped `clipboard.ts` cannot reach.

import type { StagedBatch } from "@centraid/blueprints/apps/locker/import-model";
import {
  isRevealExpired,
  permitFromAuth,
  spend,
} from "@centraid/blueprints/apps/locker/permits";
import type {
  Permit,
  PermitRequest,
} from "@centraid/blueprints/apps/locker/permits";
import {
  afterStatus,
  afterUnlock,
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

import { clearLockerClipboard } from "./locker-clipboard";
import {
  lockerDeviceCredentialId,
  newLockerDeviceSecret,
  readLockerDeviceCredential,
  removeLockerDeviceCredential,
  storeLockerDeviceCredential,
} from "./locker-device-auth";
import { lockerAuth, lockerItem } from "./locker-gateway";
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
  /** The permit gate is standing, and this is what it is refusing so far. */
  permitError: string;
  permitBusy: boolean;
  /** A permit expired with nothing revealed (STATES.md, Locker / Re-auth). */
  reauth: boolean;
  masked: boolean;
  credentialId: string | null;
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
    permitError: "",
    permitBusy: false,
    reauth: false,
    masked: false,
    credentialId: null,
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 * verb all come through here, so they cannot diverge. The gateway is told, but
 * a failed telling does not keep the local session alive.
 */
export function lockNow(): void {
  stopTicker();
  const token = state.bag.sessionToken;
  if (token) {
    void lockerAuth({ operation: "lock", sessionToken: token }).catch(
      () => undefined
    );
  }
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
    permitError: "",
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

/** The boot-time status read. Answers "is there a passphrase at all". */
export async function openLocker(): Promise<void> {
  set({ credentialId: await lockerDeviceCredentialId() });
  try {
    const payload = await lockerAuth({ operation: "status" });
    set({ session: afterStatus(state.session, payload), denied: null });
    if (isOpen(state.session)) await loadLockerItems();
  } catch (error) {
    set({ readError: message(error) });
  }
}

/** Unlock, or create the passphrase where there is none yet. */
export async function unlockLocker(
  secret: string,
  credentialId?: string
): Promise<void> {
  set({ busy: true });
  const configured = state.session.configured === true;
  try {
    const payload = await lockerAuth({
      operation: configured ? "unlock" : "configure",
      secret,
      ...(credentialId ? { credentialId } : {}),
    });
    const session = afterUnlock(state.session, payload);
    state.bag.sessionToken = payload.sessionToken ?? null;
    set({ session, bag: { ...state.bag }, busy: false });
    if (isOpen(session)) {
      startTicker();
      await loadLockerItems();
    }
  } catch (error) {
    set({ busy: false, readError: message(error) });
  }
}

/** The device credential, exchanged for the same unlock. */
export async function unlockLockerWithDevice(): Promise<void> {
  set({ busy: true });
  try {
    const credential = await readLockerDeviceCredential();
    if (!credential) {
      await removeLockerDeviceCredential();
      set({
        busy: false,
        credentialId: null,
        session: {
          ...state.session,
          error: "The device credential changed · unlock with the passphrase.",
        },
      });
      return;
    }
    set({ busy: false });
    await unlockLocker(credential.secret, credential.credentialId);
  } catch (error) {
    set({
      busy: false,
      session: { ...state.session, error: message(error) },
    });
  }
}

/** Enrol this device's biometric credential against the open session. */
export async function enrolLockerDevice(): Promise<void> {
  const token = state.bag.sessionToken;
  if (!token) return;
  set({ busy: true });
  let credentialId = "";
  try {
    const secret = await newLockerDeviceSecret();
    const payload = await lockerAuth({
      label: "This phone",
      operation: "enroll-device",
      secret,
      sessionToken: token,
    });
    credentialId = payload.credentialId ?? "";
    if (!payload.ok || !credentialId)
      throw new Error(payload.message ?? "The enrolment was refused.");
    await storeLockerDeviceCredential(credentialId, secret);
    set({ busy: false, credentialId });
  } catch (error) {
    if (credentialId) {
      void lockerAuth({
        credentialId,
        operation: "revoke-device",
        sessionToken: token,
      }).catch(() => undefined);
    }
    set({ busy: false, readError: message(error) });
  }
}

/** Revoke it. The passphrase is the one way in that cannot be revoked; this
 *  one can, and the screen says so. */
export async function revokeLockerDevice(): Promise<void> {
  const token = state.bag.sessionToken;
  const credentialId = state.credentialId;
  if (!token || !credentialId) return;
  set({ busy: true });
  try {
    await lockerAuth({
      credentialId,
      operation: "revoke-device",
      sessionToken: token,
    });
  } catch {
    // The local material goes either way: a credential this device cannot
    // produce is not a credential, whatever the gateway still believes.
  }
  await removeLockerDeviceCredential();
  set({ busy: false, credentialId: null });
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

// ─── The permit gate ────────────────────────────────────────────────────────

/** Stand the gate open for ONE field of ONE item. Nothing is revealed by
 *  asking; the gate is what the member answers. */
export function askLockerPermit(request: PermitRequest): void {
  state.bag.permitRequest = request;
  set({ bag: { ...state.bag }, permitError: "", reauth: false });
}

export function dismissLockerPermit(): void {
  state.bag.permitRequest = null;
  set({ bag: { ...state.bag }, permitError: "" });
}

/**
 * Answer it. A fresh confirmation mints one permit, the permit buys one read,
 * and the permit is spent on the way out — a permit that survived its read
 * would be a session by another name.
 */
export async function confirmLockerPermit(secret: string): Promise<void> {
  const request = state.bag.permitRequest;
  const token = state.bag.sessionToken;
  if (!request || !token) return;
  set({ permitBusy: true, permitError: "" });
  try {
    const payload = await lockerAuth({
      itemId: request.itemId,
      operation: "authorize-item",
      secret,
      sessionToken: token,
      ...(state.credentialId ? { credentialId: state.credentialId } : {}),
    });
    const outcome = permitFromAuth(request, payload);
    if (outcome.kind === "relock") {
      lockNow();
      return;
    }
    if (outcome.kind === "refused") {
      set({ permitBusy: false, permitError: outcome.message });
      return;
    }
    await spendLockerPermit(outcome.permit, request);
  } catch (error) {
    set({ permitBusy: false, permitError: message(error) });
  }
}

async function spendLockerPermit(
  permit: Permit,
  request: PermitRequest
): Promise<void> {
  const token = state.bag.sessionToken;
  if (!token) return;
  const payload = await lockerItem(token, request.itemId, permit.token);
  if (payload.vaultDenied) {
    set({
      permitBusy: false,
      permitError: payload.vaultDenied.message ?? "The vault refused the read.",
    });
    return;
  }
  const detail = payload.item ?? null;
  if (!detail) {
    set({ permitBusy: false, permitError: "This item no longer exists." });
    return;
  }
  revealFrom(detail, request.field);
  state.bag.permit = spend();
  state.bag.permitRequest = null;
  state.bag.detail = detail;
  state.session = touch(state.session);
  set({
    bag: { ...state.bag },
    permitBusy: false,
    permitError: "",
    reauth: false,
  });
}

/** Put the one field the permit was minted for on screen. An item whose type
 *  seals nothing reveals nothing — the read itself was what was authorised. */
function revealFrom(detail: LockerDetail, field: string): void {
  const value = (detail as unknown as Record<string, unknown>)[field];
  if (typeof value !== "string" || value === "") return;
  state.bag.revealed = { ...state.bag.revealed, [field]: value };
  state.bag.revealedAt = { ...state.bag.revealedAt, [field]: Date.now() };
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
  state.bag.permit = null;
  state.bag.permitRequest = null;
  set({ bag: { ...state.bag }, permitError: "", reauth: false });
}

/** The generator's output — a secret nobody has saved, and one of the
 *  enumerated fields a lock wipes. */
export function setLockerGenerated(value: string): void {
  state.bag.generated = value;
  set({ bag: { ...state.bag } });
}
