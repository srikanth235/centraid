// THE SESSION LEG OF THE BOUNDARY (README-Locker §2, rows "Session" and "On
// hiding"). Pure and DOM-free: every rule below was a rule a React component
// used to hold inline, where it could not be read and could not be tested.
//
// FIVE MINUTES, SLIDING, MEMORY ONLY. The app BOOTS LOCKED — `bootSession()`
// has no branch that returns an open session — and a hidden window ends the
// session at once rather than at the next timer tick.
//
// AND THE STRUCTURAL RULE THIS FILE EXISTS FOR: no secret value may reach a
// durable store, a log line or a search structure on this seat. That is not a
// promise made in prose here; it is `SECRET_BEARING_KEYS`, which names every
// field of the app's ref bag that holds, or is derived from, a secret.
// `wipeSecretState` empties exactly that list, `session.test.ts` asserts the
// two agree, and the bag itself lives in a `useRef` that nothing serialises —
// so a new secret-bearing field cannot be added without the wipe learning
// about it.

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

/**
 * What the edit form's SIDECAR editors hold between keystrokes (#872).
 *
 * It is in the secret bag rather than the view bag because two of its three
 * halves can hold a plaintext a member is halfway through typing: a `sealed`
 * custom field's value, and a passkey's private key. The third — the address
 * list — is metadata, and it rides along rather than being declared apart,
 * because "one editor, one draft" is easier to keep true than "two drafts, one
 * of which a lock erases".
 */
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

/** Five minutes of inactivity ends a session. */
export const SESSION_IDLE_MS = 5 * 60 * 1000;

/**
 * Where the member stands with respect to the boundary.
 *
 *   `unknown` — the status read has not answered; nothing is browsable and
 *               nothing claims to be, because "locked" and "we have not asked"
 *               are different facts and only one of them offers a passphrase
 *               field that will work.
 *   `setup`   — no passphrase exists yet. The first-run gate IS day one.
 *   `locked`  — a passphrase exists; no session does.
 *   `open`    — a live session, sliding.
 */
export type SessionPhase = "unknown" | "setup" | "locked" | "open";

export interface SessionState {
  phase: SessionPhase;
  /** The host's memory-session token. Never persisted, never logged. */
  token: string | null;
  /** Has a passphrase been configured? `null` until the status read answers. */
  configured: boolean | null;
  /** An authentication request is in flight. */
  busy: boolean;
  /** The refusal, in the host's own words. Empty when there is none. */
  error: string;
  /** Wall clock of the last member activity, for the sliding window. */
  lastActivityAt: number;
}

/** Boots LOCKED, always. There is no argument that opens this. */
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

/** The phase a `configured` answer implies when there is no live session. */
function restingPhase(configured: boolean | null | undefined): SessionPhase {
  if (configured === undefined || configured === null) return "unknown";
  return configured ? "locked" : "setup";
}

/**
 * Apply the boot-time `status` answer. A host MAY hand back an already
 * user-present in-memory session (the local app-boot harness exercises that
 * path); a persisted token can never do so, because the gateway forgets them
 * on restart.
 */
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

/** Apply an `unlock` or `configure` answer. */
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
    // A successful unlock proves a passphrase exists, whatever the payload
    // said: a `configure` answer that omitted the flag must not leave the app
    // believing it is still at first run.
    configured: true,
    busy: false,
    error: "",
    lastActivityAt: now,
  };
}

/** The words a refusal wears. The host's message wins; a rate limit falls back
 *  to its own backoff sentence; anything else states the plain fact. */
export function refusalText(payload: AuthPayload): string {
  if (payload.message) return payload.message;
  if (payload.retryAfterMs) {
    return `Try again in ${Math.ceil(payload.retryAfterMs / 1000)} seconds.`;
  }
  return "The passphrase was not accepted.";
}

/** Mark activity. Sliding, not extending: the window restarts from `now`. */
export function touch(
  state: SessionState,
  now: number = Date.now()
): SessionState {
  if (state.phase !== "open") return state;
  return { ...state, lastActivityAt: now };
}

/** Has the sliding window run out? */
export function isExpired(
  state: SessionState,
  now: number = Date.now()
): boolean {
  return (
    state.phase === "open" && now - state.lastActivityAt >= SESSION_IDLE_MS
  );
}

/** How long is left, in whole milliseconds, before the idle window ends. */
export function remainingIdleMs(
  state: SessionState,
  now: number = Date.now()
): number {
  if (state.phase !== "open") return 0;
  return Math.max(0, SESSION_IDLE_MS - (now - state.lastActivityAt));
}

/** End the session. The phase falls back to what the passphrase facts imply,
 *  so locking never strands the member on a first-run gate they have passed. */
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

/** A hidden window ends a session AT ONCE — not at the next timer tick. */
export function locksOnVisibility(visibility: string): boolean {
  return visibility === "hidden";
}

/** Is anything browsable? False at setup, while locked, and before the status
 *  read answers — the band, the rail and every list read this. */
export function isOpen(state: SessionState): boolean {
  return state.phase === "open";
}

// ---------------------------------------------------------------------------
// The secret-bearing bag
// ---------------------------------------------------------------------------

/**
 * EVERY field of the app's mutable bag that holds, or is derived from, a
 * secret. This list is the boundary's structural half: `wipeSecretState`
 * empties exactly these, and nothing on this list is ever written to a durable
 * store, a log line, or a search structure.
 *
 * `searchResults` and `trashRows` carry no secret VALUES — the queries that
 * fill them return the secret-free row shape — but they are the browsable
 * projection a live session bought, so a lock takes them with it rather than
 * leaving a list standing behind a lock screen.
 */
export interface SecretBag {
  /** The host's memory-session token. */
  sessionToken: string | null;
  /** The one secret-bearing payload in this app — the open item's fields. */
  detail: LockerDetail | null;
  /** Plaintext values a live permit revealed, by field. Since #873 a sealed
   *  SIDECAR row's plaintext lands here too, under the namespaced key
   *  `field-model` mints for it — one map, so one wipe still empties every
   *  revealed value on the screen whatever kind of row it came off. */
  revealed: Record<string, string>;
  /** When each of those landed, for the countdown. */
  revealedAt: Record<string, number>;
  /** The live one-shot permit, if any. */
  permit: Permit | null;
  /** What the gate is standing open for. */
  permitRequest: PermitRequest | null;
  /** The add / edit form's seed, which can hold a typed secret. */
  editSeed: ItemDraftSeed | null;
  /** The generator's current output — a secret nobody has saved yet. */
  generated: string;
  /** The term and its results: browsable metadata a live session bought. */
  searchTerm: string;
  searchResults: LockerRow[] | null;
  trashRows: LockerRow[];
  /** The sidecar editors' typed values — a sealed custom field and a passkey's
   *  key material among them. */
  sidecarDraft: SidecarDraft;
  /** The access history a live session bought. No receipt has ever carried a
   *  VALUE, but the list of what a member looked at is exactly the browsable
   *  projection a lock takes with it. */
  accessEntries: LockerAccessEntry[] | null;
  /** The staged import rows under review. Metadata — dispositions and column
   *  mappings — and still a member's file, held only while the session is. */
  importRows: StagedRow[] | null;
}

export type SecretBearingKey = keyof SecretBag;

/**
 * Every field of `SecretBag`, as a runtime list. The type alone cannot be
 * iterated, and the wipe has to be — so the two are pinned to each other by
 * `session.test.ts`, and a field added to one without the other fails there.
 */
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

/** What each secret-bearing field is when it holds nothing. */
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

/**
 * Erase every secret-bearing or secret-derived client value, and the
 * clipboard with them. Mutates in place — the orchestrator's closures hold
 * this object — and is the ONLY door through which a lock happens, so the
 * refresh-expiry path, the hide path and the explicit lock cannot diverge.
 */
export function wipeSecretState(bag: SecretBag): void {
  Object.assign(bag, emptySecretBag());
  clearSecretClipboard();
}
