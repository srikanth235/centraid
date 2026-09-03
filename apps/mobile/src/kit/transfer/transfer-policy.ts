import { Store } from "../../storage";

export const TRANSFER_POLICY_KEY = "photos.backupRules";

export interface TransferPolicy {
  wifiOnly: boolean;
  allowMetered: boolean;
  allowRoaming: boolean;
  chargerOnly: boolean;
  never: boolean;
}

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
  inertReason: (policy: TransferPolicy) => string | undefined;
  net?: true;
}

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
