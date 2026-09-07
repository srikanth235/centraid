// THE SESSION LEG OF THE BOUNDARY (README-Locker §2, rows "Session" and "On
// hiding"). Pure and DOM-free: every rule below was a rule a React component
// used to hold inline, where it could not be read and could not be tested.
//
// THE SESSION IS THE SHELL'S NOW (#996, ruling W6-D2). It used to be a token
// this app held, minted by a gateway that checked a passphrase this app
// collected. Both halves were wrong once `K` moved to the seat: an app that
// collects a passphrase is an app that can keep it, and a token that buys a
// server-side decryption is a token that buys plaintext from a gateway that
// should no longer be able to produce it. What is left here is the app's OWN
// half — which phase to draw, and what to forget — read off
// `window.centraid.locker.state()` and never from a credential.
//
// FIVE MINUTES, SLIDING, MEMORY ONLY. The app BOOTS LOCKED — `bootSession()`
// has no branch that returns an open session — and a hidden window ends the
// session at once rather than at the next timer tick. The shell runs the same
// clock over `K`; this one governs the PLAINTEXT THIS APP IS HOLDING, which is
// a different thing in the same window and has to be dropped whether or not
// the shell got there first.
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
import type {
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
 *   `unknown` — the shell has not answered yet, or offers no Locker door at
 *               all. Nothing is browsable and nothing claims to be: "locked"
 *               and "we have not asked" are different facts, and only one of
 *               them is fixed by unlocking.
 *   `locked`  — the shell holds `K` and the member has not unlocked.
 *   `open`    — the shell's session is live; a reveal will answer.
 *
 * `setup` is GONE. It meant "no passphrase exists yet", which was a question
 * for the app while the app collected the passphrase. Enrolment is the
 * shell's — it is what happens when a device receives `K` — and an app that
 * still drew a first-run gate would be drawing a gate it cannot honour.
 */
export type SessionPhase = "unknown" | "locked" | "open";

export interface SessionState {
  phase: SessionPhase;
  /** The refusal to show, in the door's own words. Empty when there is none. */
  error: string;
  /** Wall clock of the last member activity, for the sliding window. */
  lastActivityAt: number;
}

/** Boots LOCKED, always. There is no argument that opens this. */
export function bootSession(now: number = Date.now()): SessionState {
  return { phase: "unknown", error: "", lastActivityAt: now };
}

/**
 * Apply the shell's lock state (`window.centraid.locker.state()`).
 *
 * `null` is not "locked": it is a host with no Locker door — an older shell,
 * or a surface that cannot unseal locally — and the app must say so rather
 * than offer an unlock that will never arrive.
 */
export function afterLockState(
  state: SessionState,
  door: { status: "locked" | "unlocked" } | null,
  now: number = Date.now()
): SessionState {
  if (!door) return { ...state, phase: "unknown", lastActivityAt: now };
  return {
    ...state,
    phase: door.status === "unlocked" ? "open" : "locked",
    // A lock is not a failure, so it clears the last refusal with it.
    error: door.status === "unlocked" ? state.error : "",
    lastActivityAt: now,
  };
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

/**
 * End the app's session: forget the plaintext, and draw the lock.
 *
 * This does NOT lock the shell. The shell's session is the member's and is
 * ended on the shell's own surface; what the app controls is the plaintext it
 * is holding, and it drops that on its own clock as well as on the shell's —
 * the two windows are the same length and neither is allowed to be the only
 * one that runs.
 */
export function lock(
  state: SessionState,
  now: number = Date.now()
): SessionState {
  return { ...state, phase: "locked", error: "", lastActivityAt: now };
}

/** A hidden window ends a session AT ONCE — not at the next timer tick. */
export function locksOnVisibility(visibility: string): boolean {
  return visibility === "hidden";
}

/** Is anything browsable? False while locked and before the door answers —
 *  the band, the rail and every list read this. */
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
  /** The one secret-bearing payload in this app — the open item's fields. */
  detail: LockerDetail | null;
  /** Plaintext the shell's door returned, by field. Since #873 a sealed
   *  SIDECAR row's plaintext lands here too, under the namespaced key
   *  `field-model` mints for it — one map, so one wipe still empties every
   *  revealed value on the screen whatever kind of row it came off. */
  revealed: Record<string, string>;
  /** When each of those landed, for the countdown. */
  revealedAt: Record<string, number>;
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
  "detail",
  "revealed",
  "revealedAt",
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
    detail: null,
    revealed: {},
    revealedAt: {},
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
