/*
 * Enrichment vocabulary, client side. Keep it import-free, or the authenticated
 * transport lands in every render test. Every enum is a RESTATED mirror of the
 * vault's and the gate's; the route 400s the rest.
 */

export type EnrichTier = "off" | "device" | "gateway";

export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

export type EnrichPolicy = Record<EnrichDomain, EnrichTier>;

/** Order is the cascade order. */
export const ENRICH_SCOPE_TYPES = [
  "vault",
  "domain",
  "collection",
  "item",
] as const;
export type EnrichScopeType = (typeof ENRICH_SCOPE_TYPES)[number];

export const ENRICH_TRIGGERS = ["on-ingest", "on-view", "on-demand"] as const;
export type EnrichTrigger = (typeof ENRICH_TRIGGERS)[number];

/** `ref` is `''` at vault scope. */
export interface EnrichScope {
  type: EnrichScopeType;
  ref: string;
}

/** `null` means inherit. */
export interface EnrichPolicyRule {
  scope: EnrichScope;
  capability: string;
  enabled: boolean | null;
  profile: string | null;
  trigger: EnrichTrigger | null;
  updatedAt: string;
}

export type EnrichEgressCeiling = "off" | "on-device" | "gateway" | "provider";

export const ENRICH_EGRESS_CLASSES = [
  "on-device",
  "gateway",
  "provider",
] as const;
export type EnrichEgressClass = (typeof ENRICH_EGRESS_CLASSES)[number];

export interface EnrichConsentRecord {
  capability: string;
  egress: EnrichEgressClass;
  /** `''` covers the whole vault. */
  scopeRef: string;
  decision: "granted" | "declined";
  decidedAt: string;
  receiptId: string | null;
}

/** A report, never permission. */
export interface ResolvedEnrichPolicy {
  capability: string;
  enabled: boolean;
  profileId: string;
  trigger: EnrichTrigger;
  egressCeiling: EnrichEgressCeiling;
}

/** `harness` is gateway-supplied; never an enum here. */
export type EnrichEngine =
  | { kind: "built-in" }
  | {
      kind: "delegate";
      harness: string;
      model?: string;
      configPins?: Record<string, string>;
      promptRev?: string;
    };

/** `egress` is COMPUTED by the gateway: render it, never offer to set it. */
export interface EnrichEngineProfile {
  id: string;
  label: string;
  capability: string;
  engine: EnrichEngine;
  egress: EnrichEgressClass;
  builtIn: boolean;
  /** `false` means a delegate profile is legal but inert; Settings says so. */
  delegateCapable: boolean;
}

// Restated from the phone's Settings, not shared; the two must read alike.

export const ENRICH_DOMAIN_LABELS: Readonly<Record<EnrichDomain, string>> = {
  docs: "Documents",
  photos: "Photos",
};

export const ENRICH_CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "doc-entities": "Names, dates and amounts",
  "doc-filing": "Filing suggestions",
  "doc-text": "Text in documents",
  "embed-image": "Photo search",
  "embed-text": "Document search",
  faces: "Faces",
  obligations: "Dates and deadlines",
  ocr: "Text in photos",
  "place-names": "Place names",
  transcript: "Video and audio transcripts",
};

export function capabilityLabel(capability: string): string {
  return ENRICH_CAPABILITY_LABELS[capability] ?? capability;
}

export const ENRICH_CAPABILITY_BLURBS: Readonly<Record<string, string>> = {
  "doc-entities":
    "Picks out who and what a document is about, so it can be filed and found.",
  "doc-filing": "Suggests where a new document belongs.",
  "doc-text":
    "Pulls the words out of PDFs and scans so the rest of this list can work on them.",
  "embed-image":
    "Find photos by describing them, instead of by filename or date.",
  "embed-text": "Find documents by what they mean, not only by exact wording.",
  faces:
    "Groups photos of the same person, so everyone’s pictures come up at once.",
  obligations:
    "Spots renewal dates and deadlines so they can become reminders.",
  ocr: "Makes the words inside a picture searchable — receipts, signs, whiteboards.",
  "place-names":
    "Says which town a photograph was taken near, from a list bundled on this device.",
  transcript: "Writes out what is said in your videos and voice notes.",
};

// True because `DELEGATE_REFUSALS` refuses a delegate engine for faces.
export const ENRICH_CAPABILITY_NOTES: Readonly<Record<string, string>> = {
  faces: "Named only by you, and never sent to a provider.",
};

// A DISPLAY mirror of `enrich-resolve.ts`, never a second gate.
const EGRESS_RANK: Readonly<Record<EnrichEgressCeiling, number>> = {
  gateway: 2,
  off: 0,
  "on-device": 1,
  provider: 3,
};

export function egressWithinCeiling(
  egress: EnrichEgressClass,
  ceiling: EnrichEgressCeiling
): boolean {
  return EGRESS_RANK[egress] <= EGRESS_RANK[ceiling];
}

export const ENRICH_EGRESS_WORDS: Readonly<Record<EnrichEgressClass, string>> =
  {
    gateway: "on your gateway",
    "on-device": "on this device",
    provider: "sent to a provider",
  };

export const ENRICH_CEILING_WORDS: Readonly<
  Record<EnrichEgressCeiling, string>
> = {
  gateway: "no further than your gateway",
  off: "nothing runs",
  "on-device": "no further than this device",
  provider: "may be sent to a provider",
};

export const ENRICH_TRIGGER_WORDS: Readonly<Record<EnrichTrigger, string>> = {
  "on-demand": "when you ask",
  "on-ingest": "as items arrive",
  "on-view": "when you open an item",
};

export const ENRICH_CAPABILITY_DOMAIN: Readonly<Record<string, EnrichDomain>> =
  {
    "doc-entities": "docs",
    "doc-filing": "docs",
    "doc-text": "docs",
    "embed-image": "photos",
    "embed-text": "docs",
    faces: "photos",
    obligations: "docs",
    ocr: "photos",
    "place-names": "photos",
    transcript: "photos",
  };
