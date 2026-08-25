// One transfer record for every byte-bearing app (#711); never copy it into an
// app or into the drain loop, which reaches up into `kit/`.

import { Store } from "../../storage";

/** Never rename: a tidier key migrates nothing and silently resets every
 * member's answer. */
export const TRANSFER_POLICY_KEY = "photos.backupRules";

export interface TransferPolicy {
  wifiOnly: boolean;
  allowMetered: boolean;
  allowRoaming: boolean;
  chargerOnly: boolean;
  /** The floor (#712): `canTransfer()` refuses before asking a radio. The
   * consent latch gates what is ENQUEUED; this gates draining at all. */
  never: boolean;
}

/** Defaults stay conservative: unasked cellular spend is a bill. */
export const DEFAULT_TRANSFER_POLICY: TransferPolicy = {
  wifiOnly: true,
  allowMetered: false,
  allowRoaming: false,
  chargerOnly: false,
  never: false,
};

export async function hydrateTransferPolicy(): Promise<TransferPolicy> {
  const stored = await Store.hydrate(
    TRANSFER_POLICY_KEY,
    DEFAULT_TRANSFER_POLICY
  );
  return { ...DEFAULT_TRANSFER_POLICY, ...stored };
}

export function writeTransferPolicy(next: TransferPolicy): void {
  Store.set(TRANSFER_POLICY_KEY, next);
}

export interface TransferPolicySwitch {
  key: keyof TransferPolicy;
  label: string;
  inert: (policy: TransferPolicy) => boolean;
  /** Required: an inapplicable rule is shown disabled and explained, never
   * hidden (§18); `lint-engine-conformance.mjs` gates the render. */
  inertReason: (policy: TransferPolicy) => string | undefined;
  /** `--net` ink, never a fill and never red (§18); only where ON stops it. */
  net?: true;
}

const NEVER_REASON =
  "“Never move bytes off this device” is on, so no transfer rule applies.";

/** Rendered in this order (§12); `never` last, as the floor. */
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
    inertReason: () => undefined,
    net: true,
  },
];

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
