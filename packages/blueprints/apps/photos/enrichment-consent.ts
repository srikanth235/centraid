/**
 * THE ENRICHMENT CONSENT MOMENT — one copy table, both clients (v4 handoff
 * §8, prototype `s==='enrich'`, README §12).
 *
 * This is the only surface in Photos where the product tells a member that
 * their photographs can LEAVE THE DEVICE. That sentence is the reason the
 * screen exists, so its words are not a component's business: web
 * (`enrichment-gate.ts`, mounted in the People shelf's empty state per issue
 * #712 C2) and native (`apps/mobile/src/apps/photos/EnrichmentConsent.tsx`)
 * both read this module, and a drift between them is impossible by
 * construction rather than by review.
 *
 * The strings are the handoff's, VERBATIM, smart punctuation included, with
 * one settled amendment (S6, docs/decisions.md): the handoff's storage noun
 * "vault" is replaced with "library" — the scope's human label — because
 * Photos mounts over several scopes and "this vault" stops being unambiguous
 * the moment a household exists (#599 vocabulary gate). Do not "improve" the
 * strings beyond that swap: every fact below is a promise about what the
 * library will and will not do, and a paraphrase is a different promise.
 *
 * Deliberately import-free but for the shared gate shape below. Native
 * bundles this file straight out of the blueprints package (the same way
 * `apps/notes/commonmark.ts` is bundled), so it must not reach for the web
 * app's DOM/kit modules or its own tokens.
 *
 * WHAT THIS IS NOT (handoff line 4332, and the defect that made this module
 * necessary): a settings toggle. Both clients previously fired the enrichment
 * write from a single tap on a row/button — no panels, no facts, no choice
 * between the device and a cloud helper. The consent is asked ONCE, answered
 * ONCE, and receipted; the answer is visible in Privacy afterwards.
 */

// The gate's shapes are generic across every consent moment in the product
// (issue #712 C1) — Docs' capture-time OCR is the second instance — so they
// live in `apps/_shared/consent-gate.ts` and are re-exported here VERBATIM
// for every existing importer of this module.
import type {
  AnswerAvailability as SharedAnswerAvailability,
  ConsentPanelCopy,
} from "../_shared/consent-gate.ts";

export type { ConsentFact, ConsentPanelCopy } from "../_shared/consent-gate.ts";

/** The frame's status line while this surface is up (prototype cfg 3968). */
export const ENRICHMENT_STATUS_LINE =
  "Face detection has never run on this library";

/** What the surface calls itself where a shelf/route needs a name. */
export const ENRICHMENT_TITLE = "Enrichment";

/**
 * The on-device panel's question, over the live library count.
 *
 * Grouped with an explicit `en-US` separator rather than the ambient locale:
 * the count is part of a sentence whose other words are English, and a CI box
 * running under `LANG=C` would otherwise print `6214` where the handoff — and
 * every screenshot of it — says `6,214`.
 */
export function onDeviceTitle(count: number): string {
  const photographs = count === 1 ? "photograph" : "photographs";
  return `Run face detection over ${count.toLocaleString("en-US")} ${photographs}?`;
}

/** Panel A — the device. Nothing leaves. */
export const ON_DEVICE_PANEL: ConsentPanelCopy = {
  eyebrow: "Consent",
  // The live title is `onDeviceTitle(count)`; this is the count-less form for
  // a surface that has not yet been told how big the library is.
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
 * Panel B — the cloud helper. THE DISCLOSURE PANEL.
 *
 * This panel is never conditional on a backend existing. It is the single
 * place the design tells a member that a downscaled copy of every photograph
 * would leave the device, and a build that hides it because the action is not
 * wired has removed the disclosure, not the feature. When the action cannot
 * be taken, its unavailability is stated as a fact (`CLOUD_UNAVAILABLE`) —
 * the panel still says what the option would cost.
 */
export const CLOUD_PANEL: ConsentPanelCopy = {
  eyebrow: "The other option",
  net: true,
  title: "Run on the gateway’s cloud helper",
  body: "Faster, and the photographs leave this device. Choosing it is a separate consent with its own receipt, and you can revoke the grant afterwards.",
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

/** The exact egress sentence Panel B exists to say. Exported so both clients'
 *  tests can pin it without re-typing it, and so a future edit that softens it
 *  fails in two suites at once. */
export const CLOUD_EGRESS_DISCLOSURE = "a downscaled copy of every photograph";

/** The note under both panels (handoff line 4332), verbatim. */
export const ENRICHMENT_NOTE =
  "This is not a settings toggle. It is asked once, answered once, and receipted — and the answer is visible in Privacy afterwards.";

/**
 * Why an answer cannot be given right now. Each is a STATED FACT beside a
 * visibly unavailable action, never a hidden control and never a button that
 * fires into nothing:
 *
 *  - `cloudUnavailable` — the honest state of this repo. Choosing a named
 *    cloud helper is not something an app may do: the enrichment tier lives
 *    in the vault's owner-only settings bag (`core_vault.settings_json.enrich`,
 *    PATCH /centraid/_vault/enrich), and no per-batch grant receipt for a
 *    named helper exists yet. The panel still states the egress.
 *  - `offTier` — the owner has enrichment switched off for the photos domain
 *    (`enrich.policy.tier = 'off'`), so a request would sit in the queue
 *    forever. Saying so beats a request that silently never runs.
 *  - `modelTier` — the owner has already pointed this vault's enrichment at a
 *    remote model, which means the on-device promise above ("what leaves the
 *    device: nothing") is NOT true for this vault right now. Rather than
 *    print a false fact beside a live button, the device answer is withheld
 *    and the reason is named.
 *  - `denied` — Photos cannot even read the policy, so it does not know what
 *    it would be consenting to.
 */
// Recognition is controlled by the built-in recipes in Automations. The
// owner-only vault policy remains the execution-time privacy gate, while each
// capability's visible on/off control is its automation enabled bit.
export const ENRICHMENT_UNAVAILABLE = {
  deviceUnavailable:
    "Not available: this build has no device-side face detector. The Faces recognition recipe runs only on the gateway, which this vault’s device-only policy does not allow.",
  cloudUnavailable:
    "Not available from here: choose the Photo OCR recipe’s agent variant under Automations → Recognition, where its model, latency, and billing consequence are shown before a run.",
  offTier:
    "Not available: the vault’s enrichment policy refuses photograph recognition, so this request cannot run.",
  // KEY NAME KEPT AS `modelTier` for both clients' sake (EnrichmentConsent.tsx
  // reads it by this name) even though the tier it now describes is named
  // `gateway` (issue #712 C5, renamed from `model`) — the CONTENT below is
  // what changed. `gateway` does not by itself mean "reaches a provider": it
  // means the vault's own gateway may do whatever it is already wired to,
  // which for a capability that needs a model turn is a provider egress
  // gated separately per call (#567) and per capability (decision S9). This
  // answer is withheld regardless, because the specific promise Panel A
  // states — "what leaves the device: nothing" — is not one this module can
  // vouch for once the vault has widened past `device`.
  modelTier:
    "Not available: this vault permits gateway recognition, so a run from here would not stay on this device the way the on-device answer promises. Review the recipe under Automations → Recognition.",
  denied:
    "Photos cannot read the vault’s enrichment policy, so it cannot tell you what a run would do. Recognition recipes are listed under Automations → Recognition.",
} as const;

/** What the status line says once the member has answered on this device. */
export const ENRICHMENT_REQUESTED_NOTE =
  "Face detection was requested. The request stays queued until the Faces recipe is enabled and the vault permits gateway recognition; queueing it does not mean recognition has run.";

/** What an offline client says when the ask could not reach the gateway yet.
 *  The ANSWER was still given and is still binding — only its delivery is
 *  waiting, which is why this says the ask is held rather than that anything
 *  is already running. */
export const ENRICHMENT_QUEUED_NOTE =
  "Held on this device: the ask reaches the gateway when it reconnects, and nothing runs before it does.";

/** What the surface says when the member declines. Declining writes nothing —
 *  it closes the question, and the question can be asked again. */
export const ENRICHMENT_DECLINED_NOTE =
  "Nothing was run and nothing was written.";

/** Whether an answer can be given, and — when it cannot — WHY, in words the
 *  member reads beside the control rather than discovering afterwards.
 *  Re-exported from the shared gate module — see the header. */
export type AnswerAvailability = SharedAnswerAvailability;

/**
 * Whether the member may answer "run it here", from the vault's standing
 * enrichment tier. Shared by both clients so neither can decide on its own
 * that a run is offerable.
 *
 * The tier is the OWNER's setting, mirrored into `enrich.policy`
 * (packages/vault/src/schema/enrich.ts), on the `off | device | gateway`
 * axis (issue #712 C5, renamed from `off | local | model`). It is not this
 * consent — it is the envelope this consent lives inside:
 *
 *   * `device` — the policy would permit a device producer, but this build
 *     has no device-side face detector, so the answer is withheld and names
 *     that missing producer;
 *   * `gateway` — this vault's enrichment may reach a runner that takes a
 *     model turn, and every runner shipped today routes that turn to a
 *     third-party provider, so `what leaves the device → nothing` would be
 *     FALSE. The answer is withheld with that reason named, rather than
 *     printed beside a live button;
 *   * `off` — a request would sit in the queue forever;
 *   * denied / not yet read — the client cannot say what it would be
 *     consenting to, so it offers nothing.
 *
 * THE TIER IS NOW ENFORCED, so `device` above states a fact rather than a
 * hope. It used to be written by Settings and read by nobody on the
 * execution path: enrichment automations fired and took model turns
 * whatever the tier said, which is why this module could only ever hedge.
 * The gate is server-side, at the one place enrichment automations are
 * fired (`packages/automation/src/fire/fire.ts`, deciding through
 * `fire/enrich-gate.ts` on the vault tier read by
 * `packages/vault/src/enrich/policy.ts`): `off` refuses the run, `device`
 * refuses any run that would need the `gateway` lane — and seals `ctx.agent`
 * shut for the ones it does allow — and an unreadable policy refuses too.
 * Nothing here enforces anything; withholding an answer is still the right
 * UI, but it is no longer the only thing standing between a `device` vault
 * and a provider.
 */
export function deviceAnswerFor(
  tier: string | null | undefined,
  denied?: boolean
): AnswerAvailability {
  if (denied)
    return { available: false, reason: ENRICHMENT_UNAVAILABLE.denied };
  // COMPAT(enrich-tier-rename #712): `local`/`model` are the pre-rename tier
  // strings. `packages/vault/src/enrich/policy.ts`'s own read maps them the
  // same way, but the raw mirror row can also reach this module directly
  // (`queries/enrichment-status.ts` reads `enrich.policy` straight, not
  // through that helper), so this comparison accepts both spellings rather
  // than assume every caller normalized first.
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
 * The cloud helper, on this repo's actual backend: THERE IS NONE TO CHOOSE.
 *
 * Nothing in the app plane can name a cloud helper or mint a per-batch
 * receipt for one. The enrichment tier lives in the vault's owner-only
 * settings bag (GET/PATCH `/centraid/_vault/enrich`); apps may only READ its
 * mirror, and the enricher automations decide for themselves where their
 * model call goes. So this answer is permanently unavailable from an app, and
 * that is a STATED FACT — the panel and its egress disclosure still render,
 * because the disclosure is the point.
 */
export const CLOUD_ANSWER: AnswerAvailability = {
  available: false,
  reason: ENRICHMENT_UNAVAILABLE.cloudUnavailable,
};
