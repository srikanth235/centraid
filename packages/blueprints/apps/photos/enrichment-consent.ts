import type {
  AnswerAvailability as SharedAnswerAvailability,
  ConsentPanelCopy,
} from "../_shared/consent-gate.ts";

export type { ConsentFact, ConsentPanelCopy } from "../_shared/consent-gate.ts";

export const ENRICHMENT_STATUS_LINE =
  "Face detection has never run on this library";

export const ENRICHMENT_TITLE = "Enrichment";

export function onDeviceTitle(count: number): string {
  const photographs = count === 1 ? "photograph" : "photographs";
  return `Run face detection over ${count.toLocaleString("en-US")} ${photographs}?`;
}

export const ON_DEVICE_PANEL: ConsentPanelCopy = {
  eyebrow: "Consent",
  title: "Run face detection over these photographs?",
  body: "Face detection finds faces and groups them. It writes a new column into your library; it never changes a photograph. You will be asked to name each group yourself.",
  facts: [
    { label: "where it would run", value: "on this device" },
    { label: "what leaves the device", value: "nothing" },
    { label: "how long", value: "about 40 minutes, resumable" },
    { label: "what it writes", value: "a faces column in your library" },
    {
      label: "undo",
      value: "delete the faces column; photographs are untouched",
    },
  ],
  action: "Run on this device",
  action2: "Not now",
  filled: true,
};

export const CLOUD_PANEL: ConsentPanelCopy = {
  eyebrow: "The other option",
  net: true,
  title: "Run on the gateway’s cloud helper",
  body: "Faster, and the photographs leave this device. Choosing it is a separate consent with its own receipt, and the grant is revocable afterwards.",
  facts: [
    { label: "where it would run", value: "a cloud helper you have named" },
    {
      label: "what leaves the device",
      value: "a downscaled copy of every photograph",
      net: true,
    },
    { label: "how long", value: "about 6 minutes" },
    { label: "receipt", value: "one per batch, in the grants ledger" },
  ],
  action: "Choose the cloud helper",
  dangerous: true,
};

export const CLOUD_EGRESS_DISCLOSURE = "a downscaled copy of every photograph";

export const ENRICHMENT_NOTE =
  "This is not a settings toggle. It is asked once, answered once, and receipted — and the answer is visible in Privacy afterwards.";

export const ENRICHMENT_UNAVAILABLE = {
  deviceUnavailable:
    "Not available: this build has no device-side face detector. The Faces recognition recipe runs only on the gateway, which this vault’s device-only policy does not allow.",
  cloudUnavailable:
    "Not available from here: choose the Photo OCR recipe’s delegate step under Automations → Recognition, where its model, latency, and billing consequence are shown before a run.",
  offTier:
    "Not available: the vault’s enrichment policy refuses photograph recognition, so this request cannot run.",
  modelTier:
    "Not available: this vault permits gateway recognition, so a run from here would not stay on this device the way the on-device answer promises. Review the recipe under Automations → Recognition.",
  denied:
    "Photos cannot read the vault’s enrichment policy, so it cannot tell you what a run would do. Recognition recipes are listed under Automations → Recognition.",
} as const;

export const ENRICHMENT_REQUESTED_NOTE =
  "Face detection was requested. The request stays queued until the Faces recipe is enabled and the vault permits gateway recognition; queueing it does not mean recognition has run.";

export const ENRICHMENT_QUEUED_NOTE =
  "Held on this device: the ask reaches the gateway when it reconnects, and nothing runs before it does.";

export const ENRICHMENT_DECLINED_NOTE =
  "Nothing was run and nothing was written.";

export type AnswerAvailability = SharedAnswerAvailability;

export function deviceAnswerFor(
  tier: string | null | undefined,
  denied?: boolean
): AnswerAvailability {
  if (denied)
    return { available: false, reason: ENRICHMENT_UNAVAILABLE.denied };
  if (tier === "device" || tier === "local")
    return {
      available: false,
      reason: ENRICHMENT_UNAVAILABLE.deviceUnavailable,
    };
  if (tier === "gateway" || tier === "model")
    return { available: false, reason: ENRICHMENT_UNAVAILABLE.modelTier };
  if (tier == null) return { available: false };
  return { available: false, reason: ENRICHMENT_UNAVAILABLE.offTier };
}

export const CLOUD_ANSWER: AnswerAvailability = {
  available: false,
  reason: ENRICHMENT_UNAVAILABLE.cloudUnavailable,
};
