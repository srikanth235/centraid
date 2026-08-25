/*
 * Owner door onto the enrichment policy cascade (#807). Sibling of
 * `vault-routes.ts`; the tier route delegates `enrich/…` here.
 * `effective` REPORTS what `decideEnrichmentGate` would fold — it decides
 * nothing and is not permission. Return the one resolver's
 * `ResolvedEnrichPolicy` verbatim; a second policy path is the failure.
 * `effective: null` is fail-closed (refusal, never a default).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ENRICH_EGRESS_CLASSES,
  ENRICH_SCOPE_TYPES,
  ENRICH_TRIGGERS,
  deleteEnrichPolicyRule,
  listEnrichConsent,
  listEnrichPolicyRules,
  putEnrichPolicyRule,
  readEnrichConsent,
  readEnrichPolicyResolutionInput,
  readEnrichPolicyRule,
} from "@centraid/vault";
import type {
  EnrichEgressClass,
  EnrichPolicyRule,
  EnrichScope,
  EnrichScopeType,
  EnrichTrigger,
} from "@centraid/vault";

import { resolveEnrichmentPolicy } from "../automation/index.js";
import type { EnrichDomain } from "../automation/index.js";
import {
  ENRICH_CAPABILITY_IDS,
  isEnrichCapability,
} from "../enrich/capability-registry.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

const DOMAINS = ["photos", "docs"] as const;

export type EnrichCapabilityCheck = (id: string) => boolean;

export interface EnrichRulesRouteOptions {
  capabilityKnown?: EnrichCapabilityCheck;
}

function isDomain(value: string): value is EnrichDomain {
  return (DOMAINS as readonly string[]).includes(value);
}

function allRules(plane: VaultPlane): EnrichPolicyRule[] {
  return ENRICH_CAPABILITY_IDS.flatMap((capability) =>
    listEnrichPolicyRules(plane.db.vault, capability)
  );
}

export function enrichRulesFor(plane: VaultPlane): EnrichPolicyRule[] {
  return allRules(plane);
}

interface ParsedScope {
  scope: EnrichScope;
  error?: undefined;
}
interface ScopeError {
  scope?: undefined;
  error: string;
}

/**
 * Do not resolve collection/item here: a rule for a gone id is inert, not wrong.
 */
function parseScope(value: unknown, ref: unknown): ParsedScope | ScopeError {
  if (
    typeof value !== "string" ||
    !(ENRICH_SCOPE_TYPES as readonly string[]).includes(value)
  )
    return {
      error: `scope must be one of ${ENRICH_SCOPE_TYPES.join(", ")}`,
    };
  const type = value as EnrichScopeType;
  const scopeRef = ref === undefined || ref === null ? "" : ref;
  if (typeof scopeRef !== "string") return { error: "ref must be text" };
  if (type === "vault" && scopeRef !== "")
    return { error: 'the vault scope carries no ref (it is always "")' };
  if (type !== "vault" && scopeRef === "")
    return { error: `the ${type} scope must name what it decides for` };
  if (type === "domain" && !isDomain(scopeRef))
    return { error: `domain must be one of ${DOMAINS.join(", ")}` };
  return { scope: { type, ref: scopeRef } };
}

function parseTriState(value: unknown): boolean | null | "invalid" {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : "invalid";
}

function parseTrigger(value: unknown): EnrichTrigger | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" &&
    (ENRICH_TRIGGERS as readonly string[]).includes(value)
  )
    return value as EnrichTrigger;
  return "invalid";
}

function parseProfile(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64)
    return "invalid";
  return value;
}

function badRequest(res: ServerResponse, message: string): true {
  return sendJson(res, 400, { error: "bad_request", message });
}

/** `false` when the path is not ours so the caller can 404/405. */
export async function handleEnrichCascadeRoute(input: {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** Path segments AFTER `enrich` — `["rules"]`, `["effective"]`, … */
  segments: readonly string[];
  url: URL;
  plane: VaultPlane;
  options?: EnrichRulesRouteOptions;
}): Promise<boolean> {
  const { req, res, method, segments, url, plane } = input;
  const capabilityKnown =
    input.options?.capabilityKnown ?? ((id: string) => isEnrichCapability(id));

  if (segments.length !== 1) return false;

  if (segments[0] === "rules" && method === "PUT") {
    const body = await readJson(req);
    const parsed = parseScope(body["scope"], body["ref"]);
    if (parsed.error !== undefined) return badRequest(res, parsed.error);
    const capability = body["capability"];
    if (typeof capability !== "string" || !capabilityKnown(capability))
      return badRequest(
        res,
        `capability must be one of ${ENRICH_CAPABILITY_IDS.join(", ")}`
      );
    const enabled = parseTriState(body["enabled"]);
    if (enabled === "invalid")
      return badRequest(res, "enabled must be true, false or null");
    const profile = parseProfile(body["profile"]);
    if (profile === "invalid")
      return badRequest(res, "profile must be an engine profile id, or null");
    const trigger = parseTrigger(body["trigger"]);
    if (trigger === "invalid")
      return badRequest(
        res,
        `trigger must be one of ${ENRICH_TRIGGERS.join(", ")}, or null`
      );
    if (enabled === null && profile === null && trigger === null)
      return badRequest(
        res,
        "a rule must decide something — set enabled, profile or trigger, " +
          "or DELETE the rule so the scope stops deciding"
      );
    putEnrichPolicyRule(plane.db.vault, {
      scope: parsed.scope,
      capability,
      enabled,
      profile,
      trigger,
    });
    // Read back, never echo.
    return sendJson(res, 200, {
      rule: readEnrichPolicyRule(plane.db.vault, parsed.scope, capability),
    });
  }

  if (segments[0] === "rules" && method === "DELETE") {
    const parsed = parseScope(
      url.searchParams.get("scope"),
      url.searchParams.get("ref") ?? ""
    );
    if (parsed.error !== undefined) return badRequest(res, parsed.error);
    const capability = url.searchParams.get("capability");
    if (typeof capability !== "string" || !capabilityKnown(capability))
      return badRequest(
        res,
        `capability must be one of ${ENRICH_CAPABILITY_IDS.join(", ")}`
      );
    deleteEnrichPolicyRule(plane.db.vault, parsed.scope, capability);
    return sendJson(res, 200, { deleted: true });
  }

  // ── egress-consent ledger (#807) ───────────────────────────────────────
  // A read and an answer, never a toggle. POST goes through the one writer
  // `enrich.record_consent` with the owner credential — this route never writes.
  if (segments[0] === "consent" && method === "GET") {
    return sendJson(res, 200, {
      consent: listEnrichConsent(plane.db.vault),
    });
  }

  if (segments[0] === "consent" && method === "POST") {
    const body = await readJson(req);
    const capability = body["capability"];
    if (typeof capability !== "string" || !capabilityKnown(capability))
      return badRequest(
        res,
        `capability must be one of ${ENRICH_CAPABILITY_IDS.join(", ")}`
      );
    const egress = body["egress"];
    if (
      typeof egress !== "string" ||
      !(ENRICH_EGRESS_CLASSES as readonly string[]).includes(egress)
    )
      return badRequest(
        res,
        `egress must be one of ${ENRICH_EGRESS_CLASSES.join(", ")}`
      );
    const decision = body["decision"];
    if (decision !== "granted" && decision !== "declined")
      return badRequest(res, "decision must be granted or declined");
    const scopeRef = body["scopeRef"] ?? "";
    if (typeof scopeRef !== "string")
      return badRequest(res, "scopeRef must be text");
    // Owner credential: consent-state (`confirm: true`) — an app/agent parks.
    const outcome = await plane.invoke(plane.ownerCredential, {
      command: "enrich.record_consent",
      input: { capability, egress, scope_ref: scopeRef, decision },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed")
      return sendJson(res, 409, {
        error: "not_recorded",
        message:
          "reason" in outcome && typeof outcome.reason === "string"
            ? outcome.reason
            : `the vault ${outcome.status} the answer`,
      });
    // Read back, never echo.
    return sendJson(res, 200, {
      consent: readEnrichConsent(plane.db.vault, {
        capability,
        egress: egress as EnrichEgressClass,
        scopeRef,
      }),
    });
  }

  if (segments[0] === "effective" && method === "GET") {
    const domain = url.searchParams.get("domain") ?? "";
    if (!isDomain(domain))
      return badRequest(res, `domain must be one of ${DOMAINS.join(", ")}`);
    const capability = url.searchParams.get("capability") ?? "";
    if (!capabilityKnown(capability))
      return badRequest(
        res,
        `capability must be one of ${ENRICH_CAPABILITY_IDS.join(", ")}`
      );
    // `[vault, domain]` first, then caller-named deeper scopes (least-specific first).
    const chain: EnrichScope[] = [
      { type: "vault", ref: "" },
      { type: "domain", ref: domain },
    ];
    for (const raw of url.searchParams.getAll("scope")) {
      const at = raw.indexOf(":");
      const parsed = parseScope(
        at === -1 ? raw : raw.slice(0, at),
        at === -1 ? "" : raw.slice(at + 1)
      );
      if (parsed.error !== undefined) return badRequest(res, parsed.error);
      chain.push(parsed.scope);
    }
    const { tier, rules } = readEnrichPolicyResolutionInput(
      plane.db.vault,
      domain,
      capability,
      chain
    );
    return sendJson(res, 200, {
      tier: tier ?? null,
      rules,
      // The one resolver. `null` = no honourable policy = refusal.
      effective: resolveEnrichmentPolicy(rules, tier, capability) ?? null,
    });
  }

  return false;
}
