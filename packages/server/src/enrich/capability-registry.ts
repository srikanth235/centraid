import { parseModelId } from "@centraid/vault";

import type { EnrichDomain } from "../automation/fire/enrich-gate.js";

export const CAPABILITY_INPUT_KINDS = [
  "image",
  "text",
  "document",
  "audio-video",
  "coordinate",
] as const;
export type CapabilityInputKind = (typeof CAPABILITY_INPUT_KINDS)[number];

export interface CapabilityContract {
  readonly id: string;
  readonly domain: EnrichDomain;
  readonly input: CapabilityInputKind;
  readonly outputSchema: string;
  readonly defaultTemplateId: string;
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

export function capabilityDefaultRef(contract: CapabilityContract): string {
  return `${contract.defaultTemplateId}/${contract.defaultTemplateId}`;
}

export function capabilityOutputVersion(
  contract: CapabilityContract
): number | null {
  return parseModelId(contract.outputSchema)?.version ?? null;
}
