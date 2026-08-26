// Renderer-side enrichment policy client (#807): owner acts only; apps read
// the mirror through `ctx.vault`.

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

/** Render what took effect, read back — never the value hoped for. The same
 *  law governs every write below. */
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

// `null` in a rule means inherit; no rule widens egress past the tier ceiling.

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

/** `effective: null` is fail-closed. A REPORT, never permission. */
export async function getEffectiveEnrichPolicy(input: {
  domain: EnrichDomain;
  capability: string;
  /** Least-specific first. */
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

// The egress-consent ledger is READ-only here; `enrich.record_consent` writes it.

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

/** A decline is recorded like a grant; not a toggle. */
export async function recordEnrichEgressConsent(input: {
  capability: string;
  egress: EnrichEgressClass;
  decision: "granted" | "declined";
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

/** The gateway owns the list; never key off a local capability table. */
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
