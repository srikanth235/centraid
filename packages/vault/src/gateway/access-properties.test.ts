// governance: allow-repo-hygiene file-size-limit #864 cohesive security property suite for one module
// Authority-chain property suite (#864 M4, re-based on the one plane by #928).
// These laws are the invariants `evaluateAccess`'s own doc comments claim,
// driven over generated standing answers and execution clamps rather than
// hand-picked fixtures. The per-decision behaviours are pinned by name in the
// sibling suites — `gateway.contract.test.ts` (the pipeline), `execution-
// clamp.test.ts` (one clamp intersection at a time), `consent-gate.test.ts`
// (the blueprint enrich union), and `manifest-scope-denial.closed-grammar.test.ts`
// (the six-class refusal grammar, which owns that law tag). This file owns the
// ALGEBRA those examples imply: monotonicity, order-independence, and the
// narrowing/riding/precedence rules, checked across the input space.
//
// Each fc run seeds inside a BEGIN/ROLLBACK envelope so a generated answer
// never leaks into the next: `evaluateAccess` only ever SELECTs, so a rollback
// restores the bootstrapped baseline exactly.

import { assert, beforeEach, describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";
import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult, ScopeSpec } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import { evaluateAccess } from "./access.js";
import type { AccessDecision } from "./access.js";
import type { ExecutionScopeSpec, FilterClause, Identity } from "./types.js";

const SCHEMA = "core";
const TABLES = ["event", "task", "note"] as const;
const COLUMNS = ["status", "owner_id", "archived_at"] as const;
const PRINCIPAL = "digest";

type RequestVerb = "read" | "act" | "reveal";
type ScopeVerb = ScopeSpec["verbs"];

let db: VaultDb;
let boot: BootstrapResult;
let agent: { agentId: string; partyId: string };

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

/** A standing answer names an extent and a verb, and nothing else (#928): the
 *  owner answers WHETHER, the clamp says how narrow. */
const arbAnswerRaw: fc.Arbitrary<RawScope> = fc.record(
  {
    verbs: arbScopeVerb,
    table: fc.option(arbTable, { nil: undefined }),
  },
  { requiredKeys: ["verbs"] }
);

// --- shared helpers ----------------------------------------------------------

/** `surface` is an owner device that names the app that carried the call. */
type IdentityKind = "owner-device" | "agent" | "surface";

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
  if (opts.kind === "surface")
    return {
      kind: "owner-device",
      callerId: "widget",
      surface: "widget",
      provAgentKind: "app",
      partyId: boot.ownerPartyId,
      ...tail,
    };
  return {
    kind: "agent",
    callerId: agent.agentId,
    principalId: PRINCIPAL,
    provAgentKind: "ai_agent",
    partyId: agent.partyId,
    ...tail,
  };
}

/** Record the owner's YES for the automation principal. */
function seedAnswer(scopes: readonly ExecutionScopeSpec[]): void {
  answerScopes(
    db,
    boot,
    PRINCIPAL,
    scopes.map((scope) => ({
      schema: scope.schema,
      ...(scope.table === undefined ? {} : { table: scope.table }),
      verbs: scope.verbs,
    }))
  );
}

function decide(
  identity: Identity,
  table: string,
  verb: RequestVerb
): AccessDecision {
  return evaluateAccess(db.vault, identity, SCHEMA, table, verb);
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
      authorityId: decision.authorityId,
    };
  return {
    decision: "allow",
    authorityId: decision.authorityId,
    rowFilter: decision.rowFilter.map(clauseKey).sort(),
    fieldMask: sortedMask(decision.fieldMask),
  };
}

/** The field-mask intersection `executionClamp` computes. */
function intersectMasks(
  a: readonly string[] | null,
  b: readonly string[] | null
): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const bs = new Set(b);
  return a.filter((field) => bs.has(field));
}

describe("authority chain property", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    agent = enrollAgent(db, {
      name: PRINCIPAL,
      modelRef: "centraid-automation",
    });
  });

  // [law:consent-denial-monotone] Withdrawing a standing answer, replacing it
  // with a `declined` row, or narrowing a clamp verb can only turn allow→deny,
  // never deny→allow.
  test("[law:consent-denial-monotone] a restriction never converts a deny into an allow", () => {
    const seen = { allowBefore: 0, denyBefore: 0, flips: 0 };
    fc.assert(
      fc.property(
        fc.record({
          kind: fc.constantFrom<IdentityKind>(
            "owner-device",
            "agent",
            "surface"
          ),
          mayAct: fc.boolean(),
          table: arbTable,
          verb: arbRequestVerb,
          clampScopes: fc.array(arbClampRaw, { maxLength: 3 }),
          extraAnswers: fc.array(arbAnswerRaw, { maxLength: 2 }),
        }),
        fc.constantFrom("revoke-answer", "decline-answer", "narrow-clamp-verb"),
        (sc, mutation) => {
          inTxn(() => {
            // A guaranteed schema-wide read+act answer keeps allows frequent,
            // so the monotone implication is exercised, not vacuous.
            seedAnswer([
              { schema: SCHEMA, verbs: "read+act" },
              ...sc.extraAnswers.map(toScope),
            ]);
            const clamp = sc.clampScopes.map(toScope);
            const idA = identityFor({
              kind: sc.kind,
              mayAct: sc.mayAct,
              scopeClamp: clamp,
            });
            const before = decide(idA, sc.table, sc.verb);

            let idB = idA;
            switch (mutation) {
              case "revoke-answer":
                db.vault
                  .prepare(
                    `UPDATE share_authority SET revoked_at = '2026-01-01T00:00:00Z'
                      WHERE principal_kind = 'automation' AND principal_id = ?`
                  )
                  .run(PRINCIPAL);
                break;
              case "decline-answer":
                // A refusal is an ANSWER, and it never allows.
                db.vault
                  .prepare(
                    `UPDATE share_authority SET decision = 'declined'
                      WHERE principal_kind = 'automation' AND principal_id = ?`
                  )
                  .run(PRINCIPAL);
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
          answerScopes: fc.array(arbAnswerRaw, { minLength: 1, maxLength: 3 }),
          clampScopes: fc.array(arbClampRaw, { minLength: 1, maxLength: 4 }),
        }),
        fc.integer({ min: 0, max: 4 }),
        (sc, rotate) => {
          inTxn(() => {
            seedAnswer(sc.answerScopes.map(toScope));
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
            // decision, authorityId, the rowFilter clause set, the fieldMask set.
            expect(normDecision(perm)).toStrictEqual(normDecision(base));
          });
        }
      ),
      { numRuns: 250, seed: 8642 }
    );
    expect(allows).toBeGreaterThan(0);
  });

  // [law:consent-clamp-only-narrows] For every allow the returned rowFilter is
  // exactly the covering clamp scopes' clauses and the fieldMask exactly their
  // intersection (null only when every covering scope leaves it null). A
  // standing answer contributes no rows and no fields of its own (#928).
  test("[law:consent-clamp-only-narrows] an allow's rows and fields come from the clamp alone", () => {
    let allows = 0;
    // `coveringVerbFor` depends on the generated request verb, so the scenario
    // is built with `arbRequestVerb.chain(...)` rather than a flat record.
    fc.assert(
      fc.property(
        arbRequestVerb.chain((verb) =>
          fc.record({
            verb: fc.constant(verb),
            table: arbTable,
            answerVerb: coveringVerbFor(verb),
            clampVerbA: coveringVerbFor(verb),
            clampVerbB: coveringVerbFor(verb),
            answerTableWhole: fc.boolean(),
            clampRowFilterA: fc.array(arbNullClause, { maxLength: 2 }),
            clampFieldMaskA: fc.option(
              fc.uniqueArray(arbColumn, { maxLength: 3 }),
              { nil: null }
            ),
            clampRowFilterB: fc.array(arbNullClause, { maxLength: 2 }),
            clampFieldMaskB: fc.option(
              fc.uniqueArray(arbColumn, { maxLength: 3 }),
              { nil: null }
            ),
          })
        ),
        (sc) => {
          inTxn(() => {
            // `reveal` is never a standing answer, so this law is exercised on
            // the two verbs an answer can carry.
            if (sc.verb === "reveal") return;
            seedAnswer([
              {
                schema: SCHEMA,
                verbs: sc.answerVerb,
                ...(sc.answerTableWhole ? {} : { table: sc.table }),
              },
            ]);
            const clampA: ExecutionScopeSpec = {
              schema: SCHEMA,
              table: sc.table,
              verbs: sc.clampVerbA,
              ...(sc.clampRowFilterA.length > 0
                ? { rowFilter: sc.clampRowFilterA }
                : {}),
              ...(sc.clampFieldMaskA ? { fieldMask: sc.clampFieldMaskA } : {}),
            };
            const clampB: ExecutionScopeSpec = {
              schema: SCHEMA,
              verbs: sc.clampVerbB,
              ...(sc.clampRowFilterB.length > 0
                ? { rowFilter: sc.clampRowFilterB }
                : {}),
              ...(sc.clampFieldMaskB ? { fieldMask: sc.clampFieldMaskB } : {}),
            };
            const decision = decide(
              identityFor({
                kind: "agent",
                mayAct: true,
                scopeClamp: [clampA, clampB],
              }),
              sc.table,
              sc.verb
            );
            // The construction covers the verb on both layers, so it allows.
            assert(decision.decision === "allow");
            allows++;

            // The returned rowFilter is EXACTLY the covering clamp clauses.
            expect(decision.rowFilter.map(clauseKey).sort()).toStrictEqual(
              [
                ...new Set(
                  [...sc.clampRowFilterA, ...sc.clampRowFilterB].map(clauseKey)
                ),
              ].sort()
            );

            // The fieldMask is exactly the intersection of the covering scopes'
            // masks; order-normalized so only the set is asserted.
            expect(sortedMask(decision.fieldMask)).toStrictEqual(
              sortedMask(intersectMasks(sc.clampFieldMaskA, sc.clampFieldMaskB))
            );
          });
        }
      ),
      { numRuns: 300, seed: 8643 }
    );
    expect(allows).toBeGreaterThan(0);
  });

  // [law:consent-reveal-never-rides] No standing answer ever confers reveal
  // (#873, AP-locker-boundary): an automation is refused reveal whatever it
  // holds, and a clamp scope carrying only "reveal" satisfies no read or act.
  test("[law:consent-reveal-never-rides] reveal rides no standing answer and a reveal scope rides nothing else", () => {
    // (a) An automation is NEVER allowed reveal, however broad the answer and
    //     the clamp: a sealed reveal is Locker's permit, not an answer.
    let revealDenies = 0;
    fc.assert(
      fc.property(
        fc.record({
          table: arbTable,
          answers: fc.array(arbAnswerRaw, { minLength: 1, maxLength: 3 }),
          clampScopes: fc.array(arbClampRaw, { minLength: 1, maxLength: 3 }),
        }),
        (sc) => {
          inTxn(() => {
            seedAnswer([
              { schema: SCHEMA, verbs: "reveal" },
              { schema: SCHEMA, verbs: "read+act" },
              ...sc.answers.map(toScope),
            ]);
            const decision = decide(
              identityFor({
                kind: "agent",
                mayAct: true,
                scopeClamp: [
                  { schema: SCHEMA, verbs: "reveal" },
                  ...sc.clampScopes.map(toScope),
                ],
              }),
              sc.table,
              "reveal"
            );
            expect(decision.decision).toBe("deny");
            revealDenies++;
          });
        }
      ),
      { numRuns: 200, seed: 8644 }
    );
    expect(revealDenies).toBeGreaterThan(0);

    // (b) A clamp that carries ONLY "reveal" denies every read/act request —
    //     the clamp refuses before any answer is consulted.
    fc.assert(
      fc.property(
        fc.constantFrom<RequestVerb>("read", "act"),
        arbTable,
        (verb, table) => {
          inTxn(() => {
            seedAnswer([{ schema: SCHEMA, verbs: "read+act" }]);
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

  // [law:consent-standing-answer-required] Replaces
  // `consent-explicit-scope-unbypassable`, whose minimization policy left the
  // vault with the `access_policy` table (#928). The unbypassability it
  // protected is now stated where the plane actually decides: nobody but the
  // owner's own device reaches anything without a live `granted` row covering
  // the entity for the verb, and naming a first-party SURFACE buys nothing —
  // `Identity.surface` is attribution, never authority.
  test("[law:consent-standing-answer-required] no answer, no allow — and a surface claim confers nothing", () => {
    let agentDenies = 0;
    let surfaceAllows = 0;
    fc.assert(
      fc.property(
        arbRequestVerb.chain((verb) =>
          fc.record({
            verb: fc.constant(verb),
            table: arbTable,
            clampVerb: coveringVerbFor(verb),
          })
        ),
        (sc) => {
          inTxn(() => {
            const clamp: ExecutionScopeSpec[] = [
              { schema: SCHEMA, verbs: sc.clampVerb },
            ];
            // No answer at all: a fully covering clamp allows nothing.
            const denied = decide(
              identityFor({ kind: "agent", mayAct: true, scopeClamp: clamp }),
              sc.table,
              sc.verb
            );
            assert(denied.decision === "deny");
            expect(denied.failing).toContain("no standing answer");
            expect(denied.authorityId).toBeNull();
            agentDenies++;

            // A surface reaches EXACTLY what the owner device reaches — the
            // same decision, with no answer row of its own and none needed.
            const bare = decide(
              identityFor({ kind: "owner-device", mayAct: true }),
              sc.table,
              sc.verb
            );
            const surfaced = decide(
              identityFor({ kind: "surface", mayAct: true }),
              sc.table,
              sc.verb
            );
            expect(normDecision(surfaced)).toStrictEqual(normDecision(bare));
            if (surfaced.decision === "allow") surfaceAllows++;
          });
        }
      ),
      { numRuns: 150, seed: 8646 }
    );
    expect(agentDenies).toBeGreaterThan(0);
    expect(surfaceAllows).toBeGreaterThan(0);
  });

  // [law:consent-onbehalf-cap-precedes-grants] When onBehalfOfOwner.mayAct is
  // false, no standing answer produces an allow for act/reveal, and the deny
  // names the owner id — checked before any answer is consulted (authorityId
  // is null).
  test("[law:consent-onbehalf-cap-precedes-grants] a non-owning acting owner caps act/reveal before answers, naming the owner", () => {
    fc.assert(
      fc.property(
        fc.record({
          verb: fc.constantFrom<RequestVerb>("act", "reveal"),
          table: arbTable,
          ownerId: fc.string({ minLength: 1, maxLength: 16 }),
          answers: fc.array(arbAnswerRaw, { maxLength: 3 }),
          clampScopes: fc.array(arbClampRaw, { maxLength: 3 }),
        }),
        (sc) => {
          inTxn(() => {
            // A maximal answer + covering clamp: the cap must bite regardless.
            seedAnswer([
              { schema: SCHEMA, verbs: "read+act" },
              { schema: SCHEMA, verbs: "reveal" },
              ...sc.answers.map(toScope),
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
            expect(decision.authorityId).toBeNull();
          });
        }
      ),
      { numRuns: 200, seed: 8647 }
    );
  });
});
