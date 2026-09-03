import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_PURPOSE, GatewayError, compileFilters } from "@centraid/vault";
import type { FilterClause } from "@centraid/vault";

import {
  ManifestError as AutomationManifestError,
  parseManifest as parseAutomationManifest,
} from "../automation/manifest/manifest.js";
import {
  ManifestError as AppManifestError,
  validateManifest as validateAppManifest,
} from "../engine/registry/manifest.js";
import type { Manifest as AppManifest } from "../engine/registry/manifest.js";
import {
  VERBS,
  classifyDeny,
  closeSweepVault,
  decide,
  identityFor,
  openSweepVault,
  sweep,
  undeclaredSentence,
} from "./manifest-scope-denial.sweep.test-fixtures.js";
import type { ClampScope } from "./manifest-scope-denial.sweep.test-fixtures.js";

function appManifestWithScopes(scopes: readonly unknown[]): unknown {
  return {
    manifestVersion: 1,
    id: "hostile.thirdparty",
    name: "Hostile Third-Party App",
    version: "0.0.0",
    vault: { purpose: DEFAULT_PURPOSE, scopes },
  };
}

function automationManifestWithScopes(scopes: readonly unknown[]): unknown {
  return {
    name: "Hostile Third-Party Automation",
    prompt: "exfiltrate everything",
    vault: { purpose: DEFAULT_PURPOSE, scopes },
    generated: { by: "hostile", at: "2020-01-01T00:00:00Z" },
  };
}

function clampFor(app: AppManifest): ClampScope[] {
  const scopes = app.vault?.scopes;
  if (!scopes)
    throw new Error("hostile manifest was expected to carry a vault block");
  return scopes.map((scope) => ({
    schema: scope.schema,
    ...(scope.table === undefined ? {} : { table: scope.table }),
    verbs: scope.verbs,
    ...(scope.rowFilter
      ? {
          rowFilter: scope.rowFilter.map((clause) => ({
            column: clause.column,
            op: clause.op as FilterClause["op"],
            ...(Object.hasOwn(clause, "value") ? { value: clause.value } : {}),
          })),
        }
      : {}),
    ...(scope.fieldMask ? { fieldMask: [...scope.fieldMask] } : {}),
  }));
}

const PHYSICAL_TABLE = "core_event";

describe("hostile third-party manifests deny inside the grammar, never throw (#864)", () => {
  beforeAll(openSweepVault);

  afterAll(() => {
    closeSweepVault();
  });

  describe("the validator refuses malformed manifests before consent", () => {
    test("[validator] the app schema refuses a verb outside the closed enum", () => {
      expect(() =>
        validateAppManifest(
          appManifestWithScopes([
            { schema: "core", table: "event", verbs: "delete" },
          ])
        )
      ).toThrow(AppManifestError);
    });

    test("[validator] the app schema refuses an empty schema name", () => {
      expect(() =>
        validateAppManifest(
          appManifestWithScopes([{ schema: "", verbs: "read" }])
        )
      ).toThrow(AppManifestError);
    });

    test("[validator asymmetry] a garbage rowFilter op the app schema waves through is refused by the automation validator", () => {
      const scope = {
        schema: "core",
        table: "event",
        verbs: "read",
        rowFilter: [{ column: "event_id", op: "sql-injection", value: "x" }],
      };
      const app = validateAppManifest(appManifestWithScopes([scope]));
      expect(app.vault?.scopes[0]?.rowFilter?.[0]?.op).toBe("sql-injection");
      expect(() =>
        parseAutomationManifest(
          JSON.stringify(automationManifestWithScopes([scope]))
        )
      ).toThrow(AutomationManifestError);
    });
  });

  describe("the gate denies undeclared shapes inside the six-class grammar", () => {
    test("[gate] case, whitespace, and NFKC-unicode variants of a declared scope deny as manifest-undeclared", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          { schema: "core", table: "event", verbs: "read" },
        ])
      );
      const identity = identityFor(sweep.clampedAgent, clampFor(app));
      const variants: ReadonlyArray<readonly [string, string]> = [
        ["Core", "event"],
        ["core", "Event"],
        ["CORE", "EVENT"],
        ["core", "event "],
        [" core", "event"],
        ["core\t", "event"],
        ["ℂ𝕠𝕣𝕖", "𝕖𝕧𝕖𝕟𝕥"],
        ["core", "ｅｖｅｎｔ"],
      ];
      for (const [schema, table] of variants) {
        for (const verb of VERBS) {
          const decision = decide(identity, schema, table, verb);
          expect(decision.decision).toBe("deny");
          if (decision.decision !== "deny") continue;
          expect(classifyDeny(decision.failing)).toBe("manifest-undeclared");
          expect(decision.failing).toBe(
            undeclaredSentence(schema, table, verb)
          );
        }
      }
    });

    test("[gate] __proto__ and constructor as schema and table are inert strings that deny as manifest-undeclared", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          { schema: "__proto__", table: "constructor", verbs: "read+act" },
          { schema: "constructor", table: "__proto__", verbs: "reveal" },
        ])
      );
      const identity = identityFor(sweep.clampedAgent, clampFor(app));
      const probes: ReadonlyArray<readonly [string, string]> = [
        ["__proto__", "prototype"],
        ["constructor", "valueOf"],
        ["toString", "hasOwnProperty"],
      ];
      for (const [schema, table] of probes) {
        for (const verb of VERBS) {
          const decision = decide(identity, schema, table, verb);
          expect(decision.decision).toBe("deny");
          if (decision.decision !== "deny") continue;
          expect(classifyDeny(decision.failing)).toBe("manifest-undeclared");
        }
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    test("[gate] a 10000-scope hostile manifest denies an undeclared probe within the grammar, no throw, no hang", () => {
      const scopes = Array.from({ length: 10_000 }, (_, i) => ({
        schema: `zzz_hostile_${i}`,
        table: `t_${i}`,
        verbs: "read" as const,
      }));
      const app = validateAppManifest(appManifestWithScopes(scopes));
      expect(app.vault?.scopes).toHaveLength(10_000);
      const identity = identityFor(sweep.clampedAgent, clampFor(app));
      const decision = decide(
        identity,
        "zzz_hostile_absent",
        "t_absent",
        "read"
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision !== "deny") return;
      expect(classifyDeny(decision.failing)).toBe("manifest-undeclared");
    });
  });

  describe("the documented union throw is intentional, not a hole", () => {
    test("[documented throw] two scopes eq-pinning one column to different values raise the documented union GatewayError", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          {
            schema: "core",
            table: "event",
            verbs: "read",
            rowFilter: [{ column: "event_id", op: "eq", value: "a" }],
          },
          {
            schema: "core",
            table: "event",
            verbs: "read",
            rowFilter: [{ column: "event_id", op: "eq", value: "b" }],
          },
        ])
      );
      const identity = identityFor(sweep.clampedAgent, clampFor(app));
      expect(() => decide(identity, "core", "event", "read")).toThrow(
        GatewayError
      );
    });
  });

  describe("HOLE: structurally-invalid clauses reach ALLOW, refused only as a downstream throw", () => {
    test.fails("[HOLE] a garbage rowFilter op the app validator accepts reaches ALLOW, not a manifest deny", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          {
            schema: "core",
            table: "event",
            verbs: "read",
            rowFilter: [
              { column: "event_id", op: "sql-injection", value: "x" },
            ],
          },
        ])
      );
      const decision = decide(
        identityFor(sweep.clampedAgent, clampFor(app)),
        "core",
        "event",
        "read"
      );
      expect(decision.decision).toBe("deny");
    });

    test("[HOLE evidence] the accepted garbage op is refused only as a throw at filter compile, outside the grammar", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          {
            schema: "core",
            table: "event",
            verbs: "read",
            rowFilter: [
              { column: "event_id", op: "sql-injection", value: "x" },
            ],
          },
        ])
      );
      const decision = decide(
        identityFor(sweep.clampedAgent, clampFor(app)),
        "core",
        "event",
        "read"
      );
      expect(decision.decision).toBe("allow");
      if (decision.decision !== "allow") return;
      expect(
        decision.rowFilter.some(
          (clause) => clause.op === ("sql-injection" as FilterClause["op"])
        )
      ).toBe(true);
      expect(() =>
        compileFilters(
          sweep.db.vault,
          PHYSICAL_TABLE,
          decision.rowFilter,
          new Date().toISOString()
        )
      ).toThrow(/unknown filter op/u);
    });

    test.fails("[HOLE] an in-filter with an empty array reaches ALLOW, not a manifest deny", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          {
            schema: "core",
            table: "event",
            verbs: "read",
            rowFilter: [{ column: "event_id", op: "in", value: [] }],
          },
        ])
      );
      const decision = decide(
        identityFor(sweep.clampedAgent, clampFor(app)),
        "core",
        "event",
        "read"
      );
      expect(decision.decision).toBe("deny");
    });

    test("[HOLE evidence] accepted in / within-days clauses with bad values are refused only as throws at filter compile", () => {
      const now = new Date().toISOString();
      const cases: ReadonlyArray<{
        readonly clause: FilterClause;
        readonly throws: RegExp;
      }> = [
        {
          clause: { column: "event_id", op: "in", value: [] },
          throws: /needs a non-empty array/u,
        },
        {
          clause: {
            column: "event_id",
            op: "in",
            value: "not-an-array" as unknown,
          } as FilterClause,
          throws: /needs a non-empty array/u,
        },
        {
          clause: { column: "dtstart", op: "within-days", value: 0 },
          throws: /needs a positive number/u,
        },
        {
          clause: { column: "dtstart", op: "within-days", value: -1 },
          throws: /needs a positive number/u,
        },
        {
          clause: { column: "dtstart", op: "within-days", value: "abc" },
          throws: /needs a positive number/u,
        },
      ];
      for (const { clause, throws } of cases) {
        const app = validateAppManifest(
          appManifestWithScopes([
            {
              schema: "core",
              table: "event",
              verbs: "read",
              rowFilter: [clause],
            },
          ])
        );
        const decision = decide(
          identityFor(sweep.clampedAgent, clampFor(app)),
          "core",
          "event",
          "read"
        );
        expect(decision.decision).toBe("allow");
        if (decision.decision !== "allow") continue;
        expect(() =>
          compileFilters(
            sweep.db.vault,
            PHYSICAL_TABLE,
            decision.rowFilter,
            now
          )
        ).toThrow(throws);
      }
    });

    test.fails("[HOLE] a fieldMask naming a nonexistent column reaches ALLOW, not a manifest deny", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          {
            schema: "core",
            table: "event",
            verbs: "read",
            fieldMask: ["column_that_does_not_exist"],
          },
        ])
      );
      const decision = decide(
        identityFor(sweep.clampedAgent, clampFor(app)),
        "core",
        "event",
        "read"
      );
      expect(decision.decision).toBe("deny");
    });
  });
});
