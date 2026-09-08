/*
 * `window.centraid.locker` — THE SHELL KIT DOOR (#996, rulings R13 and W6-D2).
 *
 * BLUEPRINT CODE NEVER HOLDS `K`. That is the whole design, and it is a
 * narrower rule than "the seat decrypts locally". R13 puts the unseal on the
 * seat; W6-D2 says which part of the seat: the SHELL holds `K`, behind the
 * unlock boundary, and an app gets the PLAINTEXT OF ONE ROW PER RECEIPT and
 * never the key. An app surface that could read `K` could also exfiltrate it —
 * one `fetch` in a blueprint and the vault key is on someone else's server,
 * and no receipt would record it because nothing was revealed. So the key
 * stays on the shell side of the bridge and what crosses is an answer.
 *
 * WHAT THE DOOR IS, AND WHAT IT DELIBERATELY IS NOT:
 *
 *   - `reveal({ rowId })` unseals with `K` and returns plaintext, writing the
 *     reveal receipt through the SAME receipt path `gateway.reveal` used. The
 *     audit trail does not change shape — "who looked at which secret, when"
 *     is the one thing that must survive the boundary moving, because with
 *     the gateway no longer decrypting it is the only record left.
 *   - `state()` and `subscribeLock()` so screens render the SHELL's lock surface.
 *     An app that drew its own passphrase prompt would be an app collecting
 *     the passphrase, which is the same mistake as handing it `K` wearing a
 *     different hat.
 *   - NO seal door, and no `unlock()`. A write stays an intent carrying the
 *     secret over the tunnel, and the gateway's `sealWrites` stamps the live
 *     key (`stampLockerKeyOnWrite`); unlocking is a shell gesture the member
 *     makes, never something an app can trigger. `reveal` on a locked session
 *     returns a typed refusal and prompts for nothing — a door that could
 *     raise the prompt is a door that can be used to phish it.
 *
 * The transports are INJECTED rather than imported. The web shell, the
 * Electron renderer and the React Native bridge each reach the vault and the
 * intent queue differently, and this module is the one piece of the boundary
 * all three must agree on — so it owns the rule and none of the plumbing.
 */

import { decryptLockerSecret, StaleLockerKeyError } from "./locker-secret.js";
import { LockerUnlockError } from "./locker-unlock.js";
import type { LockerSession } from "./locker-unlock.js";

/** What a locked door says. Typed, because "failed" is not an answer a screen can render. */
export type LockerRefusalReason =
  | "locked"
  | "not_enrolled"
  | "stale_key"
  | "not_found"
  | "unavailable";

export interface LockerRevealed {
  readonly ok: true;
  readonly rowId: string;
  /** Column → plaintext. Only the columns that held ciphertext. */
  readonly values: Readonly<Record<string, string>>;
  /** The receipt this reveal wrote, when the shell's receipt path returned one. */
  readonly receiptId?: string;
}

export interface LockerRefused {
  readonly ok: false;
  readonly reason: LockerRefusalReason;
  readonly message: string;
}

export type LockerRevealAnswer = LockerRevealed | LockerRefused;

export interface LockerDoorState {
  readonly status: "locked" | "unlocked";
  /** Milliseconds until this session ends; 0 when locked. */
  readonly remainingMs: number;
}

/** One Locker row as the vault holds it: ciphertext, and which key it is under. */
export interface LockerCiphertextRow {
  readonly keyId: string | null;
  readonly values: Readonly<Record<string, string>>;
}

export interface LockerKitDoorOptions {
  readonly session: LockerSession;
  /** Read one row's ciphertext columns. `null` when the row does not exist. */
  readonly readRow: (request: {
    rowId: string;
    entity: string;
    columns?: readonly string[];
  }) => Promise<LockerCiphertextRow | null>;
  /**
   * Write the reveal receipt — the journal row `gateway.reveal` used to write,
   * through the shell's existing receipt/intent path. Called AFTER a
   * successful decryption and BEFORE the plaintext is handed over, so a
   * reveal that could not be recorded is a reveal that does not happen.
   */
  readonly recordReveal: (request: {
    rowId: string;
    entity: string;
    columns: readonly string[];
    keyId: string;
  }) => Promise<{ receiptId?: string }>;
}

export interface CentraidLockerDoor {
  reveal: (opts: {
    rowId: string;
    entity?: string;
    columns?: readonly string[];
  }) => Promise<LockerRevealAnswer>;
  state: () => LockerDoorState;
  subscribeLock: (listener: (state: LockerDoorState) => void) => () => void;
}

const DEFAULT_ENTITY = "locker.item";

function refuse(reason: LockerRefusalReason, message: string): LockerRefused {
  return { ok: false, reason, message };
}

export function createLockerKitDoor(
  options: LockerKitDoorOptions
): CentraidLockerDoor {
  const listeners = new Set<(state: LockerDoorState) => void>();
  const state = (): LockerDoorState => ({
    status: options.session.unlocked ? "unlocked" : "locked",
    remainingMs: options.session.remainingMs,
  });

  // Polled rather than pushed, because the thing that changes the answer most
  // often is the CLOCK — the session ends by expiring, and nothing fires an
  // event when it does. Cheap: two field reads, and only while someone is
  // listening.
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: LockerDoorState | undefined;
  const tick = (): void => {
    const next = state();
    if (last && last.status === next.status) return;
    last = next;
    for (const listener of listeners) listener(next);
  };

  return {
    state,

    subscribeLock(listener) {
      listeners.add(listener);
      last = state();
      listener(last);
      timer ??= setInterval(tick, 1_000);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },

    async reveal({ rowId, entity = DEFAULT_ENTITY, columns }) {
      let vault: { keyId: string; key: Uint8Array };
      try {
        vault = options.session.key();
      } catch (error) {
        // A locked session is an ANSWER, not an exception: the app renders
        // the shell's lock surface and the member unlocks there. The door
        // does not prompt, so it cannot be used to phish the passphrase.
        const code =
          error instanceof LockerUnlockError ? error.code : "unavailable";
        return refuse(
          code === "not_enrolled" ? "not_enrolled" : "locked",
          error instanceof Error ? error.message : String(error)
        );
      }

      const row = await options.readRow({
        rowId,
        entity,
        ...(columns ? { columns } : {}),
      });
      if (!row) return refuse("not_found", `no ${entity} row ${rowId}`);
      if (row.keyId !== null && row.keyId !== vault.keyId) {
        return refuse(
          "stale_key",
          `this secret is under a Locker key this device no longer holds — re-enter this secret`
        );
      }

      let values: Record<string, string>;
      try {
        // In parallel: WebCrypto's AES-GCM is independent per value and a row
        // has at most a handful of secret columns, so serialising them buys
        // nothing but latency on the one operation the member is waiting for.
        const opened = await Promise.all(
          Object.entries(row.values).map(async ([column, ciphertext]) => {
            const plaintext = await decryptLockerSecret(
              vault,
              { id: rowId, keyId: row.keyId },
              ciphertext
            );
            return [column, plaintext] as const;
          })
        );
        values = Object.fromEntries(opened);
      } catch (error) {
        if (error instanceof StaleLockerKeyError)
          return refuse("stale_key", error.message);
        throw error;
      }

      // THE RECEIPT BEFORE THE PLAINTEXT. `gateway.reveal` wrote its journal
      // row inside the transaction that produced the value; the boundary
      // moved but the ordering must not, or a reveal whose receipt failed
      // would be a reveal with no record — which is exactly the trail this
      // plane leaves behind when the gateway stops decrypting.
      const receipt = await options.recordReveal({
        rowId,
        entity,
        columns: Object.keys(values),
        keyId: vault.keyId,
      });

      // Deliberate use keeps the session alive; idle is what ends it.
      options.session.touch();
      return {
        ok: true,
        rowId,
        values,
        ...(receipt.receiptId ? { receiptId: receipt.receiptId } : {}),
      };
    },
  };
}
