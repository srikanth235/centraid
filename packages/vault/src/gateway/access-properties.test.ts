// governance: allow-repo-hygiene file-size-limit #864 cohesive security property suite for one module
// Consent-chain property suite (#864 M4). These laws are the invariants
// `evaluateAccess`'s own doc comments claim, driven over generated grants,
// grant_scopes, execution clamps, and access_policy rows rather than
// hand-picked fixtures. The per-decision behaviours are pinned by name in the
// sibling suites — `gateway.contract.test.ts` (the pipeline), `execution-
// clamp.test.ts` (one clamp intersection at a time), `consent-gate.test.ts`
// (the blueprint enrich union), and `manifest-scope-denial.closed-grammar.test.ts`
// (the six-class refusal grammar, which owns that law tag). This file owns the
// ALGEBRA those examples imply: monotonicity, order-independence, and the
// narrowing/riding/precedence rules, checked across the input space.
//
// Each fc run seeds inside a BEGIN/ROLLBACK envelope so a generated grant or
// policy never leaks into the next: `evaluateAccess` only ever SELECTs, so a
// rollback restores the bootstrapped baseline exactly.

import { assert, beforeEach, describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";
import { bootstrappedVault } from "@centraid/test-kit/vault";

import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollApp,
} from "../bootstrap.js";
import type { BootstrapResult, ScopeSpec } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import { evaluateAccess } from "./access.js";
import type { AccessDecision } from "./access.js";
import type { ExecutionScopeSpec, FilterClause, Identity } from "./types.js";

const PURPOSE = "dpv:ServiceProvision";
const SCHEMA = "core";
const TABLES = ["event", "task", "note"] as const;
const COLUMNS = ["status", "owner_id", "archived_at"] as const;

type RequestVerb = "read" | "act" | "reveal";
type ScopeVerb = ScopeSpec["verbs"];

let db: VaultDb;
let boot: BootstrapResult;
let agent: { agentId: string; partyId: string };
let app: { appId: string };
let purposeId: string;

// --- shared arbitraries ------------------------------------------------------

const arbTable = fc.constantFrom(...TABLES);
const arbColumn = fc.constantFrom(...COLUMNS);
const arbRequestVerb: fc.Arbitrary<RequestVerb> = fc.constantFrom(
  "read",
  "act",
  "reveal"
);
const arbScopeVerb: fc.Arbitrary<ScopeVerb> = fc.constantFrom(
  "read",
  "read+act",
  "act",
  "reveal"
);

/** Scope verbs that cover a requested verb (mirrors `verbAllowed`). */
function coveringVerbFor(verb: RequestVerb): fc.Arbitrary<ScopeVerb> {
  if (verb === "reveal") return fc.constant("reveal");
  if (verb === "read") return fc.constantFrom("read", "read+act");
  return fc.constantFrom("act", "read+act");
}

/** Non-pinning clause: `is-null`/`not-null` never trip `conflictingPin`, so a
 *  generated clamp can carry filters without a spurious GatewayError. */
const arbNullClause: fc.Arbitrary<FilterClause> = fc.record({
  column: arbColumn,
  op: fc.constantFrom<"is-null" | "not-null">("is-null", "not-null"),
});

/** Grant scopes are not passed through the clamp's union check, so they may pin. */
const arbGrantClause: fc.Arbitrary<FilterClause> = fc.oneof(
  fc.record({
    column: arbColumn,
    op: fc.constant<"eq">("eq"),
    value: fc.string({ maxLength: 6 }),
  }),
  arbNullClause
);

interface RawScope {
  verbs: ScopeVerb;
  table?: (typeof TABLES)[number];
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

function toScope(raw: RawScope): ExecutionScopeSpec {
  const scope: ExecutionScopeSpec = { schema: SCHEMA, verbs: raw.verbs };
  if (raw.table !== undefined) scope.table = raw.table;
  if (raw.rowFilter && raw.rowFilter.length > 0)
    scope.rowFilter = raw.rowFilter;
  if (raw.fieldMask && raw.fieldMask.length > 0)
    scope.fieldMask = raw.fieldMask;
  return scope;
}

/** A clamp scope with non-pinning filters (safe to permute and union). */
const arbClampRaw: fc.Arbitrary<RawScope> = fc.record(
  {
    verbs: arbScopeVerb,
    table: fc.option(arbTable, { nil: undefined }),
    rowFilter: fc.array(arbNullClause, { maxLength: 2 }),
    fieldMask: fc.uniqueArray(arbColumn, { maxLength: 3 }),
  },
  { requiredKeys: ["verbs"] }
);

const arbGrantRaw: fc.Arbitrary<RawScope> = fc.record(
  {
    verbs: arbScopeVerb,
    table: fc.option(arbTable, { nil: undefined }),
    rowFilter: fc.array(arbGrantClause, { maxLength: 2 }),
    fieldMask: fc.uniqueArray(arbColumn, { maxLength: 3 }),
  },
  { requiredKeys: ["verbs"] }
);

// --- shared helpers ----------------------------------------------------------

type IdentityKind = "owner-device" | "agent" | "app";

function identityFor(opts: {
  kind: IdentityKind;
  mayAct: boolean;
  scopeClamp?: readonly ExecutionScopeSpec[];
  onBehalfOfOwner?: { ownerId: string; mayAct: boolean };
}): Identity {
  const tail = {
    mayAct: opts.mayAct,
    ...(opts.scopeClamp === undefined ? {} : { scopeClamp: opts.scopeClamp }),
    ...(opts.onBehalfOfOwner ? { onBehalfOfOwner: opts.onBehalfOfOwner } : {}),
  };
  if (opts.kind === "owner-device")
    return {
      kind: "owner-device",
      callerId: boot.deviceId,
      provAgentKind: "owner",
      partyId: boot.ownerPartyId,
      ...tail,
    };
  if (opts.kind === "app")
    return {
      kind: "app",
      callerId: app.appId,
      provAgentKind: "app",
      partyId: null,
      ...tail,
    };
  return {
    kind: "agent",
    callerId: agent.agentId,
    provAgentKind: "ai_agent",
    partyId: agent.partyId,
    ...tail,
  };
}

/** Seed a grant for the agent (default) or the app, returning its id. */
function seedGrant(
  scopes: ScopeSpec[],
  principal: "agent" | "app" = "agent"
): string {
  return createGrant(db, {
    ...(principal === "app"
      ? { appId: app.appId }
      : { granteePartyId: agent.partyId }),
    purposeConceptId: purposeId,
    grantedByPartyId: boot.ownerPartyId,
    scopes,
  });
}

function seedPolicy(
  kind: "minimization" | "purpose",
  table: string | null,
  ruleJson: string
): void {
  db.vault
    .prepare(
      // ONE DOTTED ENCODING (#916, R10).
      `INSERT INTO access_policy
         (policy_id, kind, entity, rule_json,
          retention_days, effective_from, priority)
       VALUES (?, ?, ?, ?, NULL, '2020-01-01T00:00:00Z', 1)`
    )
    .run(uuidv7(), kind, `${SCHEMA}.${table}`, ruleJson);
}

function decide(
  identity: Identity,
  table: string,
  verb: RequestVerb
): AccessDecision {
  return evaluateAccess(db.vault, identity, SCHEMA, table, verb, PURPOSE);
}

/** Run `fn` against a savepoint that is always rolled back. */
function inTxn<T>(fn: () => T): T {
  db.vault.exec("BEGIN");
  try {
    return fn();
  } finally {
    db.vault.exec("ROLLBACK");
  }
}

const clauseKey = (clause: FilterClause): string => JSON.stringify(clause);

const sortedMask = (mask: readonly string[] | null): string[] | null =>
  mask === null ? null : [...mask].sort();

/**
 * A decision reduced to an order-independent, comparable shape: the rowFilter
 * clause SET and the fieldMask SET, with array order dropped (array order
 * follows clamp order by design — pinned in execution-clamp.test.ts). Lets the
 * order-independence law assert one unconditional equality over both branches.
 */
function normDecision(decision: AccessDecision): Record<string, unknown> {
  if (decision.decision === "deny")
    return {
      decision: "deny",
      failing: decision.failing,
      grantId: decision.grantId,
    };
  return {
    decision: "allow",
    grantId: decision.grantId,
    rowFilter: decision.rowFilter.map(clauseKey).sort(),
    fieldMask: sortedMask(decision.fieldMask),
  };
}

/** The field-mask intersection `evaluateAccess`/`executionClamp` compute. */
function intersectMasks(
  a: readonly string[] | null,
  b: readonly string[] | null
): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const bs = new Set(b);
  return a.filter((field) => bs.has(field));
}

describe("consent chain property", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    agent = enrollAgent(db, {
      name: "digest",
      modelRef: "centraid-automation",
    });
    app = enrollApp(db, { name: "widget" });
    purposeId = boot.concepts[PURPOSE] as string;
  });

  // [law:consent-denial-monotone] Deleting a grant, removing a grant_scope,
  // narrowing a clamp verb, or adding a access_policy row can only turn
  // allow→deny, never deny→allow.
  test("[law:consent-denial-monotone] a restriction never converts a deny into an allow", () => {
    const seen = { allowBefore: 0, denyBefore: 0, flips: 0 };
    fc.assert(
      fc.property(
        fc.record({
          kind: fc.constantFrom<IdentityKind>("owner-device", "agent", "app"),
          mayAct: fc.boolean(),
          table: arbTable,
          verb: arbRequestVerb,
          clampScopes: fc.array(arbClampRaw, { maxLength: 3 }),
          extraGrantScopes: fc.array(arbGrantRaw, { maxLength: 2 }),
        }),
        fc.constantFrom(
          "delete-grant",
          "remove-scope",
          "narrow-clamp-verb",
          "add-minimization-policy",
          "add-purpose-policy"
        ),
        (sc, mutation) => {
          inTxn(() => {
            const principal = sc.kind === "app" ? "app" : "agent";
            // A guaranteed schema-wide read+act scope keeps allows frequent, so
            // the monotone implication is exercised, not vacuously satisfied.
            const grantScopes: ScopeSpec[] = [
              { schema: SCHEMA, verbs: "read+act" },
              ...sc.extraGrantScopes.map(toScope),
            ];
            const grantId = seedGrant(grantScopes, principal);
            const clamp = sc.clampScopes.map(toScope);
            const idA = identityFor({
              kind: sc.kind,
              mayAct: sc.mayAct,
              scopeClamp: clamp,
            });
            const before = decide(idA, sc.table, sc.verb);

            let idB = idA;
            switch (mutation) {
              case "delete-grant":
                db.vault
                  .prepare(`DELETE FROM access_grant_scope WHERE grant_id = ?`)
                  .run(grantId);
                db.vault
                  .prepare(`DELETE FROM access_grant WHERE grant_id = ?`)
                  .run(grantId);
                break;
              case "remove-scope":
                db.vault
                  .prepare(
                    `DELETE FROM access_grant_scope
                      WHERE scope_id = (
                        SELECT scope_id FROM access_grant_scope
                         WHERE grant_id = ? LIMIT 1)`
                  )
                  .run(grantId);
                break;
              case "narrow-clamp-verb":
                // read+act → read drops `act` coverage: a strict narrowing.
                idB = identityFor({
                  kind: sc.kind,
                  mayAct: sc.mayAct,
                  scopeClamp: clamp.map((scope) =>
                    scope.verbs === "read+act"
                      ? { ...scope, verbs: "read" }
                      : scope
                  ),
                });
                break;
              case "add-minimization-policy":
                seedPolicy("minimization", sc.table, "{}");
                break;
              case "add-purpose-policy":
                seedPolicy(
                  "purpose",
                  null,
                  '{"allowed_purposes":["dpv:Billing"]}'
                );
                break;
            }
            const after = decide(idB, sc.table, sc.verb);

            if (before.decision === "allow") seen.allowBefore++;
            else seen.denyBefore++;
            if (before.decision === "allow" && after.decision === "deny")
              seen.flips++;

            // The whole law: a restriction cannot manufacture an allow.
            expect(after.decision === "allow" ? before.decision : "allow").toBe(
              "allow"
            );
          });
        }
      ),
      { numRuns: 250, seed: 8641 }
    );
    // Non-vacuity: the run actually saw allows and at least one allow→deny flip.
    expect(seen.allowBefore).toBeGreaterThan(0);
    expect(seen.flips).toBeGreaterThan(0);
  });

  // [law:consent-clamp-order-independent] The decision, the SET of returned
  // rowFilter clauses, and the fieldMask are invariant under permutation of
  // identity.scopeClamp. (Clause/field ARRAY order follows clamp order by
  // design — that ordering is pinned in execution-clamp.test.ts — so only the
  // set is asserted here.)
  test("[law:consent-clamp-order-independent] permuting the clamp preserves the decision and clause set", () => {
    let allows = 0;
    fc.assert(
      fc.property(
        fc.record({
          mayAct: fc.boolean(),
          table: arbTable,
          verb: arbRequestVerb,
          grantScopes: fc.array(arbGrantRaw, { minLength: 1, maxLength: 3 }),
          clampScopes: fc.array(arbClampRaw, { minLength: 1, maxLength: 4 }),
        }),
        fc.integer({ min: 0, max: 4 }),
        (sc, rotate) => {
          inTxn(() => {
            seedGrant(sc.grantScopes.map(toScope));
            const clamp = sc.clampScopes.map(toScope);
            const rotated = [
              ...clamp.slice(rotate % clamp.length),
              ...clamp.slice(0, rotate % clamp.length),
            ];
            const base = decide(
              identityFor({
                kind: "agent",
                mayAct: sc.mayAct,
                scopeClamp: clamp,
              }),
              sc.table,
              sc.verb
            );
            const perm = decide(
              identityFor({
                kind: "agent",
                mayAct: sc.mayAct,
                scopeClamp: rotated,
              }),
              sc.table,
              sc.verb
            );
            if (base.decision === "allow") allows++;
            // One unconditional equality over the order-independent projection:
            // decision, grantId, the rowFilter clause set, and the fieldMask set.
            expect(normDecision(perm)).toStrictEqual(normDecision(base));
          });
        }
      ),
      { numRuns: 250, seed: 8642 }
    );
    expect(allows).toBeGreaterThan(0);
  });

  // [law:consent-clamp-only-narrows] For every allow the returned rowFilter is a
  // superset of the winning grant scope's clauses AND the clamp's clauses, and
  // the fieldMask is exactly grantMask ∩ clampMask (null only when both null).
  test("[law:consent-clamp-only-narrows] an allow's rowFilter is a superset and its fieldMask the exact intersection", () => {
    let allows = 0;
    // `coveringVerbFor` depends on the generated request verb, so the scenario
    // is built with `arbRequestVerb.chain(...)` rather than a flat record.
    fc.assert(
      fc.property(
        arbRequestVerb.chain((verb) =>
          fc.record({
            verb: fc.constant(verb),
            table: arbTable,
            grantVerb: coveringVerbFor(verb),
            clampVerb: coveringVerbFor(verb),
            grantTableWhole: fc.boolean(),
            clampTableWhole: fc.boolean(),
            grantRowFilter: fc.array(arbGrantClause, { maxLength: 2 }),
            grantFieldMask: fc.option(
              fc.uniqueArray(arbColumn, { maxLength: 3 }),
              { nil: null }
            ),
            clampRowFilter: fc.array(arbNullClause, { maxLength: 2 }),
            clampFieldMask: fc.option(
              fc.uniqueArray(arbColumn, { maxLength: 3 }),
              { nil: null }
            ),
          })
        ),
        (sc) => {
          inTxn(() => {
            const grantScope: ScopeSpec = {
              schema: SCHEMA,
              verbs: sc.grantVerb,
              ...(sc.grantTableWhole ? {} : { table: sc.table }),
              ...(sc.grantRowFilter.length > 0
                ? { rowFilter: sc.grantRowFilter }
                : {}),
              ...(sc.grantFieldMask ? { fieldMask: sc.grantFieldMask } : {}),
            };
            seedGrant([grantScope]);
            const clampScope: ExecutionScopeSpec = {
              schema: SCHEMA,
              verbs: sc.clampVerb,
              ...(sc.clampTableWhole ? {} : { table: sc.table }),
              ...(sc.clampRowFilter.length > 0
                ? { rowFilter: sc.clampRowFilter }
                : {}),
              ...(sc.clampFieldMask ? { fieldMask: sc.clampFieldMask } : {}),
            };
            const decision = decide(
              identityFor({
                kind: "agent",
                mayAct: true,
                scopeClamp: [clampScope],
              }),
              sc.table,
              sc.verb
            );
            // The construction covers the verb on both layers, so it allows.
            assert(decision.decision === "allow");
            allows++;

            // The returned rowFilter is a superset of the grant's clauses AND
            // the clamp's clauses (narrowing only ever adds constraints).
            const returned = new Set(decision.rowFilter.map(clauseKey));
            expect(
              [...sc.grantRowFilter, ...sc.clampRowFilter].every((clause) =>
                returned.has(clauseKey(clause))
              )
            ).toBe(true);

            // The fieldMask is exactly grantMask ∩ clampMask (null iff both
            // null); order-normalized so only the set is asserted.
            const expectedMask = intersectMasks(
              sc.grantFieldMask,
              sc.clampFieldMask
            );
            expect(sortedMask(decision.fieldMask)).toStrictEqual(
              sortedMask(expectedMask)
            );
          });
        }
      ),
      { numRuns: 300, seed: 8643 }
    );
    expect(allows).toBeGreaterThan(0);
  });

  // [law:consent-reveal-never-rides] Reveal is allowed only when some grant_scope
  // AND some clamp scope carry verb "reveal"; a "reveal" scope never satisfies a
  // read or act request.
  test("[law:consent-reveal-never-rides] reveal requires reveal on both layers and a reveal scope rides nothing else", () => {
    // (a) A reveal allow ⟺ a reveal-covering clamp scope AND a reveal-covering
    //     grant scope for the requested (schema, table).
    let revealAllows = 0;
    fc.assert(
      fc.property(
        fc.record({
          table: arbTable,
          grantScopes: fc.array(arbGrantRaw, { minLength: 1, maxLength: 3 }),
          clampScopes: fc.array(arbClampRaw, { minLength: 1, maxLength: 3 }),
        }),
        (sc) => {
          inTxn(() => {
            const grantScopes = sc.grantScopes.map(toScope);
            const clampScopes = sc.clampScopes.map(toScope);
            seedGrant(grantScopes);
            const decision = decide(
              identityFor({
                kind: "agent",
                mayAct: true,
                scopeClamp: clampScopes,
              }),
              sc.table,
              "reveal"
            );
            const covers = (scope: ExecutionScopeSpec): boolean =>
              scope.verbs === "reveal" &&
              (scope.table === undefined || scope.table === sc.table);
            const clampReveal = clampScopes.some(covers);
            const grantReveal = grantScopes.some(covers);
            expect(decision.decision === "allow").toBe(
              clampReveal && grantReveal
            );
            if (decision.decision === "allow") revealAllows++;
          });
        }
      ),
      { numRuns: 250, seed: 8644 }
    );
    expect(revealAllows).toBeGreaterThan(0);

    // (b) A layer that carries ONLY "reveal" denies every read/act request —
    //     the clamp refuses before any grant is consulted.
    fc.assert(
      fc.property(
        fc.constantFrom<RequestVerb>("read", "act"),
        arbTable,
        (verb, table) => {
          inTxn(() => {
            seedGrant([{ schema: SCHEMA, verbs: "reveal" }]);
            const decision = decide(
              identityFor({
                kind: "agent",
                mayAct: true,
                scopeClamp: [{ schema: SCHEMA, verbs: "reveal" }],
              }),
              table,
              verb
            );
            expect(decision.decision).toBe("deny");
          });
        }
      ),
      { numRuns: 60, seed: 8645 }
    );
  });

  // [law:consent-explicit-scope-unbypassable] A table under a kind:'minimization'
  // policy row is never allowed by a whole-schema (table_name IS NULL) grant
  // scope — only a scope naming the table explicitly covers it.
  test("[law:consent-explicit-scope-unbypassable] a minimization table denies a whole-schema grant scope but allows an explicit one", () => {
    let denies = 0;
    let controlAllows = 0;
    fc.assert(
      fc.property(
        arbRequestVerb.chain((verb) =>
          fc.record({
            verb: fc.constant(verb),
            table: arbTable,
            grantVerb: coveringVerbFor(verb),
            clampVerb: coveringVerbFor(verb),
          })
        ),
        (sc) => {
          inTxn(() => {
            seedPolicy("minimization", sc.table, "{}");
            const clamp: ExecutionScopeSpec[] = [
              { schema: SCHEMA, verbs: sc.clampVerb },
            ];
            const identity = identityFor({
              kind: "agent",
              mayAct: true,
              scopeClamp: clamp,
            });

            // A whole-schema grant scope is skipped for the minimized table.
            const wholeGrant = seedGrant([
              { schema: SCHEMA, verbs: sc.grantVerb },
            ]);
            const denied = decide(identity, sc.table, sc.verb);
            assert(denied.decision === "deny");
            expect(denied.failing).toContain("no grant_scope covers");
            denies++;

            // Swap in an explicit table scope: now the same request is allowed,
            // proving it was the whole-schema-ness that was refused.
            db.vault
              .prepare(`DELETE FROM access_grant_scope WHERE grant_id = ?`)
              .run(wholeGrant);
            db.vault
              .prepare(`DELETE FROM access_grant WHERE grant_id = ?`)
              .run(wholeGrant);
            seedGrant([
              { schema: SCHEMA, table: sc.table, verbs: sc.grantVerb },
            ]);
            const allowed = decide(identity, sc.table, sc.verb);
            expect(allowed.decision).toBe("allow");
            controlAllows++;
          });
        }
      ),
      { numRuns: 120, seed: 8646 }
    );
    expect(denies).toBeGreaterThan(0);
    expect(controlAllows).toBeGreaterThan(0);
  });

  // [law:consent-onbehalf-cap-precedes-grants] When onBehalfOfOwner.mayAct is
  // false, no grant set produces an allow for act/reveal, and the deny names the
  // owner id — checked before any grant is consulted (grantId is null).
  test("[law:consent-onbehalf-cap-precedes-grants] a non-owning acting owner caps act/reveal before grants, naming the owner", () => {
    fc.assert(
      fc.property(
        fc.record({
          verb: fc.constantFrom<RequestVerb>("act", "reveal"),
          table: arbTable,
          ownerId: fc.string({ minLength: 1, maxLength: 16 }),
          grantScopes: fc.array(arbGrantRaw, { maxLength: 3 }),
          clampScopes: fc.array(arbClampRaw, { maxLength: 3 }),
        }),
        (sc) => {
          inTxn(() => {
            // A maximal grant + covering clamp: the cap must bite regardless.
            seedGrant([
              { schema: SCHEMA, verbs: "read+act" },
              { schema: SCHEMA, verbs: "reveal" },
              ...sc.grantScopes.map(toScope),
            ]);
            const clamp: ExecutionScopeSpec[] = [
              { schema: SCHEMA, verbs: "read+act" },
              { schema: SCHEMA, verbs: "reveal" },
              ...sc.clampScopes.map(toScope),
            ];
            const decision = decide(
              identityFor({
                kind: "agent",
                mayAct: true,
                scopeClamp: clamp,
                onBehalfOfOwner: { ownerId: sc.ownerId, mayAct: false },
              }),
              sc.table,
              sc.verb
            );
            assert(decision.decision === "deny");
            expect(decision.failing).toContain(sc.ownerId);
            expect(decision.grantId).toBeNull();
          });
        }
      ),
      { numRuns: 200, seed: 8647 }
    );
  });
});
