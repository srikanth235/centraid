import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";
import { GatewayError } from "@centraid/vault";

import {
  ALIEN_SCHEMA,
  ALIEN_TABLE,
  DENY_CLASSES,
  MANIFESTS,
  PROBE_TABLE,
  VERBS,
  clampCovers,
  classifyDeny,
  closeSweepVault,
  decide,
  identityFor,
  openSweepVault,
  sweep,
  undeclaredSentence,
} from "./manifest-scope-denial.sweep.test-fixtures.js";
import type { ClampScope } from "./manifest-scope-denial.sweep.test-fixtures.js";

describe("bundled manifest scope-denial sweep (#839 G4)", () => {
  beforeAll(openSweepVault);

  afterAll(() => {
    closeSweepVault();
  });

  describe("fuzz: arbitrary clamps and requests fail closed, never throw, never widen", () => {
    const declaredSchemas = [
      ...new Set(MANIFESTS.flatMap((m) => m.scopes.map((s) => s.schema))),
    ].toSorted();
    const declaredTables = [
      ...new Set(
        MANIFESTS.flatMap((m) =>
          m.scopes.flatMap((s) => (s.table === undefined ? [] : [s.table]))
        )
      ),
    ].toSorted();

    const arbVerbs = fc.constantFrom<ClampScope["verbs"][]>(
      "read",
      "act",
      "read+act",
      "reveal"
    );
    const arbName = fc.oneof(
      fc.constantFrom(...declaredSchemas, ...declaredTables),
      fc.constantFrom(ALIEN_SCHEMA, ALIEN_TABLE, PROBE_TABLE, ""),
      fc.string({ maxLength: 24 })
    );
    const arbScope: fc.Arbitrary<ClampScope> = fc.record(
      {
        schema: arbName,
        table: fc.option(arbName, { nil: undefined }),
        verbs: arbVerbs,
      },
      { requiredKeys: ["schema", "verbs"] }
    );

    test("an arbitrary clamp allows EXACTLY what it covers — no more, no less", () => {
      fc.assert(
        fc.property(
          fc.array(arbScope, { maxLength: 6 }),
          arbName,
          arbName,
          fc.constantFrom(...VERBS),
          (scopes, schema, table, verb) => {
            const decision = decide(
              identityFor(sweep.clampedAgent, scopes),
              schema,
              table,
              verb
            );
            const covered = clampCovers(scopes, schema, table, verb);
            const refusedByManifest =
              decision.decision === "deny" &&
              decision.failing === undeclaredSentence(schema, table, verb);
            expect(
              refusedByManifest,
              `${schema}.${table}/${verb} covered=${covered} decision=${
                decision.decision === "deny" ? decision.failing : "allow"
              }`
            ).toBe(!covered);
          }
        ),
        { numRuns: 300 }
      );
    });

    test("every decision classifies into the closed grammar and never throws", () => {
      fc.assert(
        fc.property(
          fc.array(arbScope, { maxLength: 6 }),
          arbName,
          arbName,
          fc.constantFrom(...VERBS),
          fc.boolean(),
          (scopes, schema, table, verb, mayAct) => {
            const identity = identityFor(sweep.clampedAgent, scopes, {
              mayAct,
            });
            const decision = decide(identity, schema, table, verb);
            const outcome =
              decision.decision === "allow"
                ? "allow"
                : classifyDeny(decision.failing);
            expect(["allow", ...DENY_CLASSES]).toContain(outcome);
          }
        ),
        { numRuns: 300 }
      );
    });

    test("verb escalation off a real manifest is always refused by the clamp", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...MANIFESTS.filter((m) => m.scopes.length > 0)),
          fc.nat(),
          fc.constantFrom(...VERBS),
          (manifest, index, verb) => {
            const scope = manifest.scopes[index % manifest.scopes.length];
            if (!scope) return;
            const table = scope.table ?? PROBE_TABLE;
            const decision = decide(
              identityFor(sweep.clampedAgent, manifest.scopes),
              scope.schema,
              table,
              verb
            );
            expect(decision).toMatchObject(
              clampCovers(manifest.scopes, scope.schema, table, verb)
                ? { decision: "allow" }
                : {
                    decision: "deny",
                    failing: undeclaredSentence(scope.schema, table, verb),
                    grantId: null,
                  }
            );
          }
        ),
        { numRuns: 300 }
      );
    });

    test("a malformed clamp entry denies rather than throwing — the one throw is the documented pin conflict", () => {
      const malformed: ClampScope[] = [
        { schema: "", verbs: "read" },
        { schema: "  ", table: "", verbs: "act" },
        { schema: "core event", verbs: "reveal" },
        { schema: "ℂ𝕠𝕣𝕖", table: "𝕖𝕧𝕖𝕟𝕥", verbs: "read+act" },
        { schema: "x".repeat(4096), verbs: "read" },
      ];
      for (const verb of VERBS) {
        const decision = decide(
          identityFor(sweep.clampedAgent, malformed),
          "core",
          "event",
          verb
        );
        expect(decision).toMatchObject({
          decision: "deny",
          failing: undeclaredSentence("core", "event", verb),
        });
      }
      const pin = (value: string): ClampScope => ({
        schema: "core",
        table: "event",
        verbs: "read",
        rowFilter: [{ column: "event_id", op: "eq", value }],
      });
      expect(() =>
        decide(
          identityFor(sweep.clampedAgent, [pin("a"), pin("b")]),
          "core",
          "event",
          "read"
        )
      ).toThrow(GatewayError);
    });
  });
});
