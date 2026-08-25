// THE BACKUP CONSENT MOMENT — asked once per device, then automatic (#711).
//
// docs/decisions.md S4 and docs/blueprint-seats.md settle the model: backup is
// "consent-once, then automatic under a Wi-Fi/charging/roaming policy owned by
// the frame". The opposite — a member selecting photographs and holding a
// button, per photograph, forever — is not a stricter product, it is a LOSSIER
// one: the photographs a member forgets to
// select are the ones the `local-only` custody state exists to warn about, and
// no amount of tile marking rescues an original from a dropped phone.
//
// So the latch below is the whole safety property. Nothing auto-enqueues until
// it is `granted`; the manual per-item path keeps working either way, as the
// override the north star (Google Photos) also keeps. `automaticTransferAllowed`
// is the single predicate every automatic path must ask, and it is pure so a
// test can prove that removing it turns a red test green.
//
// PER DEVICE, deliberately. The question is "back up THIS DEVICE's
// photographs?" — a member with two phones has two answers, and syncing the
// latch through the vault would mean a new phone starts uploading its whole
// camera roll on the strength of an answer given on a different one.

import { Store } from "../../storage";
import {
  DEFAULT_TRANSFER_POLICY,
  describeTransferPolicy,
} from "./transfer-policy";

/** Member-device state, not vault state — see the header. */
export const BACKUP_CONSENT_KEY = "frame.backupConsent";

export type BackupConsentAnswer = "automatic" | "not-now";

export interface BackupConsentRecord {
  answer: BackupConsentAnswer;
  /** When it was answered. Shown back to the member; never used as a gate. */
  at: string;
}

/** Read the latch. `undefined` means the question has not been asked yet. */
export async function hydrateBackupConsent(): Promise<
  BackupConsentRecord | undefined
> {
  return Store.hydrate<BackupConsentRecord | undefined>(
    BACKUP_CONSENT_KEY,
    undefined
  );
}

/** Record an answer and hand it back, so a caller can hold it in state. */
export function answerBackupConsent(
  answer: BackupConsentAnswer
): BackupConsentRecord {
  const record: BackupConsentRecord = { answer, at: new Date().toISOString() };
  Store.set(BACKUP_CONSENT_KEY, record);
  return record;
}

/**
 * THE GATE. Every automatic enqueue passes through this and nothing else.
 *
 * An unanswered question is not a yes: `undefined` — the state of a device that
 * has never seen the panel — is refused exactly as `not-now` is. That is the
 * difference between "asked once" and "assumed once".
 */
export function automaticTransferAllowed(
  consent: BackupConsentRecord | undefined
): boolean {
  return consent?.answer === "automatic";
}

/**
 * What an automatic sweep is allowed to enqueue: nothing at all without the
 * latch, and otherwise exactly the items whose bytes are on this device and
 * nowhere else (`local-only`, the custody triple's first state — see
 * docs/blueprint-seats.md §Byte custody vocabulary).
 *
 * Generic over the item so the frame never has to learn what a photograph, a
 * scan or an attachment is; each app supplies the predicate that reads its own
 * custody field. Pure, and it is THE seam: deleting the consent check here has
 * to turn a test red, or the model is a comment rather than a guarantee.
 */
export function automaticTransferPlan<Item>(
  consent: BackupConsentRecord | undefined,
  items: readonly Item[],
  isLocalOnly: (item: Item) => boolean
): Item[] {
  if (!automaticTransferAllowed(consent)) return [];
  return items.filter(isLocalOnly);
}

// ── The copy ───────────────────────────────────────────────────────────────
//
// Same grammar as the enrichment consent moment
// (`packages/blueprints/apps/photos/enrichment-consent.ts`): an eyebrow, the
// question, one paragraph, a fact table, and the answers. The shape is
// restated here rather than imported because this is a FRAME moment about a
// device, not a Photos moment about a library — `kit/` may not depend on one
// app's blueprint for the words it says about every app's bytes.

/** One `label → value` line of the fact table, in the mono register. */
export interface ConsentFact {
  readonly label: string;
  readonly value: string;
  /** An egress claim: a 2px `net` rule on the leading edge. Never a fill. */
  readonly net?: boolean;
}

export interface ConsentPanelCopy {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly facts: readonly ConsentFact[];
  /** The filled answer — the one commit on the surface (§18). */
  readonly action: string;
  readonly action2: string;
}

/**
 * The panel. Built from the DEFAULTS rather than hard-coded prose, so a member
 * who has already tightened the policy is not told a comfortable fiction about
 * what is about to happen.
 */
export function backupConsentPanel(
  policy = DEFAULT_TRANSFER_POLICY
): ConsentPanelCopy {
  return {
    eyebrow: "Consent",
    title: "Back up this device's photographs?",
    body: "Centraid copies each photograph and video on this device to your gateway, then keeps doing it by itself. You are never asked per photograph, and the originals stay on the phone until you free up space yourself.",
    facts: [
      {
        label: "Where the bytes go",
        value:
          "Your gateway's content store. They leave this device over the network to get there.",
        net: true,
      },
      { label: "When", value: describeTransferPolicy(policy) },
      {
        label: "What stays here",
        value:
          "Every original. Backing up copies bytes; it never deletes them from the camera roll.",
      },
      {
        label: "How to stop",
        value:
          "Stop backing up, on this screen. Photographs already in the vault stay there.",
      },
    ],
    action: "Back up automatically",
    action2: "Not now",
  };
}

/** The status line while the latch is open — a fact, not a celebration. */
export const AUTOMATIC_BACKUP_ON = "Backing up this device automatically";

/** …and while it is shut. Says what the member is carrying, not a scolding. */
export const AUTOMATIC_BACKUP_OFF =
  "Not backing up — new photographs stay on this device.";

export const STOP_BACKING_UP_ACTION = "Stop backing up";

/** What stops and what stays — the revocation half of the consent moment. */
export const STOP_BACKING_UP_EXPLANATION =
  "New photographs stop being copied to the gateway. Everything already backed up stays in the vault, anything still queued finishes, and no original is deleted from this device.";
