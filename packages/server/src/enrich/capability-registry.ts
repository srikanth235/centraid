// The capability registry (issue #807): enrichment capabilities as versioned
// CONTRACTS rather than features.
//
// WHAT A CAPABILITY IS. A typed contract — input kind → output schema — and
// nothing about how it is computed or who asked. `ocr` says "an image yields
// text regions"; whether PP-OCRv4, a local VLM, or a provider harness produced
// them is an ENGINE fact, and which of those a member's scope prefers is a
// POLICY fact. Apps consume capabilities by contract only: a blueprint
// declares that it can use an output schema, never an implementation.
//
// WHY THE OUTPUT SCHEMA IS VERSIONED AND THE CAPABILITY ID IS NOT. The id is
// the thing manifests, policy rules, consent rows, and queue rows are keyed by
// (`automation.json`'s `enrich.capability`, `enrich_request.capability`,
// `enrich_policy_rule.capability`) — it must stay stable or every one of those
// keys breaks. What changes is the SHAPE of what the capability hands back,
// and that is exactly what `outputSchema` records, in the `<name>@<version>`
// convention `packages/vault/src/enrich/model-id.ts` already owns for model
// identity: one family name, one monotonic integer, parseable by the same
// helpers. A consumer written against `ocr@1` can therefore SAY so, and a
// version bump is a fact it can compare rather than a surprise it discovers.
//
// DEFAULT ENGINE, NOT ONLY ENGINE. `defaultTemplateId` names the bundled
// automation that implements the capability today — the app id under
// `packages/blueprints/automations`, whose automation ref is `<id>/<id>`. It
// is the built-in profile's implementation; Wave 1's engine profiles add
// others without touching this table.
//
// The domain stays the closed `photos | docs` union (issue #807 Q1): domains
// are DATA-SHAPE scopes, not app scopes. Tally receipts are documents and ride
// `docs`; per-app differentiation is what the policy cascade's app/collection
// scopes are for.

import { parseModelId } from "@centraid/vault";

import type { EnrichDomain } from "../automation/fire/enrich-gate.js";

/** What a capability consumes. Names a data shape, never a file format. */
export const CAPABILITY_INPUT_KINDS = [
  "image",
  "text",
  "document",
  "audio-video",
] as const;
export type CapabilityInputKind = (typeof CAPABILITY_INPUT_KINDS)[number];

/** One capability contract. */
export interface CapabilityContract {
  /** Stable key — manifests, policy rules, consent and queue rows use it. */
  readonly id: string;
  readonly domain: EnrichDomain;
  readonly input: CapabilityInputKind;
  /** `"<name>@<version>"`, parseable by `parseModelId` — see the header. */
  readonly outputSchema: string;
  /** Blueprint app id of the bundled automation implementing it today. */
  readonly defaultTemplateId: string;
}

/**
 * Every capability this build ships a contract for. Ordered photos-then-docs
 * to read as the two domains; the order carries no other meaning.
 */
export const ENRICH_CAPABILITIES: readonly CapabilityContract[] = [
  {
    id: "ocr",
    domain: "photos",
    input: "image",
    outputSchema: "ocr@1",
    defaultTemplateId: "photo-ocr",
  },
  {
    id: "faces",
    domain: "photos",
    input: "image",
    outputSchema: "faces@1",
    defaultTemplateId: "faces",
  },
  {
    id: "embed-image",
    domain: "photos",
    input: "image",
    outputSchema: "embed-image@1",
    defaultTemplateId: "embed-image",
  },
  {
    id: "transcript",
    domain: "photos",
    input: "audio-video",
    outputSchema: "transcript@1",
    defaultTemplateId: "transcript",
  },
  {
    id: "embed-text",
    domain: "docs",
    input: "text",
    outputSchema: "embed-text@1",
    defaultTemplateId: "embed-text",
  },
  {
    id: "doc-text",
    domain: "docs",
    input: "document",
    outputSchema: "doc-text@1",
    defaultTemplateId: "doc-text-extractor",
  },
  {
    id: "doc-entities",
    domain: "docs",
    input: "text",
    outputSchema: "doc-entities@1",
    defaultTemplateId: "doc-entity-linker",
  },
  {
    id: "doc-filing",
    domain: "docs",
    input: "text",
    outputSchema: "doc-filing@1",
    defaultTemplateId: "doc-filer",
  },
  {
    id: "obligations",
    domain: "docs",
    input: "text",
    outputSchema: "obligations@1",
    defaultTemplateId: "obligation-extractor",
  },
];

const BY_ID = new Map(ENRICH_CAPABILITIES.map((cap) => [cap.id, cap]));
const BY_TEMPLATE = new Map(
  ENRICH_CAPABILITIES.map((cap) => [cap.defaultTemplateId, cap])
);

/** Every registered capability id. */
export const ENRICH_CAPABILITY_IDS: readonly string[] = ENRICH_CAPABILITIES.map(
  (cap) => cap.id
);

/** The contract for an id, or `undefined` — an unknown id is never a default. */
export function capabilityContract(id: string): CapabilityContract | undefined {
  return BY_ID.get(id);
}

/** Whether an id names a capability this build carries a contract for. */
export function isEnrichCapability(id: string): boolean {
  return BY_ID.has(id);
}

/** Capabilities whose data shape belongs to one domain. */
export function capabilitiesForDomain(
  domain: EnrichDomain
): readonly CapabilityContract[] {
  return ENRICH_CAPABILITIES.filter((cap) => cap.domain === domain);
}

/** The capability a bundled automation implements by default, if any. */
export function capabilityForTemplateId(
  templateId: string
): CapabilityContract | undefined {
  return BY_TEMPLATE.get(templateId);
}

/**
 * The automation ref (`<appId>/<automationId>`) of the bundled implementation.
 * Bundled recognition automations use one id for both halves — the same
 * convention `system-recognition.ts` builds its refs from.
 */
export function capabilityDefaultRef(contract: CapabilityContract): string {
  return `${contract.defaultTemplateId}/${contract.defaultTemplateId}`;
}

/** The parsed output-schema version, e.g. `1` for `ocr@1`. */
export function capabilityOutputVersion(
  contract: CapabilityContract
): number | null {
  return parseModelId(contract.outputSchema)?.version ?? null;
}
