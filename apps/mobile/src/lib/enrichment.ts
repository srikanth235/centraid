// Mobile enrichment-policy client — the READ half of the phone's view of the
// effective enrichment policy (#807).
//
//   GET /centraid/_vault/enrich/effective?domain=&capability=  → the one
//       resolver's fold for that capability, vault-SCOPED (apiHeaders).
//   GET /centraid/_enrich/profiles                             → the engine
//       profiles, which are gateway prefs rather than vault state, so this one
//       carries the host bearer alone (authHeader), like the health read in
//       lib/insights.ts.
//
// READ ONLY, BY DECISION. The phone reports what the gateway would resolve; it
// writes no rule, no tier, and no profile. Editing enrichment policy is a
// desktop act in this wave, and a phone control that wrote a rule the member
// could not see the cascade for would be worse than no control.
//
// The effective answer is asked PER CAPABILITY because that is the shape the
// gateway's single resolver answers in. Nothing here folds a cascade of its
// own: a second policy path on the phone is exactly what #807 is arranged to
// prevent, so an unreachable gateway yields an unavailable state rather than a
// locally reconstructed one.
//
// Mobile does not depend on the gateway or client packages, so the wire shapes
// are mirrored as lean local interfaces — the convention lib/gateway.ts,
// lib/connections.ts and lib/insights.ts already follow. Sources of truth:
// packages/server/src/routes/vault-enrich-rules-routes.ts,
// packages/server/src/automation/fire/enrich-resolve.ts and
// packages/server/src/enrich/{capability-registry,engine-profiles}.ts.

import {
  apiHeaders,
  authHeader,
  fetchJson,
  requireGatewayBase,
} from "./gateway";

/** The data-shape domains policy is authored per (closed, per #807). */
export type EnrichDomain = "photos" | "docs";

/** When a capability's work is offered at a scope. */
export type EnrichTrigger = "on-ingest" | "on-view" | "on-demand";

/** How far work may go. `off` exists only as a ceiling, never as a class. */
export type EnrichEgressCeiling = "off" | "on-device" | "gateway" | "provider";

/** The computed class of an engine — where its work actually goes. */
export type EnrichEgressClass = "on-device" | "gateway" | "provider";

/** What the gateway's ONE resolver folds the cascade into, for one capability. */
export interface ResolvedEnrichPolicy {
  capability: string;
  enabled: boolean;
  profileId: string;
  trigger: EnrichTrigger;
  egressCeiling: EnrichEgressCeiling;
}

/** One named binding of a capability to an engine, as the gateway lists it. */
export interface EngineProfile {
  id: string;
  label: string;
  capability: string;
  egress: EnrichEgressClass;
  builtIn: boolean;
}

/**
 * One capability of one domain, as the phone renders it. `effective: null` is
 * the gateway's fail-closed answer — the vault stated no policy this runtime
 * can honour — and is reported as such, never as "off by default".
 */
export interface EnrichCapabilityState {
  domain: EnrichDomain;
  capability: string;
  effective: ResolvedEnrichPolicy | null;
  /** The profile the effective answer names, when the gateway listed it. */
  profile: EngineProfile | undefined;
}

/** Every capability the phone asks about, in render order, per domain. */
export const MOBILE_ENRICH_CAPABILITIES: Readonly<
  Record<EnrichDomain, readonly string[]>
> = {
  photos: ["ocr", "faces", "embed-image", "transcript"],
  docs: ["embed-text", "doc-text", "doc-entities", "doc-filing", "obligations"],
};

/** The domains in render order. */
export const MOBILE_ENRICH_DOMAINS: readonly EnrichDomain[] = [
  "photos",
  "docs",
];

/** The engine profiles the gateway offers, keyed `<capability>\n<id>`. */
function profileKey(capability: string, id: string): string {
  // A built-in profile's id is the SAME string for every capability
  // (engine-profiles.ts), so profile identity is the PAIR, not the id.
  return `${capability}\n${id}`;
}

/** Read one capability's effective policy — a report, never permission. */
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

/** The gateway's engine profiles. Gateway prefs, so no vault header. */
async function readProfiles(base: string): Promise<EngineProfile[]> {
  const body = await fetchJson<{ profiles?: EngineProfile[] }>(
    `${base}/centraid/_enrich/profiles`,
    { headers: authHeader(), method: "GET" }
  );
  return body.profiles ?? [];
}

/**
 * The whole read behind Settings → Enrichment: every capability's effective
 * policy, joined to the profile each one names. Throws (GatewayError) when the
 * gateway is unreachable or unpaired — the caller renders that honestly rather
 * than showing a stale or invented policy.
 */
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
