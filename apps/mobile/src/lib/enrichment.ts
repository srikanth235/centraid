// Mobile's READ half of enrichment policy (#807): `enrich/effective`
// is vault-scoped (apiHeaders), `_enrich/profiles` uses the host bearer.
// Nothing here writes policy or folds a cascade of its own.

import {
  apiHeaders,
  authHeader,
  fetchJson,
  requireGatewayBase,
} from "./gateway";

export type EnrichDomain = "photos" | "docs";

export type EnrichTrigger = "on-ingest" | "on-view" | "on-demand";

export type EnrichEgressCeiling = "off" | "on-device" | "gateway" | "provider";

export type EnrichEgressClass = "on-device" | "gateway" | "provider";

export interface ResolvedEnrichPolicy {
  capability: string;
  enabled: boolean;
  profileId: string;
  trigger: EnrichTrigger;
  egressCeiling: EnrichEgressCeiling;
}

export interface EngineProfile {
  id: string;
  label: string;
  capability: string;
  egress: EnrichEgressClass;
  builtIn: boolean;
}

/** `effective: null` is fail-closed, never "off by default". */
export interface EnrichCapabilityState {
  domain: EnrichDomain;
  capability: string;
  effective: ResolvedEnrichPolicy | null;
  profile: EngineProfile | undefined;
}

export const MOBILE_ENRICH_CAPABILITIES: Readonly<
  Record<EnrichDomain, readonly string[]>
> = {
  photos: ["ocr", "faces", "embed-image", "transcript"],
  docs: ["embed-text", "doc-text", "doc-entities", "doc-filing", "obligations"],
};

export const MOBILE_ENRICH_DOMAINS: readonly EnrichDomain[] = [
  "photos",
  "docs",
];

function profileKey(capability: string, id: string): string {
  // A built-in id repeats across capabilities: identity is the PAIR.
  return `${capability}\n${id}`;
}

async function readEffective(
  base: string,
  domain: EnrichDomain,
  capability: string
): Promise<ResolvedEnrichPolicy | null> {
  const query = new URLSearchParams({ capability, domain });
  const body = await fetchJson<{ effective: ResolvedEnrichPolicy | null }>(
    `${base}/centraid/_vault/enrich/effective?${query.toString()}`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.effective ?? null;
}

async function readProfiles(base: string): Promise<EngineProfile[]> {
  const body = await fetchJson<{ profiles?: EngineProfile[] }>(
    `${base}/centraid/_enrich/profiles`,
    { headers: authHeader(), method: "GET" }
  );
  return body.profiles ?? [];
}

/** Throws when unreachable; callers may not invent a policy. */
export async function readEnrichmentPolicy(): Promise<EnrichCapabilityState[]> {
  const base = await requireGatewayBase();
  const asked = MOBILE_ENRICH_DOMAINS.flatMap((domain) =>
    MOBILE_ENRICH_CAPABILITIES[domain].map((capability) => ({
      capability,
      domain,
    }))
  );
  const [profiles, effectives] = await Promise.all([
    readProfiles(base),
    Promise.all(
      asked.map(({ capability, domain }) =>
        readEffective(base, domain, capability)
      )
    ),
  ]);
  const byKey = new Map(
    profiles.map((profile) => [
      profileKey(profile.capability, profile.id),
      profile,
    ])
  );
  return asked.map(({ capability, domain }, index) => {
    const effective = effectives[index] ?? null;
    return {
      capability,
      domain,
      effective,
      profile: effective
        ? byKey.get(profileKey(capability, effective.profileId))
        : undefined,
    };
  });
}
