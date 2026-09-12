/*
 * THE PHONE'S LOCKER DOOR (#996, rulings R13 and W6-D2).
 *
 * The same door the web and desktop shells put on `window.centraid.locker`,
 * built where the phone's shell already is. There is no bridge to cross here —
 * the RN app IS the shell — so the door is the two halves of commit 3 joined:
 * `K` behind `requireAuthentication` (`locker-device-auth.ts`) and the seat's
 * AES-GCM envelope (`@centraid/client`'s `decryptLockerSecret`).
 *
 * WHAT THIS REPLACES. The screens used to mint a permit against a passphrase
 * the app collected, spend it on a gateway read, and take plaintext off the
 * answer — three round trips and a credential in the app's hands. Now: the OS
 * asks the member to prove they are present, `K` comes out of the keychain,
 * and the value is decrypted here. It works with the radio off, which the
 * permit could never do, and the gateway never sees the secret.
 *
 * THE RECEIPT STILL GETS WRITTEN. That is the ordering W6-D2 names and it is
 * the one that must not slip: with the gateway no longer decrypting, the
 * reveal receipt is the ONLY record that anyone looked, so it is posted before
 * the plaintext is handed to a screen. Offline it queues as an intent like any
 * other device write — the reveal still happened, and the record catches up.
 */

import {
  decryptLockerSecret,
  StaleLockerKeyError,
} from "@centraid/client/locker";

import { lockerUnlocked, readLockerVaultKey } from "./locker-device-auth";
import { DEVICE_NOT_ENROLLED_BODY } from "./locker-seat-copy";

/** What a keychain read that threw means to a member: the lock held. The
 *  OSStatus behind it is a fact about the program (#1015, S14 — R-A-15). */
const STAYED_LOCKED = "Locker stayed locked.";

/** Why a reveal was refused. The screen renders the reason, never "failed". */
export type LockerRefusalReason =
  | "locked"
  | "not_enrolled"
  | "stale_key"
  | "not_found"
  | "unavailable";

export interface LockerRevealAnswerOk {
  readonly ok: true;
  readonly rowId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly receiptId?: string;
}

export interface LockerRevealAnswerRefused {
  readonly ok: false;
  readonly reason: LockerRefusalReason;
  readonly message: string;
}

export type LockerRevealAnswer =
  | LockerRevealAnswerOk
  | LockerRevealAnswerRefused;

export interface LockerRevealRequest {
  readonly vaultId: string;
  readonly rowId: string;
  readonly entity?: string;
  /** Column → ciphertext, as the seat's copy of the row holds it. */
  readonly ciphertext: Readonly<Record<string, string>>;
  /** The row's `key_id`, or null on a row that predates the key plane. */
  readonly keyId: string | null;
  /** Write the reveal receipt. Awaited BEFORE the plaintext is returned. */
  readonly recordReveal: (request: {
    rowId: string;
    entity: string;
    columns: readonly string[];
    keyId: string;
  }) => Promise<{ receiptId?: string }>;
}

function refuse(
  reason: LockerRefusalReason,
  message: string
): LockerRevealAnswerRefused {
  return { ok: false, reason, message };
}

/**
 * Ask the OS to prove the member is present, and warm the session.
 *
 * The unlock gesture, and the only one: there is no passphrase to submit, so
 * "unlock" IS the prompt. Separate from `revealLockerRow` rather than a reveal
 * of nothing, because a reveal writes a receipt and this opens no secret —
 * conflating them would put a row in the audit trail saying someone looked at
 * something when nobody did.
 */
export async function unlockLockerDoor(
  vaultId: string
): Promise<{ ok: true } | LockerRevealAnswerRefused> {
  try {
    const record = await readLockerVaultKey(vaultId);
    if (!record) {
      // NOT A RETRY (#1015 B1): nothing writes `K` to this keychain today, so
      // "yet" was the whole of the lie — pressing again could not change it.
      return refuse("not_enrolled", DEVICE_NOT_ENROLLED_BODY);
    }
    return { ok: true };
  } catch (error) {
    // A cancelled Face ID prompt lands here, and it is a lock, not a fault —
    // and what the keychain throws when it is cancelled is an OSStatus, not a
    // sentence (S14, #1015, R-A-15). The raw goes to the log.
    console.warn("[locker] vault key unreadable", error);
    return refuse("locked", STAYED_LOCKED);
  }
}

/** Is a reveal free of an OS prompt right now? What the lock indicator reads. */
export function lockerDoorUnlocked(now: number = Date.now()): boolean {
  return lockerUnlocked(now);
}

/**
 * Reveal one row. Prompts the OS unless a live session already holds `K` —
 * which is the one place this differs from the browser door, and deliberately:
 * on the phone the prompt IS the unlock surface, so asking for it here is
 * asking the member to unlock rather than collecting anything from them.
 */
export async function revealLockerRow(
  request: LockerRevealRequest
): Promise<LockerRevealAnswer> {
  let record: { keyId: string; key: string } | null;
  try {
    record = await readLockerVaultKey(request.vaultId);
  } catch (error) {
    console.warn("[locker] vault key unreadable", error);
    return refuse("locked", STAYED_LOCKED);
  }
  if (!record) {
    return refuse("not_enrolled", DEVICE_NOT_ENROLLED_BODY);
  }
  if (request.keyId !== null && request.keyId !== record.keyId) {
    return refuse(
      "stale_key",
      "This secret is under a Locker key this device no longer holds — re-enter this secret."
    );
  }
  const entity = request.entity ?? "locker.item";
  const key = Uint8Array.from(Buffer.from(record.key, "base64"));
  const vault = { keyId: record.keyId, key };

  let values: Record<string, string>;
  try {
    const opened = await Promise.all(
      Object.entries(request.ciphertext).map(async ([column, ciphertext]) => {
        const plaintext = await decryptLockerSecret(
          vault,
          { id: request.rowId, keyId: request.keyId },
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

  const receipt = await request.recordReveal({
    rowId: request.rowId,
    entity,
    columns: Object.keys(values),
    keyId: record.keyId,
  });
  return {
    ok: true,
    rowId: request.rowId,
    values,
    ...(receipt.receiptId ? { receiptId: receipt.receiptId } : {}),
  };
}
