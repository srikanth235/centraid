/*
 * Shared fixtures for the bundled-manifest scope-denial sweep (issue #839, G4).
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
 * WHAT THIS SWEEP DOES. It loads every bundled `app.json` (8 apps + 29
 * automations) through the runtime validators that actually govern them
 * (`validateAppManifest`, and `parseManifest` for the automation manifest that
 * carries an automation's vault block), turns each declared scope list into the
 * SAME `scopeClamp` the production seam builds (`vault-plane.ts`
 * `agentBridgeFor`), and drives `evaluateConsent` over it — declared
 * combinations and, adversarially, undeclared ones. The three sibling
 * `*.test.ts` files import this module; each owns its own vault fixture.
 *
 * WHY THE GRANT IS DELIBERATELY MAXIMAL. The one agent this file enrolls holds
 * a durable grant covering every schema and every (schema, table) pair any
 * manifest names, for `read+act` and for `reveal`. That is not laxity: it makes
 * every denial in the sweep attributable to the MANIFEST CLAMP and nothing
 * else. A deny that came from a missing grant would prove nothing about the
 * manifest. The grant layer's own refusals are pinned separately, in the closed
 * grammar section.
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

import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  DEFAULT_PURPOSE,
  bootstrapVault,
  createGrant,
  enrollAgent,
  evaluateConsent,
  openVaultDb,
} from "@centraid/vault";
import type {
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
export type ClampScope = NonNullable<Identity["scopeClamp"]>[number];
export type Verb = "read" | "act" | "reveal";

export const VERBS: readonly Verb[] = ["read", "act", "reveal"];

/**
 * A schema no bundled manifest declares, and a table name no manifest uses.
 * Asserted against the loaded set below so a future manifest cannot quietly
 * turn the sweep's negative probes into positives.
 */
export const ALIEN_SCHEMA = "zzzz_never_declared";
export const ALIEN_TABLE = "zzzz_never_declared_table";
/** Stand-in entity for a schema-wide scope, which names no table of its own. */
export const PROBE_TABLE = "probe_entity";

export interface LoadedManifest {
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

export const MANIFESTS: readonly LoadedManifest[] = [
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
export function clampCovers(
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
export function verbsOf(declared: ClampScope["verbs"]): Verb[] {
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

export const DENY_CLASSES = [
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
export type DenyClass = (typeof DENY_CLASSES)[number] | "UNRECOGNISED";

export function classifyDeny(failing: string): DenyClass {
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
export function undeclaredSentence(
  schema: string,
  table: string,
  verb: Verb
): string {
  return `execution manifest does not declare ${schema}.${table} for verb ${verb}`;
}

/* ------------------------------------------------------------------ *
 * Fixture. Each sibling test file opens its own vault in `beforeAll` and
 * closes it in `afterAll`; `openSweepVault` populates the single mutable
 * `sweep` container below, so a test body reads whichever vault its own file
 * bootstrapped. A container (rather than `export let` bindings) keeps the
 * shared state a `const` — mutable exports are disallowed.
 * ------------------------------------------------------------------ */

interface SweepAgent {
  readonly agentId: string;
  readonly partyId: string;
}

interface SweepState {
  db: VaultDb;
  close: () => void;
  clampedAgent: SweepAgent;
  /** Enrolled, no grant at all — isolates the grant-layer refusals. */
  ungrantedAgent: SweepAgent;
  /** Granted only on a schema no manifest names — isolates `no grant_scope covers`. */
  elsewhereAgent: SweepAgent;
}

/** Populated by `openSweepVault`; read by every test through `sweep.*`. */
export const sweep = {} as SweepState;

export function identityFor(
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

export function decide(
  identity: Identity,
  schema: string,
  table: string,
  verb: Verb,
  purpose = DEFAULT_PURPOSE
): ConsentDecision {
  return evaluateConsent(
    sweep.db.vault,
    identity,
    schema,
    table,
    verb,
    purpose
  );
}

export function openSweepVault(): void {
  const { db, boot, close } = bootstrappedVault(
    { openVaultDb, bootstrapVault },
    { ownerName: "Priya", autoClose: false }
  );
  sweep.db = db;
  sweep.close = close;
  const purposeConceptId = boot.concepts[DEFAULT_PURPOSE] as string;
  sweep.clampedAgent = enrollAgent(db, {
    name: "sweep-clamped",
    modelRef: "centraid-automation",
  });
  sweep.ungrantedAgent = enrollAgent(db, {
    name: "sweep-ungranted",
    modelRef: "centraid-automation",
  });
  sweep.elsewhereAgent = enrollAgent(db, {
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
        tables.add(`${scope.schema} ${scope.table}`);
      }
    }
  }
  const superset: ScopeSpec[] = [];
  for (const schema of schemas) {
    superset.push({ schema, verbs: "read+act" }, { schema, verbs: "reveal" });
  }
  for (const pair of tables) {
    const [schema = "", table = ""] = pair.split(" ");
    superset.push(
      { schema, table, verbs: "read+act" },
      { schema, table, verbs: "reveal" }
    );
  }
  createGrant(db, {
    granteePartyId: sweep.clampedAgent.partyId,
    purposeConceptId,
    grantedByPartyId: boot.ownerPartyId,
    scopes: superset,
  });
  createGrant(db, {
    granteePartyId: sweep.elsewhereAgent.partyId,
    purposeConceptId,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: ALIEN_SCHEMA, verbs: "read+act" }],
  });
}

export function closeSweepVault(): void {
  sweep.close();
}
