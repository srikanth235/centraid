/*
 * Hostile (non-bundled) manifest scope-denial — the fourth sibling (#864 M5).
 *
 * The three `manifest-scope-denial.{sweep,closed-grammar,fuzz}` suites (issue
 * #839 G4) prove one thing about the 37 TRUSTED manifests the repo ships: every
 * scope they declare is evaluable, every scope they do not declare denies
 * closed inside the six-class grammar. They prove NOTHING about a manifest a
 * third-party / attacker app author writes — a shape no bundled `app.json`
 * happens to contain.
 *
 * This suite closes that half. It builds synthetic manifests IN MEMORY (never
 * on disk — they must never be mistaken for a bundled template), pushes each
 * through the REAL runtime validators (`validateManifest` for `app.json`,
 * `parseManifest` for `automation.json`), turns the survivors into the same
 * `scopeClamp` the production seam builds, and drives `evaluateAccess`. The
 * fixture, oracles, and vault are imported wholesale from the sweep — the one
 * enrolled clamped agent already holds the deliberately-maximal durable grant,
 * so every refusal here is attributable to the manifest layer and nothing else.
 *
 * The contract this suite pins is: a hostile manifest is refused by exactly one
 * of two named layers, never by an uncaught throw inside consent and never by a
 * silent allow —
 *
 *   • the VALIDATOR refuses it — a `ManifestError` at parse time, before the
 *     manifest ever reaches consent, or
 *   • the GATE denies it — a `decision:"deny"` whose sentence classifies into
 *     one of the six `DENY_CLASSES`.
 *
 * Where the current code does neither — where a structurally-invalid rowFilter
 * or fieldMask the app schema waves through reaches an ALLOW and is refused only
 * later, as a bare Error at filter-compile time (`gateway/filters.ts`), outside
 * the receipt grammar — that is a HOLE, characterized here with `test.fails`
 * plus a filed note rather than patched (the pin doctrine: this slice does not
 * touch `filters.ts`). See FILED NOTE at the foot of this file.
 */

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

/* ------------------------------------------------------------------ *
 * In-memory hostile manifests, and the clamp the seam derives from them.
 * ------------------------------------------------------------------ */

/** A minimal but real `app.json` object carrying the given vault scopes. */
function appManifestWithScopes(scopes: readonly unknown[]): unknown {
  return {
    manifestVersion: 1,
    id: "hostile.thirdparty",
    name: "Hostile Third-Party App",
    version: "0.0.0",
    vault: { purpose: DEFAULT_PURPOSE, scopes },
  };
}

/** A minimal but real `automation.json` object carrying the given vault scopes. */
function automationManifestWithScopes(scopes: readonly unknown[]): unknown {
  return {
    name: "Hostile Third-Party Automation",
    prompt: "exfiltrate everything",
    vault: { purpose: DEFAULT_PURPOSE, scopes },
    generated: { by: "hostile", at: "2020-01-01T00:00:00Z" },
  };
}

/**
 * The clamp the production seam (`vault-plane.ts` `agentBridgeFor`) copies out
 * of a validated manifest — structurally identical to the manifest's own
 * scopes, with the opaque `op` string carried through unchanged (which is
 * precisely how an unknown op survives to filter-compile time).
 */
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

/** The real physical table + column the sweep vault bootstraps — used to drive
 *  an escaped clause into `compileFilters` and observe the downstream throw. */
const PHYSICAL_TABLE = "core_event";

describe("hostile third-party manifests deny inside the grammar, never throw (#864)", () => {
  beforeAll(openSweepVault);

  afterAll(() => {
    closeSweepVault();
  });

  /* ---------------------------------------------------------------- *
   * Layer 1 — the VALIDATOR refuses the manifest before consent sees it.
   * ---------------------------------------------------------------- */
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
      // The app manifest schema types `op` as a bare non-empty string (no
      // enum), so it ACCEPTS the garbage op — this is the defense gap.
      const app = validateAppManifest(appManifestWithScopes([scope]));
      expect(app.vault?.scopes[0]?.rowFilter?.[0]?.op).toBe("sql-injection");
      // The automation validator checks `op` against VAULT_FILTER_OPS and
      // REFUSES the same clause — defense the app path lacks.
      expect(() =>
        parseAutomationManifest(
          JSON.stringify(automationManifestWithScopes([scope]))
        )
      ).toThrow(AutomationManifestError);
    });
  });

  /* ---------------------------------------------------------------- *
   * Layer 2 — the GATE denies, inside the six-class grammar.
   * ---------------------------------------------------------------- */
  describe("the gate denies undeclared shapes inside the six-class grammar", () => {
    test("[gate] case, whitespace, and NFKC-unicode variants of a declared scope deny as manifest-undeclared", () => {
      const app = validateAppManifest(
        appManifestWithScopes([
          { schema: "core", table: "event", verbs: "read" },
        ])
      );
      const identity = identityFor(sweep.clampedAgent, clampFor(app));
      // Every entry is a distinct byte string from "core"/"event"; consent
      // compares with === and never a normalizer, so none of them widen into
      // the declared scope — each denies as manifest-undeclared.
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
      // A hostile author who names scopes __proto__.constructor gets no
      // prototype pollution and no privileged match — the clamp treats the
      // names as ordinary strings and compares them with ===.
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
      // The object the clamp was built from did not pollute Object.prototype.
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
      // An entity none of the 10000 scopes names denies at the clamp, in
      // grammar — no per-scope work escapes as a throw and the walk terminates.
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

  /* ---------------------------------------------------------------- *
   * The one documented throw — a union the clamp vocabulary cannot express.
   * ---------------------------------------------------------------- */
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
      // executionClamp's conflictingPin refuses this loudly — a bounded union
      // must be one `in` filter, not two eq scopes. It is a throw OUTSIDE the
      // six-class deny grammar, but a DOCUMENTED, intentional one, pinned as
      // such by the fuzz sibling ("the one throw is the documented pin
      // conflict"). Named here so it is not mistaken for the holes below.
      expect(() => decide(identity, "core", "event", "read")).toThrow(
        GatewayError
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * HOLES — consent carries rowFilter/fieldMask contents OPAQUELY. It grades
   * schema/table/verb coverage only; op / value / column validity is never a
   * consent-layer concern, so a structurally-invalid clause the app schema
   * accepts reaches an ALLOW and is refused only later, as a bare Error at
   * filter-compile time. Characterized with test.fails; see the FILED NOTE.
   * ---------------------------------------------------------------- */
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
      // DESIRED (why this is test.fails): the manifest layer should refuse an
      // op outside its own vocabulary as a deny inside the six-class grammar.
      // ACTUAL: consent returns ALLOW carrying the clause, so this fails.
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
      // Baseline restated: the hole is an allow, not a deny.
      expect(decision.decision).toBe("allow");
      if (decision.decision !== "allow") return;
      // The garbage op survives verbatim into the allow's rowFilter …
      expect(
        decision.rowFilter.some(
          (clause) => clause.op === ("sql-injection" as FilterClause["op"])
        )
      ).toBe(true);
      // … and is refused only downstream, as a bare Error at compile — never a
      // classifiable consent deny.
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
        // Consent ALLOWS every one of these — the value is never inspected.
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
      // The bogus mask is carried into the allow and is refused only at
      // applyFieldMask compile ("field mask excludes every column"), a bare
      // Error outside the grammar — same opaque-passthrough root cause.
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

/*
 * FILED NOTE (#864 M5) — the manifest clamp does not validate rowFilter/fieldMask contents.
 *
 * `executionClamp` (packages/vault/src/gateway/access.ts) grades a request by
 * schema + table + verb coverage only. A scope's `rowFilter` op/value and
 * `fieldMask` columns are carried into the ALLOW decision opaquely — the sole
 * content check is `conflictingPin`, which refuses two differing eq/in pins on
 * one column with a documented `GatewayError`. Every OTHER malformed clause
 * (an op outside {eq,ne,lt,lte,gt,gte,in,is-null,not-null,within-days,
 * within-next-days}, an `in` with an empty or non-array value, a `within-days`
 * with a non-positive/NaN value, a `fieldMask` naming a column that does not
 * exist) passes consent as an ALLOW and is refused only later, as a bare
 * `Error` thrown by `gateway/filters.ts` (`unknown filter op`, `op "in" needs a
 * non-empty array`, `unknown column`, `field mask excludes every column`) — a
 * refusal OUTSIDE the six `DENY_CLASSES` receipt grammar.
 *
 * For the BUNDLED manifests this is invisible: they are trusted and only ever
 * declare the known ops. For a hostile third-party manifest it means the app
 * manifest validator (engine/registry/manifest.ts), which types `op` as a bare
 * `{type:"string", minLength:1}`, is a strictly weaker gate than the automation
 * validator (automation/manifest/manifest.ts), which enforces VAULT_FILTER_OPS.
 * The fix — reject unknown ops / structurally-invalid clause values in the app
 * manifest schema so refusal happens at validate time (Layer 1), never as an
 * uncaught compile throw — is NOT applied in this slice per the pin doctrine
 * (this slice does not touch filters.ts or the manifest schema). The three
 * test.fails above are the characterization; convert them to plain asserts when
 * the app validator gains op/value/mask validation.
 */
