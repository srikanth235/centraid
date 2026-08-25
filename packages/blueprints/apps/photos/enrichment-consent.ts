/**
 * THE ENRICHMENT CONSENT MOMENT — one copy table, both clients (v4 §8).
 *
 * The only surface in Photos that tells a member their photographs can LEAVE
 * THE DEVICE. Web and native both read this module, so drift between them is
 * impossible by construction rather than by review.
 *
 * The strings are the handoff's VERBATIM, smart punctuation included, with two
 * settled amendments: "vault" → "library" (S6, docs/decisions.md — Photos mounts
 * over several scopes) and "you can revoke" → "the grant is revocable" (#805,
 * DESIGN.md bans "you can"). DO NOT "improve" them beyond those two: every fact
 * below is a promise about what the library will and will not do, and a
 * paraphrase is a different promise. Full sentences are correct here — the
 * budgets that compress the rest of Photos do not apply to a disclosure.
 *
 * Import-free but for the shared gate shape: native bundles this file straight
 * out of blueprints, so it must never reach for the web app's DOM/kit modules.
 *
 * WHAT THIS IS NOT: a settings toggle. An enrichment write fired from a single
 * tap — no panels, no facts, no choice — is the defect this module prevents. The
 * consent is asked ONCE, answered ONCE, and receipted.
 */

// Generic across every consent moment (#712), so they live in
// `apps/_shared/consent-gate.ts` and are re-exported here VERBATIM.
import type {
  AnswerAvailability as SharedAnswerAvailability,
  ConsentPanelCopy,
} from "../_shared/consent-gate.ts";

export type { ConsentFact, ConsentPanelCopy } from "../_shared/consent-gate.ts";

/** The frame's status line while this surface is up. */
export const ENRICHMENT_STATUS_LINE =
  "Face detection has never run on this library";

/** Where a shelf or route needs a name. */
export const ENRICHMENT_TITLE = "Enrichment";

/**
 * Grouped with an explicit `en-US` separator, never the ambient locale: the count
 * sits in an English sentence, and a CI box under `LANG=C` would print `6214`
 * where the handoff says `6,214`.
 */
export function onDeviceTitle(count: number): string {
  const photographs = count === 1 ? "photograph" : "photographs";
  return `Run face detection over ${count.toLocaleString("en-US")} ${photographs}?`;
}

/** Panel A — the device. Nothing leaves. */
export const ON_DEVICE_PANEL: ConsentPanelCopy = {
  eyebrow: "Consent",
  // The count-less form, for a surface not yet told the library's size.
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

/**
 * Panel B — THE DISCLOSURE PANEL, never conditional on a backend existing. It is
 * the single place the design says a downscaled copy of every photograph would
 * leave the device, so a build that hides it because the action is unwired has
 * removed the disclosure, not the feature. Unavailability is stated as a fact.
 */
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

/** The exact egress sentence Panel B exists to say. Exported so an edit that
 *  softens it fails in two suites at once. */
export const CLOUD_EGRESS_DISCLOSURE = "a downscaled copy of every photograph";

/** The note under both panels, verbatim. */
export const ENRICHMENT_NOTE =
  "This is not a settings toggle. It is asked once, answered once, and receipted — and the answer is visible in Privacy afterwards.";

/**
 * Why an answer cannot be given now. Each is a STATED FACT beside a visibly
 * unavailable action — never a hidden control, never a button firing into
 * nothing:
 *
 *  - `cloudUnavailable` — an app may not choose a named cloud helper: the tier
 *    is owner-only vault settings and no per-batch grant receipt exists yet.
 *  - `offTier` — enrichment is off, so a request would sit in the queue forever.
 *  - `modelTier` — the vault's enrichment already points at a remote model, so
 *    Panel A's "what leaves the device: nothing" is NOT true here. The device
 *    answer is withheld rather than printed beside a live button.
 *  - `denied` — Photos cannot read the policy, so it does not know what it
 *    would be consenting to.
 */
// The owner-only vault policy is the execution-time privacy gate; each
// capability's visible on/off control is its automation enabled bit.
export const ENRICHMENT_UNAVAILABLE = {
  deviceUnavailable:
    "Not available: this build has no device-side face detector. The Faces recognition recipe runs only on the gateway, which this vault’s device-only policy does not allow.",
  cloudUnavailable:
    "Not available from here: choose the Photo OCR recipe’s delegate step under Automations → Recognition, where its model, latency, and billing consequence are shown before a run.",
  offTier:
    "Not available: the vault’s enrichment policy refuses photograph recognition, so this request cannot run.",
  // KEY NAME KEPT AS `modelTier` because EnrichmentConsent.tsx reads it by that
  // name, though the tier is now `gateway` (#712 C5). `gateway` does not itself
  // mean "reaches a provider" — that egress is gated per call (#567) and per
  // capability (S9) — but the answer is withheld regardless: Panel A's "nothing
  // leaves the device" is not vouchable once the vault widens past `device`.
  modelTier:
    "Not available: this vault permits gateway recognition, so a run from here would not stay on this device the way the on-device answer promises. Review the recipe under Automations → Recognition.",
  denied:
    "Photos cannot read the vault’s enrichment policy, so it cannot tell you what a run would do. Recognition recipes are listed under Automations → Recognition.",
} as const;

/** Once the member has answered on this device. */
export const ENRICHMENT_REQUESTED_NOTE =
  "Face detection was requested. The request stays queued until the Faces recipe is enabled and the vault permits gateway recognition; queueing it does not mean recognition has run.";

/** The ANSWER was given and is binding; only its delivery waits — which is why
 *  this says the ask is HELD, not that anything is running. */
export const ENRICHMENT_QUEUED_NOTE =
  "Held on this device: the ask reaches the gateway when it reconnects, and nothing runs before it does.";

/** Declining writes nothing: it closes a question that may be asked again. */
export const ENRICHMENT_DECLINED_NOTE =
  "Nothing was run and nothing was written.";

/** Why an answer cannot be given, in words read BESIDE the control rather than
 *  discovered afterwards. Re-exported from the shared gate module. */
export type AnswerAvailability = SharedAnswerAvailability;

/**
 * Whether the member may answer "run it here", from the vault's standing
 * enrichment tier. Shared by both clients so neither decides alone that a run is
 * offerable. The tier is the OWNER's `off | device | gateway` setting (#712 C5)
 * — the envelope this consent lives inside, not the consent:
 *
 *   * `device` — the policy would permit a device producer, but this build has
 *     no device-side face detector, so the answer names that missing producer;
 *   * `gateway` — enrichment may reach a harness that takes a model turn, and
 *     every shipped harness routes that to a third party, so "nothing leaves the
 *     device" would be FALSE. Withheld with the reason named;
 *   * `off` — a request would sit in the queue forever;
 *   * denied / unread — the client cannot say what it would be consenting to.
 *
 * THE TIER IS ENFORCED server-side, at the one place enrichment automations fire
 * (`automation/fire/fire.ts` via `fire/enrich-gate.ts`), so `device` states a
 * fact rather than a hope. Nothing HERE enforces anything: withholding an answer
 * is still the right UI, but it is no longer the only thing between a `device`
 * vault and a provider.
 */
export function deviceAnswerFor(
  tier: string | null | undefined,
  denied?: boolean
): AnswerAvailability {
  if (denied)
    return { available: false, reason: ENRICHMENT_UNAVAILABLE.denied };
  // COMPAT(enrich-tier-rename #712): `local`/`model` are the pre-rename tier
  // strings. The raw mirror row can reach this module directly (queries read
  // `enrich.policy` straight), so both spellings must be accepted here.
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

/**
 * THERE IS NONE TO CHOOSE: nothing in the app plane can name a cloud helper or
 * mint a per-batch receipt for one — apps may only READ the tier mirror. The
 * answer is permanently unavailable, stated as a fact, and the panel with its
 * egress disclosure still renders, because the disclosure is the point.
 */
export const CLOUD_ANSWER: AnswerAvailability = {
  available: false,
  reason: ENRICHMENT_UNAVAILABLE.cloudUnavailable,
};
