/*
 * Renderer-side client for the vault's enrichment policy surface
 * (`/centraid/_vault/enrich*`). Split from gateway-client-vault.ts (#807),
 * whose header rules apply unchanged: owner acts only, apps reach the mirror
 * through `ctx.vault`.
 */

import type {
  EnrichConsentRecord,
  EnrichDomain,
  EnrichEgressClass,
  EnrichEngineProfile,
  EnrichPolicy,
  EnrichPolicyRule,
  EnrichScopeType,
  EnrichTier,
  EnrichTrigger,
  ResolvedEnrichPolicy,
} from "./enrich-policy.js";
import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

/**
 * The owner's standing enrichment tier, per domain (`GET/PUT
 * /centraid/_vault/enrich`, vault-routes.ts).
 *
 * This is the OWNER's copy of the setting — the authoritative writer is
 * `updateEnrichSettings` (packages/vault/src/host.ts), which also refreshes
 * the app-readable `enrich_policy` mirror the enforcement gate reads
 * (packages/server/src/automation/fire/enrich-gate.ts). Apps never reach this route;
 * they read the mirror through `ctx.vault` and cannot write it at all, which
 * is why raising the tier can only happen from an owner surface.
 */
/** Read the owner's per-domain enrichment tiers. */
export async function getEnrichPolicy(): Promise<EnrichPolicy> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/enrich", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ enrich: EnrichPolicy }>(
    res,
    "read enrichment policy"
  );
  return body.enrich;
}

/**
 * Write one or both domains' tier. Returns the tiers that actually took
 * effect, read back from the vault — the caller renders THAT, never the value
 * it hoped for, so a rejected or coerced write can never show as applied.
 */
export async function setEnrichPolicy(
  patch: Partial<EnrichPolicy>
): Promise<EnrichPolicy> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/enrich", {
    method: "PUT",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(patch),
  });
  const body = await readJson<{ enrich: EnrichPolicy }>(
    res,
    "set enrichment policy"
  );
  return body.enrich;
}

/**
 * The policy CASCADE (issue #807): the scoped rules layered over the tiers
 * above. A rule states only what its scope decides — `null` is inherit — and
 * the gateway's ONE resolver folds a chain into the effective answer.
 *
 * A rule can never widen egress past the tier's ceiling; that is enforced at
 * the runtime gate, so nothing here needs (or is allowed) to reason about it.
 */

/** Every scoped rule this vault holds, alongside the per-domain tiers. */
export async function getEnrichRules(): Promise<EnrichPolicyRule[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/enrich", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ rules?: EnrichPolicyRule[] }>(
    res,
    "read enrichment rules"
  );
  return body.rules ?? [];
}

/**
 * Write one scope's rule for one capability, replacing whatever that scope
 * decided before. Returns the rule the VAULT holds afterwards, never the patch
 * — same law as the tier write above.
 */
export async function setEnrichRule(rule: {
  scope: EnrichScopeType;
  ref?: string;
  capability: string;
  enabled?: boolean | null;
  profile?: string | null;
  trigger?: EnrichTrigger | null;
}): Promise<EnrichPolicyRule | null> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/enrich/rules", {
    method: "PUT",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(rule),
  });
  const body = await readJson<{ rule: EnrichPolicyRule | null }>(
    res,
    "set enrichment rule"
  );
  return body.rule;
}

/** Drop one scope's rule — that scope stops deciding, and inherits again. */
export async function deleteEnrichRule(
  scope: EnrichScopeType,
  ref: string,
  capability: string
): Promise<void> {
  const { baseUrl, token } = await auth();
  const query = new URLSearchParams({ scope, ref, capability });
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/enrich/rules?${query.toString()}`,
    { method: "DELETE", headers: authHeaders(token) }
  );
  await readJson(res, "delete enrichment rule");
}

/**
 * What the gateway's resolver folds for one capability at one scope chain.
 * `effective: null` is the fail-closed answer — the vault stated no policy the
 * runtime can honour, and the gate refuses. A REPORT, never permission.
 */
export async function getEffectiveEnrichPolicy(input: {
  domain: EnrichDomain;
  capability: string;
  /** Deeper scopes than `[vault, domain]`, least-specific first. */
  scopes?: ReadonlyArray<{ type: EnrichScopeType; ref: string }>;
}): Promise<{
  tier: EnrichTier | null;
  rules: EnrichPolicyRule[];
  effective: ResolvedEnrichPolicy | null;
}> {
  const { baseUrl, token } = await auth();
  const query = new URLSearchParams({
    domain: input.domain,
    capability: input.capability,
  });
  for (const scope of input.scopes ?? [])
    query.append("scope", `${scope.type}:${scope.ref}`);
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/enrich/effective?${query.toString()}`,
    { method: "GET", headers: authHeaders(token) }
  );
  return readJson<{
    tier: EnrichTier | null;
    rules: EnrichPolicyRule[];
    effective: ResolvedEnrichPolicy | null;
  }>(res, "read effective enrichment policy");
}

/*
 * The EGRESS-CONSENT ledger (issue #807, Wave 3) — capability × egress class,
 * asked once, answered once, recorded. A READ surface here: the ledger's one
 * writer is the vault's journalled `enrich.record_consent` command, reached
 * through the owner-plane POST below, and no client ever writes the rows.
 */

/** Every egress answer this vault holds — the Privacy audit's source. */
export async function listEnrichEgressConsent(): Promise<
  EnrichConsentRecord[]
> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/enrich/consent", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ consent: EnrichConsentRecord[] }>(
    res,
    "read enrichment egress consent"
  );
  return body.consent;
}

/**
 * Record one answer. Returns the row the VAULT holds afterwards — read back,
 * never echoed, so a refused or parked write can never render as an answer.
 * A decline is recorded exactly like a grant; this is not a toggle.
 */
export async function recordEnrichEgressConsent(input: {
  capability: string;
  egress: EnrichEgressClass;
  decision: "granted" | "declined";
  /** Omit for the vault-wide answer. */
  scopeRef?: string;
}): Promise<EnrichConsentRecord | null> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/enrich/consent", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  const body = await readJson<{ consent: EnrichConsentRecord | null }>(
    res,
    "record enrichment egress consent"
  );
  return body.consent;
}

/**
 * The engine profiles this gateway offers (`GET /centraid/_enrich/profiles`).
 *
 * Not a vault route, and it lives here anyway: a profile is the other half of
 * every policy answer above, so the surface that renders one renders both. The
 * list is the gateway's — built-ins are derived from the shipped engines, and
 * `egress` is computed there — so nothing on this side keys off a local table
 * of capabilities or harnesses. Writes go through the prefs API
 * (`enrich.profile.<id>`), which is where the one validation gate lives.
 */
export async function listEnrichProfiles(): Promise<EnrichEngineProfile[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_enrich/profiles", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ profiles?: EnrichEngineProfile[] }>(
    res,
    "read enrichment engine profiles"
  );
  return body.profiles ?? [];
}
