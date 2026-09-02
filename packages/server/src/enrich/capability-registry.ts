// Enrichment capabilities as versioned CONTRACTS: input kind to output schema,
// nothing about computation — apps declare a schema they consume, never an
// engine (#807).
//
// WHY THE SCHEMA IS VERSIONED AND THE ID IS NOT. Manifests, policy rules,
// consent and queue rows key on the id, so it must stay stable; the returned
// shape is what moves, recorded by `outputSchema` in the `<name>@<version>`
// convention `parseModelId` owns. `defaultTemplateId` is the bundled
// implementation, not the only one. Domains stay a closed union (#807): they
// scope DATA SHAPE, not apps — per-app differentiation is the policy cascade's job.

import { parseModelId } from "@centraid/vault";

import type { EnrichDomain } from "../automation/fire/enrich-gate.js";

/** A data shape, never a file format. */
export const CAPABILITY_INPUT_KINDS = [
  "image",
  "text",
  "document",
  "audio-video",
  // Its own shape (#816): no bytes read, no content item — a fact the vault already holds.
  "coordinate",
] as const;
export type CapabilityInputKind = (typeof CAPABILITY_INPUT_KINDS)[number];

export interface CapabilityContract {
  /** Stable key: manifests, policy rules, consent and queue rows use it. */
  readonly id: string;
  readonly domain: EnrichDomain;
  readonly input: CapabilityInputKind;
  /** `"<name>@<version>"`, parseable by `parseModelId`. */
  readonly outputSchema: string;
  /** Blueprint app id of the bundled implementation. */
  readonly defaultTemplateId: string;
  /** True iff the bundled manifest declares `enrich.delegateStep`. Binding a harness profile elsewhere is inert — surfaces must say so instead of letting the choice look live. Pinned by `enricher-templates.test.ts`. */
  readonly delegateCapable: boolean;
}

export const ENRICH_CAPABILITIES: readonly CapabilityContract[] = [
  {
    id: "ocr",
    domain: "photos",
    input: "image",
    outputSchema: "ocr@1",
    defaultTemplateId: "photo-ocr",
    delegateCapable: true,
  },
  {
    id: "faces",
    domain: "photos",
    input: "image",
    outputSchema: "faces@1",
    defaultTemplateId: "faces",
    delegateCapable: false,
  },
  {
    id: "embed-image",
    domain: "photos",
    input: "image",
    outputSchema: "embed-image@1",
    defaultTemplateId: "embed-image",
    delegateCapable: false,
  },
  {
    id: "transcript",
    domain: "photos",
    input: "audio-video",
    outputSchema: "transcript@1",
    defaultTemplateId: "transcript",
    delegateCapable: false,
  },
  {
    // `delegateCapable: false` is permanent, not "not yet" (#816): asking anyone
    // else where a coordinate is means telling them. The contract names no engine,
    // so a better local table still satisfies `place-names@1`.
    id: "place-names",
    domain: "photos",
    input: "coordinate",
    outputSchema: "place-names@1",
    defaultTemplateId: "place-names",
    delegateCapable: false,
  },
  {
    id: "embed-text",
    domain: "docs",
    input: "text",
    outputSchema: "embed-text@1",
    defaultTemplateId: "embed-text",
    delegateCapable: false,
  },
  {
    id: "doc-text",
    domain: "docs",
    input: "document",
    outputSchema: "doc-text@1",
    defaultTemplateId: "doc-text-extractor",
    delegateCapable: true,
  },
  {
    id: "doc-entities",
    domain: "docs",
    input: "text",
    outputSchema: "doc-entities@1",
    defaultTemplateId: "doc-entity-linker",
    delegateCapable: false,
  },
  {
    id: "doc-filing",
    domain: "docs",
    input: "text",
    outputSchema: "doc-filing@1",
    defaultTemplateId: "doc-filer",
    delegateCapable: false,
  },
  {
    id: "obligations",
    domain: "docs",
    input: "text",
    outputSchema: "obligations@1",
    defaultTemplateId: "obligation-extractor",
    delegateCapable: false,
  },
];

const BY_ID = new Map(ENRICH_CAPABILITIES.map((cap) => [cap.id, cap]));
const BY_TEMPLATE = new Map(
  ENRICH_CAPABILITIES.map((cap) => [cap.defaultTemplateId, cap])
);

export const ENRICH_CAPABILITY_IDS: readonly string[] = ENRICH_CAPABILITIES.map(
  (cap) => cap.id
);

/** An unknown id is never a default. */
export function capabilityContract(id: string): CapabilityContract | undefined {
  return BY_ID.get(id);
}

export function isEnrichCapability(id: string): boolean {
  return BY_ID.has(id);
}

export function capabilitiesForDomain(
  domain: EnrichDomain
): readonly CapabilityContract[] {
  return ENRICH_CAPABILITIES.filter((cap) => cap.domain === domain);
}

export function capabilityForTemplateId(
  templateId: string
): CapabilityContract | undefined {
  return BY_TEMPLATE.get(templateId);
}

/** Bundled recognition automations use one id for both halves of the ref. */
export function capabilityDefaultRef(contract: CapabilityContract): string {
  return `${contract.defaultTemplateId}/${contract.defaultTemplateId}`;
}

export function capabilityOutputVersion(
  contract: CapabilityContract
): number | null {
  return parseModelId(contract.outputSchema)?.version ?? null;
}
