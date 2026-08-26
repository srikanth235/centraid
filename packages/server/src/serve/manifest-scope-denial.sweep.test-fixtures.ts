/*
 * Fixtures for the bundled-manifest scope-denial sweep (#839): every bundled
 * manifest goes through its real validator into the SAME `scopeClamp`
 * `vault-plane.ts` builds, then through `evaluateConsent`. The agent's grant is
 * DELIBERATELY MAXIMAL so every denial is attributable to the manifest clamp
 * alone. It lives here because the vault package cannot depend on app-engine.
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

const BLUEPRINTS_ROOT = path.resolve(
  import.meta.dirname,
  "../../../blueprints"
);

export type ClampScope = NonNullable<Identity["scopeClamp"]>[number];
export type Verb = "read" | "act" | "reveal";

export const VERBS: readonly Verb[] = ["read", "act", "reveal"];

/** Asserted below, so a new manifest cannot turn a negative probe positive. */
export const ALIEN_SCHEMA = "zzzz_never_declared";
export const ALIEN_TABLE = "zzzz_never_declared_table";
export const PROBE_TABLE = "probe_entity";

export interface LoadedManifest {
  readonly label: string;
  readonly kind: "apps" | "automations";
  readonly id: string;
  readonly purpose: string | null;
  readonly scopes: readonly ClampScope[];
}

function templateDirs(kind: "apps" | "automations"): string[] {
  return readdirSync(path.join(BLUEPRINTS_ROOT, kind), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .toSorted();
}

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

/** The vault block lives in `automation.json`, not the gallery `app.json` (#98). */
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

/** Oracles restate consent.ts's rule; they never copy its loop. */

/** Reveal never rides read or act, and vice versa. */
function verbCoveredBy(
  declared: ClampScope["verbs"],
  requested: Verb
): boolean {
  if (requested === "reveal") return declared === "reveal";
  if (requested === "read")
    return declared === "read" || declared === "read+act";
  return declared === "act" || declared === "read+act";
}

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

export function verbsOf(declared: ClampScope["verbs"]): Verb[] {
  if (declared === "read+act") return ["read", "act"];
  if (declared === "reveal") return ["reveal"];
  return [declared];
}

/**
 * `ConsentDeny.failing` is receipted: every deny must classify into exactly one
 * of these six, and an unrecognised string fails. That is what CLOSED means.
 */

export const DENY_CLASSES = [
  "device-readonly",
  "acting-owner-not-owner",
  "policy-forbids-purpose",
  "manifest-undeclared",
  "no-active-grant",
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

/** Asserted verbatim, never by substring. */
export function undeclaredSentence(
  schema: string,
  table: string,
  verb: Verb
): string {
  return `execution manifest does not declare ${schema}.${table} for verb ${verb}`;
}

interface SweepAgent {
  readonly agentId: string;
  readonly partyId: string;
}

interface SweepState {
  db: VaultDb;
  close: () => void;
  clampedAgent: SweepAgent;
  ungrantedAgent: SweepAgent;
  /** Granted where no manifest names — isolates `no grant_scope covers`. */
  elsewhereAgent: SweepAgent;
}

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

  // Maximal grant (see header): whole-schema rows so a schema-wide scope has
  // something to cut against, per-table rows so a `minimization` policy cannot
  // masquerade as a manifest refusal.
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
