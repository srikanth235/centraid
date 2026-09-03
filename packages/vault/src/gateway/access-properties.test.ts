// governance: allow-repo-hygiene file-size-limit #864 cohesive security property suite for one module

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

function coveringVerbFor(verb: RequestVerb): fc.Arbitrary<ScopeVerb> {
  if (verb === "reveal") return fc.constant("reveal");
  if (verb === "read") return fc.constantFrom("read", "read+act");
  return fc.constantFrom("act", "read+act");
}

const arbNullClause: fc.Arbitrary<FilterClause> = fc.record({
  column: arbColumn,
  op: fc.constantFrom<"is-null" | "not-null">("is-null", "not-null"),
});

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

            expect(after.decision === "allow" ? before.decision : "allow").toBe(
              "allow"
            );
          });
        }
      ),
      { numRuns: 250, seed: 8641 }
    );
    expect(seen.allowBefore).toBeGreaterThan(0);
    expect(seen.flips).toBeGreaterThan(0);
  });

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
            expect(normDecision(perm)).toStrictEqual(normDecision(base));
          });
        }
      ),
      { numRuns: 250, seed: 8642 }
    );
    expect(allows).toBeGreaterThan(0);
  });

  test("[law:consent-clamp-only-narrows] an allow's rowFilter is a superset and its fieldMask the exact intersection", () => {
    let allows = 0;
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
            assert(decision.decision === "allow");
            allows++;

            const returned = new Set(decision.rowFilter.map(clauseKey));
            expect(
              [...sc.grantRowFilter, ...sc.clampRowFilter].every((clause) =>
                returned.has(clauseKey(clause))
              )
            ).toBe(true);

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

  test("[law:consent-reveal-never-rides] reveal requires reveal on both layers and a reveal scope rides nothing else", () => {
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

            const wholeGrant = seedGrant([
              { schema: SCHEMA, verbs: sc.grantVerb },
            ]);
            const denied = decide(identity, sc.table, sc.verb);
            assert(denied.decision === "deny");
            expect(denied.failing).toContain("no grant_scope covers");
            denies++;

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
