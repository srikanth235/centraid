/*
 * The bundled-manifest scope-denial sweep (#839) — part 1 of 3.
 *
 * Loading checks and the positive half: every declared scope × verb is
 * evaluable and allowed. The shared loader, oracles, and vault fixture live in
 * `manifest-scope-denial.sweep.test-fixtures.ts`; the negative-grammar half is in
 * `manifest-scope-denial.closed-grammar.test.ts` and the property fuzz in
 * `manifest-scope-denial.fuzz.test.ts`. See the fixtures header for why the
 * grant is maximal and why the sweep lives in `packages/server`.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_PURPOSE } from "@centraid/vault";

import {
  ALIEN_SCHEMA,
  ALIEN_TABLE,
  MANIFESTS,
  PROBE_TABLE,
  closeSweepVault,
  decide,
  identityFor,
  openSweepVault,
  sweep,
  verbsOf,
} from "./manifest-scope-denial.sweep.test-fixtures.js";

describe("bundled manifest scope-denial sweep (#839 G4)", () => {
  beforeAll(openSweepVault);

  afterAll(() => {
    closeSweepVault();
  });

  test("the sweep loaded every bundled manifest through its real validator", () => {
    // A regression here means the template tree moved and the sweep is silently
    // scanning fewer manifests — the exact way a tripwire rots to green.
    expect({
      apps: MANIFESTS.filter((m) => m.kind === "apps").length,
      automations: MANIFESTS.filter((m) => m.kind === "automations").length,
      withScopes: MANIFESTS.filter((m) => m.scopes.length > 0).length,
      declaredScopes: MANIFESTS.reduce((n, m) => n + m.scopes.length, 0),
    }).toStrictEqual({
      apps: 8,
      automations: 29,
      // `release-notes-drafter` declares no vault block at all — see its own
      // case below, which pins what that means for consent.
      withScopes: 36,
      // +20 for Locker's #872 surface: five sidecar reads (alias, fields,
      // addresses, passkey, history), two content-spine reads for attachments,
      // one row-filtered read of `consent.receipt` for access history, ten new
      // locker acts, and attach/detach.
      declaredScopes: 278,
    });
    // Every scope-carrying manifest rides the one defaulted DPV purpose.
    expect([
      ...new Set(
        MANIFESTS.filter((m) => m.scopes.length > 0).map((m) => m.purpose)
      ),
    ]).toStrictEqual([DEFAULT_PURPOSE]);
  });

  test("the negative probes really are undeclared everywhere", () => {
    const schemas = new Set(
      MANIFESTS.flatMap((m) => m.scopes.map((s) => s.schema))
    );
    const tables = new Set(
      MANIFESTS.flatMap((m) => m.scopes.map((s) => s.table ?? ""))
    );
    expect(schemas.has(ALIEN_SCHEMA)).toBe(false);
    expect(tables.has(ALIEN_TABLE)).toBe(false);
    expect(tables.has(PROBE_TABLE)).toBe(false);
  });

  describe("every declared scope × verb is evaluable and allowed", () => {
    test.each(MANIFESTS.map((m) => [m.label, m] as const))(
      "%s",
      (_label, manifest) => {
        const identity = identityFor(sweep.clampedAgent, manifest.scopes);
        let allowed = 0;
        for (const scope of manifest.scopes) {
          const table = scope.table ?? PROBE_TABLE;
          for (const verb of verbsOf(scope.verbs)) {
            const decision = decide(identity, scope.schema, table, verb);
            expect(
              decision.decision,
              `${manifest.label} declares ${scope.schema}.${table} for ${verb} but consent said ` +
                `${decision.decision === "deny" ? decision.failing : "allow"}`
            ).toBe("allow");
            if (decision.decision === "allow") allowed += 1;
          }
        }
        // Counted rather than merely looped: a manifest whose scopes vanished
        // (or that declares none, like `release-notes-drafter`) must say so as
        // a number, not as a silently empty loop body.
        expect(allowed).toBe(
          manifest.scopes.reduce((n, s) => n + verbsOf(s.verbs).length, 0)
        );
      }
    );

    test("a declared rowFilter/fieldMask reaches the allow decision intact", () => {
      // The bundled manifests that anchor a schema-wide read: people and tally
      // each attenuate `core.entity_revision` to their own entity type, and
      // locker (#872) attenuates `consent.receipt` to its own object types so
      // an access-history grant is "my own reveals", not a key to the vault's
      // whole receipt stream. That one matters more than the other two: the
      // gateway's structural per-entity guard covers `consent.provenance`
      // only, so for `consent.receipt` this rowFilter IS the boundary.
      const anchored = MANIFESTS.filter((manifest) =>
        manifest.scopes.some((scope) => scope.rowFilter !== undefined)
      );
      expect(anchored.map((m) => m.label)).toStrictEqual([
        "apps/locker",
        "apps/people",
        "apps/tally",
      ]);
      for (const manifest of anchored) {
        const scope = manifest.scopes.find((s) => s.rowFilter !== undefined);
        if (!scope?.table) throw new Error("anchored scope must name a table");
        const decision = decide(
          identityFor(sweep.clampedAgent, manifest.scopes),
          scope.schema,
          scope.table,
          "read"
        );
        expect(decision).toMatchObject({
          decision: "allow",
          rowFilter: expect.arrayContaining([...(scope.rowFilter ?? [])]),
        });
      }
    });
  });
});
