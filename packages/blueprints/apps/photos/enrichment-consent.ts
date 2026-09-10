/**
 * PHOTOS' ENRICHMENT COPY TABLE — one module, both clients.
 *
 * Recognition is on by default and ambient: every bundled recipe, faces
 * included, runs on ingest (ruled 2026-09-09, docs/decisions.md). Photos has
 * NO consent moment in front of face detection, so no string here may read as
 * though answering something lets faces run. The controls that do decide are
 * named in the copy: the recipe's switch under Automations → Recognition, and
 * the `enrich_policy` tier, whose `off` stops every run.
 *
 * What is left is the People shelf's EMPTY STATE — signage plus one action
 * that moves this library to the front of the `enrich.request` queue, so its
 * copy says SOONER and never WHETHER — and the PROVIDER-EGRESS DISCLOSURE,
 * the one class the standing tier does not answer for. No Photos surface can
 * offer that choice today; the copy stays pinned here so a future chooser
 * cannot re-derive it softer.
 *
 * Import-free but for the shared gate shape: native bundles this file straight
 * out of blueprints, so it must never reach the web app's DOM/kit modules.
 */

// Generic across every consent moment (#712), so they live in
// `apps/_shared/consent-gate.ts` and are re-exported here VERBATIM.
import type {
  AnswerAvailability as SharedAnswerAvailability,
  ConsentPanelCopy,
} from "../_shared/consent-gate.ts";

export type { ConsentFact, ConsentPanelCopy } from "../_shared/consent-gate.ts";

/** The empty roster's status line. It says what THIS SHELF shows and no more:
 *  no client reads a "has recognition ever run" fact, and the ingest pass may
 *  have grouped a face that has not replicated here yet. */
export const ENRICHMENT_STATUS_LINE = "No faces have been grouped here yet";

/** The empty state's one sentence: who groups, when, and where the switch is. */
export const PEOPLE_EMPTY_LINE =
  "The Faces recipe groups faces on the gateway as photographs arrive; switch it under Automations → Recognition.";

/** A plain action, not a question: pressing it writes a manual
 *  `enrich.request`; not pressing it withholds nothing. */
export const PRIORITISE_ACTION = "Prioritise faces";

/** SOONER, never WHETHER: the ambient pass reaches this library regardless. */
export const ENRICHMENT_PRIORITISED_NOTE =
  "Faces prioritised — this library runs sooner";

/** The request is durable but undelivered; only its delivery waits. */
export const ENRICHMENT_QUEUED_NOTE =
  "Held on this device — the priority ask reaches the gateway when it reconnects";

/** THE DISCLOSURE PANEL, never conditional on a backend existing: the single
 *  place the design says a downscaled copy of every photograph would leave the
 *  device. Softening it removes the disclosure, not the feature. */
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

/** The exact egress sentence the panel exists to say. */
export const CLOUD_EGRESS_DISCLOSURE = "a downscaled copy of every photograph";

/**
 * Why an action cannot be taken: a STATED FACT beside a visibly unavailable
 * control, never a hidden control and never a button firing into nothing. Only
 * `off` withholds a RUN, so only its reason may say so.
 */
export const ENRICHMENT_UNAVAILABLE = {
  /** `off` is the real stop: no face run happens, so none can be moved up. */
  offTier:
    "Not available: the vault’s enrichment policy is off for photographs, so no face run happens to prioritise.",
  /** `device` permits the device lane only; Faces declares `lane: "gateway"`,
   *  so `decideEnrichmentGate` refuses it on rank. */
  deviceTier:
    "Not available: the enrichment policy keeps recognition on this device, and the Faces recipe runs on the gateway.",
  denied:
    "Photos cannot read the vault’s enrichment policy, so it cannot say when faces run.",
  cloudUnavailable:
    "Not available from here: choose the Photo OCR recipe’s delegate step under Automations → Recognition, where its model, latency, and billing consequence are shown before a run.",
} as const;

/** Read BESIDE the control, never after. Shared shape. */
export type AnswerAvailability = SharedAnswerAvailability;

/**
 * Whether the priority ask is offerable, from the standing tier
 * (`off | device | gateway`, #712 C5). It gates ONE thing — whether a manual
 * `enrich.request` would ever be drained — and never whether faces run.
 * `gateway` fits the recipe's lane; `device` declares a lane no recipe has;
 * `off` runs nothing to move forward; unread/denied cannot say.
 *
 * THE TIER IS ENFORCED server-side (`automation/fire/fire.ts` via
 * `fire/enrich-gate.ts`). Withholding an unusable action is UI, not the gate.
 */
export function prioritiseAnswerFor(
  tier: string | null | undefined,
  denied?: boolean
): AnswerAvailability {
  if (denied)
    return { available: false, reason: ENRICHMENT_UNAVAILABLE.denied };
  if (tier === "device")
    return { available: false, reason: ENRICHMENT_UNAVAILABLE.deviceTier };
  if (tier === "gateway") return { available: true };
  if (tier == null) return { available: false };
  return { available: false, reason: ENRICHMENT_UNAVAILABLE.offTier };
}

/** THERE IS NO CLOUD HELPER TO CHOOSE: apps may only READ the tier mirror.
 *  Stated as a fact, so a surface rendering `CLOUD_PANEL` keeps the disclosure
 *  behind an honest inert action rather than dropping the panel. */
export const CLOUD_ANSWER: AnswerAvailability = {
  available: false,
  reason: ENRICHMENT_UNAVAILABLE.cloudUnavailable,
};
