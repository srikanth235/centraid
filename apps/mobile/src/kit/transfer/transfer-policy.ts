// THE FRAME'S TRANSFER POLICY — one record, every byte-bearing app (#711, S4).
//
// This used to be `Rules` inside `apps/photos/BackupHealth.tsx`, with a second
// private copy of the same interface inside `lib/upload/native-policy.ts`. That
// was two owners for one member decision, and it was wrong the moment a second
// app wanted to move bytes: Google asks "back up this device?" ONCE per
// account, not once per app, and blueprint-seats.md §Shared engines settles the
// same shape for us — Docs' scans and Notes' attachments drain under this
// record, not under one of their own.
//
// The record lives in the frame (`kit/`) and is READ by the drain loop
// (`lib/upload/native-policy.ts`). That is the one place `lib/` reaches up into
// `kit/`, and it is deliberate: the policy is a member-device setting, not a
// property of the uploader. The import-boundary gate only forbids reaching into
// `src/apps/*`, which nothing here does — the whole point of this module is
// that it knows about no app at all.
//
// This screen's switches will eventually move to frame Settings; see the note
// at the head of `apps/photos/BackupHealth.tsx`.

import { Store } from "../../storage";

/**
 * The persisted key is the ORIGINAL Photos key, and it stays that way forever.
 *
 * It names a row that already exists on every member's device. Renaming it to
 * something tidier (`frame.transferPolicy`) would not migrate anything — it
 * would silently reset every member's answer back to the defaults and start
 * moving bytes under rules they never chose. The key is storage; the owner is
 * the frame; those are different facts.
 */
export const TRANSFER_POLICY_KEY = "photos.backupRules";

/** What the member decided about when this device may move bytes at all. */
export interface TransferPolicy {
  wifiOnly: boolean;
  allowMetered: boolean;
  allowRoaming: boolean;
  chargerOnly: boolean;
}

/**
 * Conservative by construction: Wi-Fi only, no metered, no roaming. A default
 * that spends a member's cellular allowance without being asked is a bill, not
 * a preference — and the consent moment states these defaults as facts before
 * anything is enqueued (`transfer-consent.ts`).
 */
export const DEFAULT_TRANSFER_POLICY: TransferPolicy = {
  wifiOnly: true,
  allowMetered: false,
  allowRoaming: false,
  chargerOnly: false,
};

/** Read from durable storage, filling any field a stored record predates. */
export async function hydrateTransferPolicy(): Promise<TransferPolicy> {
  const stored = await Store.hydrate(
    TRANSFER_POLICY_KEY,
    DEFAULT_TRANSFER_POLICY
  );
  return { ...DEFAULT_TRANSFER_POLICY, ...stored };
}

/** Persist the whole record. Callers edit a copy and hand it back entire. */
export function writeTransferPolicy(next: TransferPolicy): void {
  Store.set(TRANSFER_POLICY_KEY, next);
}

/**
 * One switch's copy, so the frame and any app that shows the policy read the
 * same words. `dependsOn` is the honest reason a switch is inert — a rule that
 * cannot apply is shown disabled and explained, never hidden (§18 refusal
 * grammar: a control the member cannot see cannot be reasoned about).
 */
export interface TransferPolicySwitch {
  key: keyof TransferPolicy;
  label: string;
  /** Inert while this predicate is true of the current record. */
  inert: (policy: TransferPolicy) => boolean;
}

export const TRANSFER_POLICY_SWITCHES: readonly TransferPolicySwitch[] = [
  { key: "wifiOnly", label: "Wi-Fi only", inert: () => false },
  {
    key: "allowMetered",
    label: "Allow metered or cellular",
    // Meaningless while Wi-Fi-only is on: the stricter rule already answered.
    inert: (policy) => policy.wifiOnly,
  },
  {
    key: "allowRoaming",
    label: "Allow roaming or unknown cellular status",
    inert: (policy) => policy.wifiOnly || !policy.allowMetered,
  },
  { key: "chargerOnly", label: "Only while charging", inert: () => false },
];

/**
 * The policy stated as a sentence, for the consent moment and for any surface
 * that has to say what is about to happen without rendering four switches.
 * Present tense and specific — "on Wi-Fi" is a promise, "when possible" is not.
 */
export function describeTransferPolicy(policy: TransferPolicy): string {
  const network = policy.wifiOnly
    ? "On Wi-Fi only"
    : policy.allowMetered
      ? policy.allowRoaming
        ? "On any connection, roaming included"
        : "On any connection, but not while roaming"
      : "On Wi-Fi and other unmetered connections";
  return policy.chargerOnly
    ? `${network}, and only while charging.`
    : `${network}, charging or not.`;
}
