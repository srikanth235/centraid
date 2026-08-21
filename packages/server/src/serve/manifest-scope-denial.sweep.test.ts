/*
 * The bundled-manifest scope-denial sweep (issue #839, G4).
 *
 * WHAT WAS UNGATED. `packages/vault/src/gateway/consent.ts` is the RLS
 * replacement: every read, act and reveal a non-owner caller makes passes
 * `evaluateConsent`, and the execution clamp built from an app's / automation's
 * declared `vault.scopes` is the first thing that can refuse. Individual clamp
 * behaviours were pinned by hand (`gateway/execution-clamp.test.ts`), and the
 * bundled manifests were checked for *parseability*
 * (`packages/blueprints/src/app-manifests.test.ts`) — but nothing ever drove
 * the real consent engine over the real manifests. So "the 37 shipped manifests
 * deny everything they did not declare" was an assumption, not a proof.
 *
 * WHAT THIS FILE DOES. It loads every bundled `app.json` (8 apps + 29
 * automations) through the runtime validators that actually govern them
 * (`validateAppManifest`, and `parseManifest` for the automation manifest that
 * carries an automation's vault block), turns each declared scope list into the
 * SAME `scopeClamp` the production seam builds (`vault-plane.ts`
 * `agentBridgeFor`), and drives `evaluateConsent` over it — declared
 * combinations and, adversarially, undeclared ones.
 *
 * WHY THE GRANT IS DELIBERATELY MAXIMAL. The one agent this file enrolls holds
 * a durable grant covering every schema and every (schema, table) pair any
 * manifest names, for `read+act` and for `reveal`. That is not laxity: it makes
 * every denial in the sweep attributable to the MANIFEST CLAMP and nothing
 * else. A deny that came from a missing grant would prove nothing about the
 * manifest. The grant layer's own refusals are pinned separately, in the closed
 * grammar section below.
 *
 * WHY IT LIVES IN `packages/server` AND NOT BESIDE `consent.ts`. The manifest
 * validators are app-engine and automation-engine code, and the vault package
 * must never depend on app-engine (see the note in
 * `packages/vault/src/conversation-archive-roots.test.ts`). `packages/server`
 * is the one package that declares BOTH `@centraid/vault` and
 * `@centraid/blueprints` as real dependencies and owns both validators, so it
 * is where the real machinery can meet the real consent engine without a
 * layering inversion or an undeclared cross-package import.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  DEFAULT_PURPOSE,
  GatewayError,
  bootstrapVault,
  createGrant,
  enrollAgent,
  evaluateConsent,
  openVaultDb,
  uuidv7,
} from "@centraid/vault";
import type {
  BootstrapResult,
  ConsentDecision,
  FilterClause,
  Identity,
  ScopeSpec,
  VaultDb,
} from "@centraid/vault";

import { parseManifest } from "../automation/manifest/manifest.js";
import { validateManifest as validateAppManifest } from "../engine/registry/manifest.js";

/** The blueprint template tree, reached by path (it is a sibling package). */
const BLUEPRINTS_ROOT = path.resolve(
  import.meta.dirname,
  "../../../blueprints"
);

/** One execution-clamp scope, as `Identity` carries it. */
type ClampScope = NonNullable<Identity["scopeClamp"]>[number];
type Verb = "read" | "act" | "reveal";

const VERBS: readonly Verb[] = ["read", "act", "reveal"];

/**
 * A schema no bundled manifest declares, and a table name no manifest uses.
 * Asserted against the loaded set below so a future manifest cannot quietly
 * turn the sweep's negative probes into positives.
 */
const ALIEN_SCHEMA = "zzzz_never_declared";
const ALIEN_TABLE = "zzzz_never_declared_table";
/** Stand-in entity for a schema-wide scope, which names no table of its own. */
const PROBE_TABLE = "probe_entity";

interface LoadedManifest {
  /** `apps/tasks` or `automations/faces` — the label every failure names. */
  readonly label: string;
  readonly kind: "apps" | "automations";
  readonly id: string;
  readonly purpose: string | null;
  readonly scopes: readonly ClampScope[];
}

/* ------------------------------------------------------------------ *
 * Loading: the real validators, over the real bundled manifests.
 * ------------------------------------------------------------------ */

function templateDirs(kind: "apps" | "automations"): string[] {
  return readdirSync(path.join(BLUEPRINTS_ROOT, kind), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .toSorted();
}

/** Manifest scopes are structurally the clamp — the same shape `vault-plane.ts` copies. */
function toClampScopes(
  scopes: readonly {
    schema: string;
    table?: string;
    verbs: ClampScope["verbs"];
    rowFilter?: readonly { column: string; op: string; value?: unknown }[];
    fieldMask?: readonly string[];
  }[]
): ClampScope[] {
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

function loadAppManifest(id: string): LoadedManifest {
  const manifest = validateAppManifest(
    JSON.parse(
      readFileSync(path.join(BLUEPRINTS_ROOT, "apps", id, "app.json"), "utf8")
    )
  );
  return {
    label: `apps/${id}`,
    kind: "apps",
    id,
    purpose: manifest.vault?.purpose ?? null,
    scopes: toClampScopes(manifest.vault?.scopes ?? []),
  };
}

/**
 * An automation template's `app.json` is its gallery identity; the vault block
 * it actually runs under lives in the `automation.json` beside its handler
 * (issue #98's unified folder model). Both are parsed with their own runtime
 * validator, so a manifest that would not load at runtime cannot pass here.
 */
function loadAutomationManifest(id: string): LoadedManifest {
  const appManifest = validateAppManifest(
    JSON.parse(
      readFileSync(
        path.join(BLUEPRINTS_ROOT, "automations", id, "app.json"),
        "utf8"
      )
    )
  );
  const innerRoot = path.join(
    BLUEPRINTS_ROOT,
    "automations",
    id,
    "automations"
  );
  const inner = readdirSync(innerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const scopes: ClampScope[] = [];
  let purpose: string | null = appManifest.vault?.purpose ?? null;
  for (const automationId of inner) {
    const manifest = parseManifest(
      readFileSync(
        path.join(innerRoot, automationId, "automation.json"),
        "utf8"
      )
    );
    if (!manifest.vault) continue;
    purpose = manifest.vault.purpose;
    scopes.push(...toClampScopes(manifest.vault.scopes));
  }
  return {
    label: `automations/${id}`,
    kind: "automations",
    id,
    purpose,
    scopes,
  };
}

const MANIFESTS: readonly LoadedManifest[] = [
  ...templateDirs("apps").map(loadAppManifest),
  ...templateDirs("automations").map(loadAutomationManifest),
];

/* ------------------------------------------------------------------ *
 * Oracles: restatements of consent.ts's contract, written from the
 * documented rule rather than from the implementation's own loop.
 * ------------------------------------------------------------------ */

/** `verbAllowed` (consent.ts:43): reveal never rides read or act, and vice versa. */
function verbCoveredBy(
  declared: ClampScope["verbs"],
  requested: Verb
): boolean {
  if (requested === "reveal") return declared === "reveal";
  if (requested === "read")
    return declared === "read" || declared === "read+act";
  return declared === "act" || declared === "read+act";
}

/** `executionClamp` (consent.ts:108) coverage: any scope on the schema whose table matches and whose verb grades. */
function clampCovers(
  scopes: readonly ClampScope[],
  schema: string,
  table: string,
  verb: Verb
): boolean {
  return scopes.some(
    (scope) =>
      scope.schema === schema &&
      (scope.table === undefined || scope.table === table) &&
      verbCoveredBy(scope.verbs, verb)
  );
}

/** The verbs a declared scope actually grades for. */
function verbsOf(declared: ClampScope["verbs"]): Verb[] {
  if (declared === "read+act") return ["read", "act"];
  if (declared === "reveal") return ["reveal"];
  return [declared];
}

/* ------------------------------------------------------------------ *
 * The closed denial grammar. `ConsentDeny.failing` is a receipted string,
 * so its vocabulary is a contract: every deny this sweep can produce must
 * classify into exactly one of these six, and an unrecognised string is a
 * failure — that is what makes the grammar CLOSED rather than merely
 * "something was denied".
 * ------------------------------------------------------------------ */

const DENY_CLASSES = [
  /** consent.ts:258 — a readonly device may browse, never act or reveal. */
  "device-readonly",
  /** consent.ts:271 — the on-behalf-of cap (#599 d7, #726). */
  "acting-owner-not-owner",
  /** consent.ts:278 — a standing consent.policy purpose rule. */
  "policy-forbids-purpose",
  /** consent.ts:289 — THE manifest clamp refusal this sweep is about. */
  "manifest-undeclared",
  /** consent.ts:297 — nothing active for this purpose. */
  "no-active-grant",
  /** consent.ts:329 — grants exist, none of their scopes covers this. */
  "no-grant-scope",
] as const;
type DenyClass = (typeof DENY_CLASSES)[number] | "UNRECOGNISED";

function classifyDeny(failing: string): DenyClass {
  if (failing === "device is readonly") return "device-readonly";
  if (
    failing.startsWith("acting owner ") &&
    failing.endsWith(" does not own this vault")
  ) {
    return "acting-owner-not-owner";
  }
  if (failing.startsWith("policy forbids purpose ")) {
    return "policy-forbids-purpose";
  }
  if (failing.startsWith("execution manifest does not declare ")) {
    return "manifest-undeclared";
  }
  if (failing.startsWith("no active grant for purpose "))
    return "no-active-grant";
  if (failing.startsWith("no grant_scope covers ")) return "no-grant-scope";
  return "UNRECOGNISED";
}

/** The exact sentence consent.ts:289 writes — asserted verbatim, not by substring. */
function undeclaredSentence(schema: string, table: string, verb: Verb): string {
  return `execution manifest does not declare ${schema}.${table} for verb ${verb}`;
}

/* ------------------------------------------------------------------ *
 * Fixture.
 * ------------------------------------------------------------------ */

let db: VaultDb;
let boot: BootstrapResult;
let closeVault: () => void;
let clampedAgent: { agentId: string; partyId: string };
/** Enrolled, no grant at all — isolates the grant-layer refusals. */
let ungrantedAgent: { agentId: string; partyId: string };
/** Granted only on a schema no manifest names — isolates `no grant_scope covers`. */
let elsewhereAgent: { agentId: string; partyId: string };

function identityFor(
  agent: { agentId: string; partyId: string },
  scopeClamp?: readonly ClampScope[],
  over: Partial<Identity> = {}
): Identity {
  return {
    kind: "agent",
    callerId: agent.agentId,
    provAgentKind: "ai_agent",
    partyId: agent.partyId,
    mayAct: true,
    ...(scopeClamp === undefined ? {} : { scopeClamp }),
    ...over,
  };
}

function decide(
  identity: Identity,
  schema: string,
  table: string,
  verb: Verb,
  purpose = DEFAULT_PURPOSE
): ConsentDecision {
  return evaluateConsent(db.vault, identity, schema, table, verb, purpose);
}

function openSweepVault(): void {
  ({
    db,
    boot,
    close: closeVault,
  } = bootstrappedVault(
    { openVaultDb, bootstrapVault },
    { ownerName: "Priya", autoClose: false }
  ));
  const purposeConceptId = boot.concepts[DEFAULT_PURPOSE] as string;
  clampedAgent = enrollAgent(db, {
    name: "sweep-clamped",
    modelRef: "centraid-automation",
  });
  ungrantedAgent = enrollAgent(db, {
    name: "sweep-ungranted",
    modelRef: "centraid-automation",
  });
  elsewhereAgent = enrollAgent(db, {
    name: "sweep-elsewhere",
    modelRef: "centraid-automation",
  });

  // The deliberately maximal durable grant — see the header. Both whole-schema
  // rows (so a schema-wide manifest scope has something to cut against) and
  // per-table rows (so a `minimization` policy, which excludes a table from
  // default scopes, cannot masquerade as a manifest refusal).
  const schemas = new Set<string>();
  const tables = new Set<string>();
  for (const manifest of MANIFESTS) {
    for (const scope of manifest.scopes) {
      schemas.add(scope.schema);
      if (scope.table !== undefined) {
        tables.add(`${scope.schema} ${scope.table}`);
      }
    }
  }
  const superset: ScopeSpec[] = [];
  for (const schema of schemas) {
    superset.push({ schema, verbs: "read+act" }, { schema, verbs: "reveal" });
  }
  for (const pair of tables) {
    const [schema = "", table = ""] = pair.split(" ");
    superset.push(
      { schema, table, verbs: "read+act" },
      { schema, table, verbs: "reveal" }
    );
  }
  createGrant(db, {
    granteePartyId: clampedAgent.partyId,
    purposeConceptId,
    grantedByPartyId: boot.ownerPartyId,
    scopes: superset,
  });
  createGrant(db, {
    granteePartyId: elsewhereAgent.partyId,
    purposeConceptId,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: ALIEN_SCHEMA, verbs: "read+act" }],
  });
}

/* ------------------------------------------------------------------ *
 * The sweep.
 * ------------------------------------------------------------------ */

describe("bundled manifest scope-denial sweep (#839 G4)", () => {
  beforeAll(openSweepVault);

  afterAll(() => {
    closeVault();
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
      declaredScopes: 247,
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
        const identity = identityFor(clampedAgent, manifest.scopes);
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
      // The two bundled manifests that anchor a schema-wide read: people and
      // tally each attenuate `core.entity_revision` to their own entity type.
      const anchored = MANIFESTS.filter((manifest) =>
        manifest.scopes.some((scope) => scope.rowFilter !== undefined)
      );
      expect(anchored.map((m) => m.label)).toStrictEqual([
        "apps/people",
        "apps/tally",
      ]);
      for (const manifest of anchored) {
        const scope = manifest.scopes.find((s) => s.rowFilter !== undefined);
        if (!scope?.table) throw new Error("anchored scope must name a table");
        const decision = decide(
          identityFor(clampedAgent, manifest.scopes),
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

  describe("every undeclared combination fails CLOSED with the exact grammar", () => {
    test.each(MANIFESTS.map((m) => [m.label, m] as const))(
      "%s",
      (_label, manifest) => {
        const identity = identityFor(clampedAgent, manifest.scopes);
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
      const identity = identityFor(clampedAgent, []);
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
        identityFor(clampedAgent, []),
        "core",
        "content_item",
        "read"
      );
      const absent = decide(
        identityFor(clampedAgent, undefined),
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
        identityFor(ungrantedAgent, undefined),
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
      const readonly = identityFor(clampedAgent, scopes, { mayAct: false });
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
          clampedAgent,
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
      db.vault
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
        identityFor(clampedAgent, [{ schema: "social", verbs: "read" }]),
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
      db.vault.prepare(`DELETE FROM consent_policy WHERE kind='purpose'`).run();
    });

    test("[manifest-undeclared] the clamp refuses before the grant chain is read", () => {
      const decision = decide(
        identityFor(clampedAgent, [
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
        identityFor(ungrantedAgent, [
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
        identityFor(elsewhereAgent, [
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
      // The soundness half is the adversarial one: an allow the oracle does not
      // cover would be the clamp widening rather than narrowing.
      fc.assert(
        fc.property(
          fc.array(arbScope, { maxLength: 6 }),
          arbName,
          arbName,
          fc.constantFrom(...VERBS),
          (scopes, schema, table, verb) => {
            const decision = decide(
              identityFor(clampedAgent, scopes),
              schema,
              table,
              verb
            );
            const covered = clampCovers(scopes, schema, table, verb);
            const refusedByManifest =
              decision.decision === "deny" &&
              decision.failing === undeclaredSentence(schema, table, verb);
            // The biconditional IS the law: the manifest layer refuses exactly
            // the combinations the declared scopes do not cover. `false === true`
            // would be the clamp widening; `true === false` would be it refusing
            // something it declared.
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
            const identity = identityFor(clampedAgent, scopes, { mayAct });
            const decision = decide(identity, schema, table, verb);
            const outcome =
              decision.decision === "allow"
                ? "allow"
                : classifyDeny(decision.failing);
            // Closed vocabulary: "allow" or one of the six named refusals.
            // Anything else means a new `failing` string escaped the receipt
            // grammar without anyone naming it.
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
              identityFor(clampedAgent, manifest.scopes),
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
      // Empty names, whitespace, unicode, and a very long name are all just
      // names that match nothing. The ONLY input `executionClamp` refuses
      // loudly is two scopes pinning one column to different values (a UNION
      // the clamp vocabulary cannot express) — pinned here so "never throws"
      // has an exact, intentional exception rather than a silent one.
      const malformed: ClampScope[] = [
        { schema: "", verbs: "read" },
        { schema: "  ", table: "", verbs: "act" },
        { schema: "core event", verbs: "reveal" },
        { schema: "ℂ𝕠𝕣𝕖", table: "𝕖𝕧𝕖𝕟𝕥", verbs: "read+act" },
        { schema: "x".repeat(4096), verbs: "read" },
      ];
      for (const verb of VERBS) {
        const decision = decide(
          identityFor(clampedAgent, malformed),
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
          identityFor(clampedAgent, [pin("a"), pin("b")]),
          "core",
          "event",
          "read"
        )
      ).toThrow(GatewayError);
    });
  });
});
