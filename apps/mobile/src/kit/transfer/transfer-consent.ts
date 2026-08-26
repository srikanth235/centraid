// Consent asked once per device, then automatic (#711; decisions.md S4).
// `automaticTransferAllowed` is the single predicate every automatic enqueue
// must ask. Never sync the latch through the vault: a new phone would upload
// its whole camera roll on an answer given on a different one.

import { Store } from "../../storage";
import {
  DEFAULT_TRANSFER_POLICY,
  describeTransferPolicy,
} from "./transfer-policy";

export const BACKUP_CONSENT_KEY = "frame.backupConsent";

export type BackupConsentAnswer = "automatic" | "not-now";

export interface BackupConsentRecord {
  answer: BackupConsentAnswer;
  /** Never used as a gate. */
  at: string;
}

/** `undefined` = never asked. */
export async function hydrateBackupConsent(): Promise<
  BackupConsentRecord | undefined
> {
  return Store.hydrate<BackupConsentRecord | undefined>(
    BACKUP_CONSENT_KEY,
    undefined
  );
}

export function answerBackupConsent(
  answer: BackupConsentAnswer
): BackupConsentRecord {
  const record: BackupConsentRecord = { answer, at: new Date().toISOString() };
  Store.set(BACKUP_CONSENT_KEY, record);
  return record;
}

/** THE GATE. An unanswered question is not a yes: `undefined` is refused. */
export function automaticTransferAllowed(
  consent: BackupConsentRecord | undefined
): boolean {
  return consent?.answer === "automatic";
}

export function automaticTransferPlan<Item>(
  consent: BackupConsentRecord | undefined,
  items: readonly Item[],
  isLocalOnly: (item: Item) => boolean
): Item[] {
  if (!automaticTransferAllowed(consent)) return [];
  return items.filter(isLocalOnly);
}

// ── The copy ───────────────────────────────────────────────────────────────
// Restated, not imported: `kit/` may not depend on one app's blueprint.

export interface ConsentFact {
  readonly label: string;
  readonly value: string;
  /** Egress claim: a 2px leading-edge rule, never a fill. */
  readonly net?: boolean;
}

export interface ConsentPanelCopy {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly facts: readonly ConsentFact[];
  readonly action: string;
  readonly action2: string;
}

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

export const AUTOMATIC_BACKUP_ON = "Backing up this device automatically";

export const AUTOMATIC_BACKUP_OFF =
  "Not backing up — new photographs stay on this device.";

export const STOP_BACKING_UP_ACTION = "Stop backing up";

export const STOP_BACKING_UP_EXPLANATION =
  "New photographs stop being copied to the gateway. Everything already backed up stays in the vault, anything still queued finishes, and no original is deleted from this device.";
