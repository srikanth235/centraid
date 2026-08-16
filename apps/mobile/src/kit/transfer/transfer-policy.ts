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
// The switches now render on the FRAME's own Backup screen
// (`screens/BackupHealth.tsx`, issue #712 B2/P5) — the move
// docs/blueprint-seats.md's open follow-up asked for. Photos deep-links to it
// and renders none of them.

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
  /**
   * NEVER — the floor of the whole table (issue #712, P5). Every other switch
   * narrows WHEN this device may move bytes; this one says it may not, at all,
   * on any connection, charging or not.
   *
   * It is a real gate, not a label: `nativeUploadPolicy().canTransfer()`
   * refuses on it before it asks a radio anything, so a manual "Back up now"
   * and the automatic sweep both stop. It is deliberately SEPARATE from the
   * backup-consent latch (`transfer-consent.ts`), which answers a different
   * question — that latch decides whether photographs are enqueued
   * automatically; this decides whether the queue is allowed to drain at all,
   * for any app.
   */
  never: boolean;
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
  never: false,
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
  /**
   * WHY it is inert, in the member's words, or `undefined` when it is not.
   * REQUIRED, not optional: the comment above this interface has always
   * claimed an inert switch is "shown disabled and explained", and until
   * issue #712 E1 nothing on any surface actually said the second half —
   * four of the five switches went grey in silence. Making the reason part of
   * the switch's own shape means a sixth rule cannot be added without one.
   * `scripts/lint-engine-conformance.mjs` gates the rendering half.
   */
  inertReason: (policy: TransferPolicy) => string | undefined;
  /**
   * Drawn in `--net` — a 2px rule on the leading edge and `net` ink, never a
   * fill and never red (§18). Reserved for the switch whose ON state STOPS
   * this device moving bytes; everything else here only narrows when it may.
   */
  net?: true;
}

/**
 * The five, in this order, on every surface that renders them (handoff §12).
 * `never` is last because it is the floor, and it renders in `--net` because
 * turning it on is the one answer here that halts a transfer already in
 * flight rather than scheduling it differently.
 */
/**
 * The one sentence every inert switch starts from: the floor rule is on, so
 * nothing below it can matter. Named once because four of the five switches
 * say it, and a member who reads two different phrasings of the same fact on
 * one screen learns that the screen is not careful.
 */
const NEVER_REASON =
  "“Never move bytes off this device” is on, so no transfer rule applies.";

export const TRANSFER_POLICY_SWITCHES: readonly TransferPolicySwitch[] = [
  {
    key: "wifiOnly",
    label: "Wi-Fi only",
    inert: (policy) => policy.never,
    inertReason: (policy) => (policy.never ? NEVER_REASON : undefined),
  },
  {
    key: "allowMetered",
    label: "Allow metered or cellular",
    // Meaningless while Wi-Fi-only is on: the stricter rule already answered.
    inert: (policy) => policy.never || policy.wifiOnly,
    inertReason: (policy) =>
      policy.never
        ? NEVER_REASON
        : policy.wifiOnly
          ? "“Wi-Fi only” already answers this — turn it off to choose."
          : undefined,
  },
  {
    key: "allowRoaming",
    label: "Allow roaming or unknown cellular status",
    inert: (policy) => policy.never || policy.wifiOnly || !policy.allowMetered,
    inertReason: (policy) =>
      policy.never
        ? NEVER_REASON
        : policy.wifiOnly
          ? "“Wi-Fi only” already answers this — turn it off to choose."
          : policy.allowMetered
            ? undefined
            : "Metered and cellular transfers are off, so roaming cannot arise.",
  },
  {
    key: "chargerOnly",
    label: "Only while charging",
    inert: (policy) => policy.never,
    inertReason: (policy) => (policy.never ? NEVER_REASON : undefined),
  },
  {
    key: "never",
    label: "Never move bytes off this device",
    inert: () => false,
    // The floor rule is never inert: it is the switch that makes the others so.
    inertReason: () => undefined,
    net: true,
  },
];

/**
 * The policy stated as a sentence, for the consent moment and for any surface
 * that has to say what is about to happen without rendering four switches.
 * Present tense and specific — "on Wi-Fi" is a promise, "when possible" is not.
 */
export function describeTransferPolicy(policy: TransferPolicy): string {
  if (policy.never) return "Never — nothing leaves this device.";
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
