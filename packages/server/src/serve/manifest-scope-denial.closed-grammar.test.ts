/*
 * The bundled-manifest scope-denial sweep (issue #839, G4) — part 2 of 3.
 *
 * The negative half: every undeclared combination fails CLOSED with the exact
 * grammar, and one positive case per deny class proves the closed grammar is
 * the whole vocabulary. Loader, oracles, and vault fixture live in
 * `manifest-scope-denial.sweep-fixtures.ts`; the positive half is in
 * `manifest-scope-denial.sweep.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_PURPOSE, uuidv7 } from "@centraid/vault";

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
} from "./manifest-scope-denial.sweep-fixtures.js";
import type {
  ClampScope,
  DenyClass,
  Verb,
} from "./manifest-scope-denial.sweep-fixtures.js";

describe("bundled manifest scope-denial sweep (#839 G4)", () => {
  beforeAll(openSweepVault);

  afterAll(() => {
    closeSweepVault();
  });

  describe("every undeclared combination fails CLOSED with the exact grammar", () => {
    test.each(MANIFESTS.map((m) => [m.label, m] as const))(
      "%s",
      (_label, manifest) => {
        const identity = identityFor(sweep.clampedAgent, manifest.scopes);
        /** What consent actually said, flattened to one comparable line. */
        const observed = (
          schema: string,
          table: string,
          verb: Verb
        ): string => {
          const at = `${schema}.${table}/${verb}`;
          const decision = decide(identity, schema, table, verb);
          return decision.decision === "allow"
            ? `${at} → allow`
            : `${at} → deny[${classifyDeny(decision.failing)}, grant=${
                decision.grantId ?? "null"
              }] ${decision.failing}`;
        };
        /** What the clamp oracle says it MUST have said, to the exact sentence. */
        const required = (
          schema: string,
          table: string,
          verb: Verb
        ): string => {
          const at = `${schema}.${table}/${verb}`;
          return clampCovers(manifest.scopes, schema, table, verb)
            ? `${at} → allow`
            : `${at} → deny[manifest-undeclared, grant=null] ${undeclaredSentence(
                schema,
                table,
                verb
              )}`;
        };

        const probes: Array<[string, string, Verb]> = [];
        for (const verb of VERBS) {
          // (1) An undeclared schema.
          probes.push([ALIEN_SCHEMA, PROBE_TABLE, verb]);
          for (const scope of manifest.scopes) {
            probes.push(
              // (2) An undeclared table under a DECLARED schema.
              [scope.schema, ALIEN_TABLE, verb],
              // (3) Verb escalation on the scope's own entity: read→act,
              //     act→reveal, and everything the closure does not grade.
              [scope.schema, scope.table ?? PROBE_TABLE, verb]
            );
          }
        }
        // One whole-shape comparison, so a divergence names the exact probe and
        // the exact sentence rather than the first boolean that flipped.
        expect(probes.map((p) => observed(...p))).toStrictEqual(
          probes.map((p) => required(...p))
        );
      }
    );

    test("an empty declared scope list reads and writes nothing, for every manifest's schemas", () => {
      const identity = identityFor(sweep.clampedAgent, []);
      const seen = new Set<DenyClass>();
      for (const manifest of MANIFESTS) {
        for (const scope of manifest.scopes) {
          for (const verb of VERBS) {
            const table = scope.table ?? PROBE_TABLE;
            const decision = decide(identity, scope.schema, table, verb);
            expect(decision.decision).toBe("deny");
            if (decision.decision !== "deny") continue;
            expect(decision.failing).toBe(
              undeclaredSentence(scope.schema, table, verb)
            );
            seen.add(classifyDeny(decision.failing));
          }
        }
      }
      expect([...seen]).toStrictEqual(["manifest-undeclared"]);
    });

    test("ABSENT clamp and EMPTY clamp are opposite answers — the seam must never hand over the absent one", () => {
      // `release-notes-drafter` is the one bundled manifest declaring no vault
      // access at all. `executionScopeBlock` (build-gateway.ts) maps that to
      // `{scopes: []}` — "every automation execution is attenuated, including
      // manifests declaring no vault access" — so the production fire path
      // hands over an EMPTY clamp and the manifest layer refuses.
      //
      // One line apart in consent.ts, an ABSENT clamp means the opposite: "no
      // manifest attenuation", which leaves the durable grant untouched. This
      // pins the difference in both directions, because `agentBridgeFor`'s
      // `block?` is optional in the TYPE and the safety therefore rests
      // entirely on every call site supplying one.
      const blank = MANIFESTS.find((m) => m.scopes.length === 0);
      expect(blank?.label).toBe("automations/release-notes-drafter");
      const empty = decide(
        identityFor(sweep.clampedAgent, []),
        "core",
        "content_item",
        "read"
      );
      const absent = decide(
        identityFor(sweep.clampedAgent, undefined),
        "core",
        "content_item",
        "read"
      );
      expect({
        empty:
          empty.decision === "deny" ? classifyDeny(empty.failing) : "allow",
        absent:
          absent.decision === "deny" ? classifyDeny(absent.failing) : "allow",
      }).toStrictEqual({ empty: "manifest-undeclared", absent: "allow" });
      // And with no grant behind it, an absent clamp still lands on the grant
      // chain rather than on nothing.
      const ungranted = decide(
        identityFor(sweep.ungrantedAgent, undefined),
        "core",
        "content_item",
        "read"
      );
      expect(
        ungranted.decision === "deny"
          ? classifyDeny(ungranted.failing)
          : "allow"
      ).toBe("no-active-grant");
    });
  });

  describe("the denial grammar is closed — one positive case per class", () => {
    test("[device-readonly] a readonly caller may read but never act or reveal", () => {
      const scopes: ClampScope[] = [
        { schema: "core", table: "event", verbs: "read+act" },
        { schema: "core", table: "event", verbs: "reveal" },
      ];
      const readonly = identityFor(sweep.clampedAgent, scopes, {
        mayAct: false,
      });
      expect(decide(readonly, "core", "event", "read").decision).toBe("allow");
      for (const verb of ["act", "reveal"] as const) {
        const decision = decide(readonly, "core", "event", verb);
        expect(decision.decision).toBe("deny");
        if (decision.decision !== "deny") continue;
        expect(decision.failing).toBe("device is readonly");
        expect(classifyDeny(decision.failing)).toBe("device-readonly");
      }
    });

    test("[acting-owner-not-owner] an agent is capped at the owner it acts for", () => {
      const ownerId = uuidv7();
      const decision = decide(
        identityFor(
          sweep.clampedAgent,
          [{ schema: "core", table: "event", verbs: "read+act" }],
          { onBehalfOfOwner: { ownerId, mayAct: false } }
        ),
        "core",
        "event",
        "act"
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision !== "deny") return;
      expect(decision.failing).toBe(
        `acting owner ${ownerId} does not own this vault`
      );
      expect(classifyDeny(decision.failing)).toBe("acting-owner-not-owner");
    });

    test("[policy-forbids-purpose] a standing purpose rule bites before any grant", () => {
      sweep.db.vault
        .prepare(
          `INSERT INTO consent_policy
             (policy_id, kind, applies_schema, applies_table, rule_json,
              retention_days, residency_region, effective_from, priority)
           VALUES (?, 'purpose', 'social', NULL,
                   '{"allowed_purposes":["dpv:Billing"]}',
                   NULL, NULL, '2020-01-01T00:00:00Z', 1)`
        )
        .run(uuidv7());
      const decision = decide(
        identityFor(sweep.clampedAgent, [{ schema: "social", verbs: "read" }]),
        "social",
        "message",
        "read"
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision !== "deny") return;
      expect(decision.failing).toBe(
        `policy forbids purpose ${DEFAULT_PURPOSE} on social.message`
      );
      expect(classifyDeny(decision.failing)).toBe("policy-forbids-purpose");
      sweep.db.vault
        .prepare(`DELETE FROM consent_policy WHERE kind='purpose'`)
        .run();
    });

    test("[manifest-undeclared] the clamp refuses before the grant chain is read", () => {
      const decision = decide(
        identityFor(sweep.clampedAgent, [
          { schema: "core", table: "event", verbs: "read" },
        ]),
        "core",
        "task",
        "read"
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision !== "deny") return;
      expect(decision.failing).toBe(undeclaredSentence("core", "task", "read"));
      expect(classifyDeny(decision.failing)).toBe("manifest-undeclared");
      // grantId is null precisely because no grant was consulted.
      expect(decision.grantId).toBeNull();
    });

    test("[no-active-grant] a declared clamp over an unapproved automation still denies", () => {
      const decision = decide(
        identityFor(sweep.ungrantedAgent, [
          { schema: "core", table: "event", verbs: "read" },
        ]),
        "core",
        "event",
        "read"
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision !== "deny") return;
      expect(decision.failing).toBe(
        `no active grant for purpose ${DEFAULT_PURPOSE}`
      );
      expect(classifyDeny(decision.failing)).toBe("no-active-grant");
    });

    test("[no-grant-scope] a covering clamp over a grant that reaches elsewhere denies with the grant named", () => {
      const decision = decide(
        identityFor(sweep.elsewhereAgent, [
          { schema: "core", table: "event", verbs: "read" },
        ]),
        "core",
        "event",
        "read"
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision !== "deny") return;
      expect(decision.failing).toBe(
        "no grant_scope covers core.event for verb read"
      );
      expect(classifyDeny(decision.failing)).toBe("no-grant-scope");
      // This is the one deny that names the grant it was refused against.
      expect(decision.grantId).not.toBeNull();
    });

    test("the six classes above are the whole vocabulary this sweep can produce", () => {
      expect([...DENY_CLASSES]).toHaveLength(6);
      expect(classifyDeny("something nobody wrote")).toBe("UNRECOGNISED");
    });
  });
});
