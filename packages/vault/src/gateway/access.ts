// S2 — Access: any check may deny; a deny is an outcome, not an exception.
//
// ONE AUTHORITY PLANE (#928). Three answers decide a caller's reach and there
// is no fourth: the owner's own device reaches its own vault directly, the
// assistant rides the acting owner, and every other caller is an automation
// whose standing answer is a `share_authority` row the owner wrote. A
// first-party app is not a principal at all — its reach is fixed at build
// time by its declared entity manifest and the static tripwire over it.
//
// The per-run execution clamp is what NARROWS an automation to the manifest
// it was launched with; the row is what says the owner ever agreed.

import type { DatabaseSync } from "node:sqlite";

import {
  AUTOMATION_ENTITY_SUBJECT,
  AUTOMATION_PACK_SUBJECT,
} from "../grant/automation-authority.js";
import type { ExecutionScopeSpec, FilterClause, Identity } from "./types.js";
import { GatewayError } from "./types.js";

export interface AccessAllow {
  decision: "allow";
  /** The `share_authority` row that answered; NULL for owner-direct. */
  authorityId: string | null;
  rowFilter: FilterClause[];
  fieldMask: string[] | null;
}
export interface AccessDeny {
  decision: "deny";
  failing: string;
  authorityId: string | null;
}
export type AccessDecision = AccessAllow | AccessDeny;

function verbAllowed(
  scopeVerb: ExecutionScopeSpec["verbs"],
  requested: "read" | "act" | "reveal"
): boolean {
  return requested === "reveal"
    ? scopeVerb === "reveal"
    : requested === "read"
      ? scopeVerb === "read" || scopeVerb === "read+act"
      : scopeVerb === "act" || scopeVerb === "read+act";
}

function intersectFieldMasks(
  granted: readonly string[] | null,
  clamped: readonly string[] | null
): string[] | null {
  if (granted === null) return clamped === null ? null : [...clamped];
  if (clamped === null) return [...granted];
  const clamp = new Set(clamped);
  return granted.filter((field) => clamp.has(field));
}

/** `eq`/`in` pins; two scopes pinning one column differently are a forbidden union. */
const PINNING_OPS = new Set<FilterClause["op"]>(["eq", "in"]);

/** Clamp has no OR — a bounded union is one `in` filter, not two pin scopes. */
function conflictingPin(
  candidates: readonly ExecutionScopeSpec[]
): string | undefined {
  const pinned = new Map<string, string>();
  for (const scope of candidates) {
    for (const clause of scope.rowFilter ?? []) {
      if (!PINNING_OPS.has(clause.op)) continue;
      const seen = pinned.get(clause.column);
      const clauseJson = JSON.stringify(clause);
      if (seen === undefined) pinned.set(clause.column, clauseJson);
      else if (seen !== clauseJson) return clause.column;
    }
  }
  return undefined;
}

/**
 * Intersect every covering manifest scope: filters AND, masks intersect, order
 * independent. No covering scope is deny; empty clamp leaves the caller
 * unnarrowed by this step alone.
 */
function executionClamp(
  identity: Identity,
  schema: string,
  table: string,
  verb: "read" | "act" | "reveal"
): { rowFilter: FilterClause[]; fieldMask: string[] | null } | undefined {
  if (!identity.scopeClamp) return { rowFilter: [], fieldMask: null };
  const candidates = identity.scopeClamp.filter(
    (scope) =>
      scope.schema === schema &&
      (scope.table === undefined || scope.table === table) &&
      verbAllowed(scope.verbs, verb)
  );
  if (candidates.length === 0) return undefined;
  const pin = conflictingPin(candidates);
  if (pin !== undefined) {
    throw new GatewayError(
      "access",
      `execution manifest pins ${schema}.${table}.${pin} in two different scopes for verb ${verb}` +
        ' — express a bounded union as one "in" filter, not as separate scopes'
    );
  }
  const rowFilter: FilterClause[] = [];
  const seenClauses = new Set<string>();
  let fieldMask: string[] | null = null;
  for (const scope of candidates) {
    for (const clause of scope.rowFilter ?? []) {
      const clauseJson = JSON.stringify(clause);
      if (seenClauses.has(clauseJson)) continue;
      seenClauses.add(clauseJson);
      rowFilter.push(clause);
    }
    fieldMask = intersectFieldMasks(fieldMask, scope.fieldMask ?? null);
  }
  return { rowFilter, fieldMask };
}

/**
 * The owner's standing answer about this automation, for this entity and this
 * verb (#928 A3). A pack answer (`agent.pack` × the schema) covers every
 * entity in the pack; an entity answer (`core.entity` × the dotted name)
 * covers exactly one. A `declined` row is an ANSWER and never matches, so a
 * refusal reads as a refusal rather than as a missing grant.
 *
 * `reveal` is deliberately unreachable here: a sealed reveal is Locker's
 * permit, never a standing answer (#873, AP-locker-boundary).
 */
function standingAnswerId(
  vault: DatabaseSync,
  principalId: string,
  schema: string,
  table: string,
  verb: "read" | "act" | "reveal"
): string | undefined {
  if (verb === "reveal") return undefined;
  const row = vault
    .prepare(
      `SELECT authority_id FROM share_authority
        WHERE principal_kind = 'automation' AND principal_id = ?
          AND decision = 'granted' AND revoked_at IS NULL
          AND verb = ?
          AND ((subject_type = ? AND subject_id = ?)
            OR (subject_type = ? AND subject_id = ?))
        ORDER BY granted_at ASC, rowid ASC LIMIT 1`
    )
    .get(
      principalId,
      verb,
      AUTOMATION_PACK_SUBJECT,
      schema,
      AUTOMATION_ENTITY_SUBJECT,
      `${schema}.${table}`
    ) as { authority_id: string } | undefined;
  return row?.authority_id;
}

/** Owner-direct reaches its own vault; every other caller needs a row. */
export function evaluateAccess(
  vault: DatabaseSync,
  identity: Identity,
  schema: string,
  table: string,
  verb: "read" | "act" | "reveal"
): AccessDecision {
  // Reveal is read-shaped, act-graded; readonly devices cannot dump secrets (#293).
  if ((verb === "act" || verb === "reveal") && !identity.mayAct) {
    return {
      decision: "deny",
      failing: "device is readonly",
      authorityId: null,
    };
  }
  // On-behalf-of cap: agent cannot exceed the acting owner (#599.7, #726).
  if (
    (verb === "act" || verb === "reveal") &&
    identity.onBehalfOfOwner?.mayAct === false
  ) {
    return {
      decision: "deny",
      failing: `acting owner ${identity.onBehalfOfOwner.ownerId} does not own this vault`,
      authorityId: null,
    };
  }
  // THE CLAMP NARROWS WHOEVER HOLDS IT. An owner device carrying none reaches
  // its own vault whole; one carrying a declared manifest — a first-party
  // surface — is cut down to it, which is also what keeps an online read and
  // that app's replica rows the same rows with the same columns.
  const clamp = executionClamp(identity, schema, table, verb);
  if (!clamp) {
    return {
      decision: "deny",
      failing: `execution manifest does not declare ${schema}.${table} for verb ${verb}`,
      authorityId: null,
    };
  }
  if (identity.kind === "owner-device") {
    return {
      decision: "allow",
      authorityId: null,
      rowFilter: clamp.rowFilter,
      fieldMask: clamp.fieldMask,
    };
  }
  // THE ASSISTANT HOLDS NO STANDING ANSWER (#928 A3). It reaches what the
  // acting owner reaches and nothing more: the clamp above still applies, and
  // with no acting owner who owns this vault there is nothing to ride, so a
  // scheduler-fired run falls through to the automation row like any other.
  if (identity.assistant && identity.onBehalfOfOwner?.mayAct === true) {
    return {
      decision: "allow",
      authorityId: null,
      rowFilter: clamp.rowFilter,
      fieldMask: clamp.fieldMask,
    };
  }
  const principalId = identity.principalId;
  const authorityId =
    principalId === undefined
      ? undefined
      : standingAnswerId(vault, principalId, schema, table, verb);
  if (authorityId === undefined) {
    return {
      decision: "deny",
      failing: `no standing answer covers ${schema}.${table} for verb ${verb}`,
      authorityId: null,
    };
  }
  return {
    decision: "allow",
    authorityId,
    rowFilter: clamp.rowFilter,
    fieldMask: clamp.fieldMask,
  };
}
