/*
 * `/centraid/_vault/enrich/rules` and `/centraid/_vault/enrich/effective` —
 * the owner's door onto the enrichment policy CASCADE (issue #807, Wave 2).
 *
 * A sibling of `vault-routes.ts` rather than more of it: the legacy per-domain
 * tier handler there stays byte-for-byte what it was (its response body is a
 * contract four seam laws pin), and the cascade is a different resource with
 * its own validation. The tier route delegates here for anything under
 * `enrich/…`.
 *
 *   GET    /centraid/_vault/enrich                      — { enrich, rules }
 *   PUT    /centraid/_vault/enrich/rules                — write one scope's rule
 *   DELETE /centraid/_vault/enrich/rules?scope=&ref=&capability=
 *   GET    /centraid/_vault/enrich/consent              — the egress-consent ledger
 *   POST   /centraid/_vault/enrich/consent              — record one answer (issue #807 Wave 3)
 *   GET    /centraid/_vault/enrich/effective?domain=&capability=&scope=
 *
 * WHAT THIS SURFACE MUST NOT BECOME. `effective` REPORTS what
 * `decideEnrichmentGate`'s resolver would fold; it decides nothing and no
 * caller may treat it as permission. That is why it returns the resolver's own
 * `ResolvedEnrichPolicy` verbatim, produced by the one resolver, instead of
 * recomputing an "is it allowed" answer here — a second policy path is the
 * failure mode this whole wave is arranged to prevent.
 *
 * `effective: null` is the fail-closed answer: the vault stated no policy this
 * runtime can honour, which the gate reads as a refusal, never a default.
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

/** The domains the cascade's `domain` scope may name — closed, per #807 Q1. */
const DOMAINS = ["photos", "docs"] as const;

/**
 * Whether an id names a capability this build carries a contract for. A seam
 * so a host with its own registry (a test, a future third-party contract set)
 * decides what is writable without this route hard-coding the roster.
 */
export type EnrichCapabilityCheck = (id: string) => boolean;

export interface EnrichRulesRouteOptions {
  /** Defaults to the bundled capability registry. */
  capabilityKnown?: EnrichCapabilityCheck;
}

function isDomain(value: string): value is EnrichDomain {
  return (DOMAINS as readonly string[]).includes(value);
}

/** Every rule this build can name a capability for, cascade-ordered per id. */
function allRules(plane: VaultPlane): EnrichPolicyRule[] {
  return ENRICH_CAPABILITY_IDS.flatMap((capability) =>
    listEnrichPolicyRules(plane.db.vault, capability)
  );
}

/** The `rules` half of `GET /_vault/enrich`. */
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
 * A scope names a LEVEL and the thing at it. The vault level's ref is `''`
 * (the DDL CHECKs it), the domain level's ref is a domain this build carries,
 * and the deeper levels carry an opaque id — this surface deliberately does
 * not resolve a collection or item, because a rule for one that no longer
 * exists is inert rather than wrong (see the DDL's comment).
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

/**
 * Handle everything under `enrich/…` past the legacy tier resource. Returns
 * `false` when the path is not one of ours, so the caller can fall through to
 * its own 404/405 handling.
 */
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
    // Read back, never echo: the owner surface renders what the vault holds.
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

  // ── the egress-consent ledger (issue #807, Wave 3) ──────────────────────
  // A read and an answer, never a toggle. The GET is the Privacy audit's
  // source (`ApprovalsScreen`'s enrichment consent section); the POST is the
  // owner-plane door onto the ONE writer — the journalled
  // `enrich.record_consent` command, invoked with the owner credential, so a
  // route can never write the ledger itself.
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
    // The owner credential, deliberately: recording an answer is a
    // consent-state act (`confirm: true` on the command), so an app or agent
    // reaching this verb parks instead of answering for the member.
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
    // Read back, never echo — same law as the rule write above.
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
    // `[vault, domain]` always, plus whatever deeper scopes the caller named,
    // in the order it named them — the cascade is least-specific first and the
    // caller is the only party that knows which collection an item is in.
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
      // The ONE resolver. `null` = no policy this runtime can honour, which
      // the gate reads as a refusal.
      effective: resolveEnrichmentPolicy(rules, tier, capability) ?? null,
    });
  }

  return false;
}
