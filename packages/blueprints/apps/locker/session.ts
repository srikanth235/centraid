import { clearSecretClipboard } from "./clipboard.ts";
import type { StagedRow } from "./import-model.ts";
import type { Permit, PermitRequest } from "./permits.ts";
import type {
  AuthPayload,
  ItemDraftSeed,
  LockerAccessEntry,
  LockerDetail,
  LockerRow,
  UrlMatchPolicy,
} from "./types.ts";

export interface SidecarDraft {
  field: {
    fieldId?: string;
    section: string;
    label: string;
    kind: string;
    value: string;
  } | null;
  addresses: { url: string; matchPolicy: UrlMatchPolicy }[] | null;
  passkey: {
    rpId: string;
    userHandle: string;
    displayName: string;
    credentialId: string;
    algorithm: string;
    privateKey: string;
  } | null;
}

export function emptySidecarDraft(): SidecarDraft {
  return { field: null, addresses: null, passkey: null };
}

export const SESSION_IDLE_MS = 5 * 60 * 1000;

export type SessionPhase = "unknown" | "setup" | "locked" | "open";

export interface SessionState {
  phase: SessionPhase;
  token: string | null;
  configured: boolean | null;
  busy: boolean;
  error: string;
  lastActivityAt: number;
}

export function bootSession(now: number = Date.now()): SessionState {
  return {
    phase: "unknown",
    token: null,
    configured: null,
    busy: false,
    error: "",
    lastActivityAt: now,
  };
}

function restingPhase(configured: boolean | null | undefined): SessionPhase {
  if (configured === undefined || configured === null) return "unknown";
  return configured ? "locked" : "setup";
}

export function afterStatus(
  state: SessionState,
  payload: AuthPayload,
  now: number = Date.now()
): SessionState {
  const resumed = Boolean(payload.authenticated && payload.sessionToken);
  return {
    ...state,
    phase: resumed ? "open" : restingPhase(payload.configured),
    token: resumed ? (payload.sessionToken ?? null) : null,
    configured: payload.configured ?? state.configured,
    busy: false,
    error: payload.ok === false ? (payload.message ?? "") : "",
    lastActivityAt: now,
  };
}

export function afterUnlock(
  state: SessionState,
  payload: AuthPayload,
  now: number = Date.now()
): SessionState {
  const configured = payload.configured ?? state.configured;
  if (!payload.ok || !payload.sessionToken) {
    return {
      ...state,
      phase: restingPhase(configured),
      token: null,
      configured,
      busy: false,
      error: refusalText(payload),
      lastActivityAt: now,
    };
  }
  return {
    ...state,
    phase: "open",
    token: payload.sessionToken,
    configured: true,
    busy: false,
    error: "",
    lastActivityAt: now,
  };
}

export function refusalText(payload: AuthPayload): string {
  if (payload.message) return payload.message;
  if (payload.retryAfterMs) {
    return `Try again in ${Math.ceil(payload.retryAfterMs / 1000)} seconds.`;
  }
  return "The passphrase was not accepted.";
}

export function touch(
  state: SessionState,
  now: number = Date.now()
): SessionState {
  if (state.phase !== "open") return state;
  return { ...state, lastActivityAt: now };
}

export function isExpired(
  state: SessionState,
  now: number = Date.now()
): boolean {
  return (
    state.phase === "open" && now - state.lastActivityAt >= SESSION_IDLE_MS
  );
}

export function remainingIdleMs(
  state: SessionState,
  now: number = Date.now()
): number {
  if (state.phase !== "open") return 0;
  return Math.max(0, SESSION_IDLE_MS - (now - state.lastActivityAt));
}

export function lock(
  state: SessionState,
  now: number = Date.now()
): SessionState {
  return {
    ...state,
    phase: restingPhase(state.configured),
    token: null,
    busy: false,
    error: "",
    lastActivityAt: now,
  };
}

export function locksOnVisibility(visibility: string): boolean {
  return visibility === "hidden";
}

export function isOpen(state: SessionState): boolean {
  return state.phase === "open";
}

export interface SecretBag {
  sessionToken: string | null;
  detail: LockerDetail | null;
  revealed: Record<string, string>;
  revealedAt: Record<string, number>;
  permit: Permit | null;
  permitRequest: PermitRequest | null;
  editSeed: ItemDraftSeed | null;
  generated: string;
  searchTerm: string;
  searchResults: LockerRow[] | null;
  trashRows: LockerRow[];
  sidecarDraft: SidecarDraft;
  accessEntries: LockerAccessEntry[] | null;
  importRows: StagedRow[] | null;
}

export type SecretBearingKey = keyof SecretBag;

export const SECRET_BEARING_KEYS: readonly SecretBearingKey[] = [
  "sessionToken",
  "detail",
  "revealed",
  "revealedAt",
  "permit",
  "permitRequest",
  "editSeed",
  "generated",
  "searchTerm",
  "searchResults",
  "trashRows",
  "sidecarDraft",
  "accessEntries",
  "importRows",
];

export function emptySecretBag(): SecretBag {
  return {
    sessionToken: null,
    detail: null,
    revealed: {},
    revealedAt: {},
    permit: null,
    permitRequest: null,
    editSeed: null,
    generated: "",
    searchTerm: "",
    searchResults: null,
    trashRows: [],
    sidecarDraft: emptySidecarDraft(),
    accessEntries: null,
    importRows: null,
  };
}

export function wipeSecretState(bag: SecretBag): void {
  Object.assign(bag, emptySecretBag());
  clearSecretClipboard();
}
