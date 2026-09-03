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
import {
  ITEMS_WINDOW,
  lockerAuth,
  lockerItem,
  lockerItems,
  lockerSearch,
  lockerTrash,
  nextWindow,
} from "./locker-gateway";
import type { VaultDenial } from "./locker-gateway";

/** The sliding window and every reveal countdown are read from this one tick,
 *  so a reveal cannot outlive its session. */
const TICK_MS = 1000;

const STALE_AFTER_MS = 10 * 60 * 1000;

export interface LockerVaultState {
  session: SessionState;
  /** The enumerated secret-bearing half. Wiped whole, never field by field. */
  bag: SecretBag;
  denied: VaultDenial | null;
  rows: LockerRow[];
  truncated: boolean;
  limit: number;
  loaded: boolean;
  reading: boolean;
  readError: string;
  lastReadAt: string | null;
  /** Decided on the boundary's tick, never by a screen reading the clock
   *  during render — that is a purity violation and unstable besides. */
  stale: boolean;
  permitError: string;
  permitBusy: boolean;
  reauth: boolean;
  masked: boolean;
  credentialId: string | null;
  busy: boolean;
  accessWindow: { window: number; truncated: boolean } | null;
  accessError: string;
  importBatches: StagedBatch[] | null;
  openBatchId: string | null;
  importNote: string;
  surfaceBusy: boolean;
}

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
    lastReadAt: null,
    stale: false,
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
    const stale =
      state.lastReadAt !== null &&
      Date.now() - Date.parse(state.lastReadAt) > STALE_AFTER_MS;
    if (stale !== state.stale) set({ stale });
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
    lastReadAt: null,
    stale: false,
    permitError: "",
    reauth: false,
    ...lockedSurfaceState(),
  });
}

export function onLockerAppState(next: string): void {
  if (next === "active") {
    set({ masked: false });
    return;
  }
  set({ masked: true });
  if (isOpen(state.session)) lockNow();
}

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
    // Intentionally empty.
  }
  await removeLockerDeviceCredential();
  set({ busy: false, credentialId: null });
}

export async function loadLockerItems(limit = state.limit): Promise<void> {
  const token = state.bag.sessionToken;
  if (!token) return;
  set({ reading: true, readError: "" });
  try {
    const payload = await lockerItems(token, limit);
    if (payload.vaultDenied) {
      set({ reading: false, denied: payload.vaultDenied, loaded: true });
      return;
    }
    if (payload.authRequired) {
      lockNow();
      return;
    }
    set({
      reading: false,
      denied: null,
      rows: payload.items ?? [],
      truncated: payload.truncated === true,
      limit,
      loaded: true,
      lastReadAt: new Date().toISOString(),
      stale: false,
    });
  } catch (error) {
    set({ reading: false, readError: message(error), loaded: true });
  }
}

export function showMoreLockerItems(): Promise<void> {
  return loadLockerItems(nextWindow(state.limit));
}

/** Title, username and address — and it is the server that matches them, over
 *  fields the payload never returns. */
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
    // The local material goes either way: a credential this device cannot
    // produce is not a credential, whatever the gateway still believes.
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

export function askLockerPermit(request: PermitRequest): void {
  state.bag.permitRequest = request;
  set({ bag: { ...state.bag }, permitError: "", reauth: false });
}

export function dismissLockerPermit(): void {
  state.bag.permitRequest = null;
  set({ bag: { ...state.bag }, permitError: "" });
}

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

function revealFrom(detail: LockerDetail, field: string): void {
  const value = (detail as unknown as Record<string, unknown>)[field];
  if (typeof value !== "string" || value === "") return;
  state.bag.revealed = { ...state.bag.revealed, [field]: value };
  state.bag.revealedAt = { ...state.bag.revealedAt, [field]: Date.now() };
}

export function concealLockerField(field: string): void {
  const revealed = { ...state.bag.revealed };
  const revealedAt = { ...state.bag.revealedAt };
  delete revealed[field];
  delete revealedAt[field];
  state.bag.revealed = revealed;
  state.bag.revealedAt = revealedAt;
  set({ bag: { ...state.bag } });
}

export function closeLockerItem(): void {
  state.bag.detail = null;
  state.bag.revealed = {};
  state.bag.revealedAt = {};
  state.bag.permit = null;
  state.bag.permitRequest = null;
  set({ bag: { ...state.bag }, permitError: "", reauth: false });
}

export function setLockerGenerated(value: string): void {
  state.bag.generated = value;
  set({ bag: { ...state.bag } });
}
