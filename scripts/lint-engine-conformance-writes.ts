// Engine W — declared writes (#1018 split).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { blankComments } from "./lib/disabled-controls.ts";
import { ROOT } from "./lint-engine-conformance-surface.ts";

const BUNDLED_APPS_DIR_NAME = path.join("packages", "blueprints", "apps");

// ─── ENGINE W — declared writes ──────────────────────────────────────────────
//
// `app.json`'s `writes:` is the action's claim about which vault tables its
// command touches, and every one of the 131 was an empty array — a claim of
// nothing, which is neither true nor checkable. #883 filled them from the
// commands themselves; this lane keeps them honest in the two ways a text file
// goes wrong: a name that is not a vault entity at all (a typo, or a table
// dropped from the ontology — `tally.expense_receipt` and the `home.*` /
// `business.*` domains went this wave), and an action that quietly goes back
// to declaring nothing.
//
// NOT CHECKED HERE: declared ⊇ observed. That comparison needs the running
// vault, so it belongs to a server-side gate over receipts, not to a text
// scanner. What this lane guarantees that gate is a well-formed left-hand side.
//
// The vault's own registry is the vocabulary; it is read by source scan for the
// same reason `placement-registry.test.ts` reads vault's `ShareableItemType`
// that way — a blueprint may not import vault, and the alternative is a third
// copy of the table list.

const VAULT_TABLES_PATH = path.join(
  "packages",
  "vault",
  "src",
  "schema",
  "entity-catalog.ts"
);
/**
 * An action whose command writes NO vault row, with the reason. Ledger, not
 * exemption: an entry whose action starts writing something fails, and so does
 * an empty `writes:` that is not listed.
 */
const WRITES_NONE_LEDGER = new Map([
  [
    "locker/export",
    "`locker.export` unseals and hands back a payload; the only durable trace " +
      "it leaves is the reveal receipt, which is the journal's row, not a vault one",
  ],
]);

/**
 * Every `schema.table` in vault's canonical registry, by source scan.
 *
 * READS THE DECLARATIONS, NOT THE DERIVED VIEWS. `VAULT_TABLES` and
 * `JOURNAL_TABLES` are `tableNamesOf(VAULT_ENTITIES)` since #883's O-label
 * rung — the registry grew a per-entity label and the bare-name views became
 * a projection of it — so a scan looking for `schema: ["a", "b"]` literals
 * found nothing and this whole lane went vacuous behind its own anti-vacuity
 * guard. The entity registries are the one place a table is added or removed,
 * which is what a text scanner has to read.
 *
 * The shape is `schema: { table: { label, blurb? }, … }`, so the walk is one
 * brace level deeper than the old one: schema keys at depth 1, table keys at
 * depth 2, and nothing below that (a label is a string, not a nested object).
 *
 * AND IT FOLLOWS SPREADS ACROSS FILES (#996 wave 7). The registry outgrew the
 * repo's file-size rule and was split: `VAULT_ENTITIES` now spreads
 * `...VAULT_DOMAIN_ENTITIES` out of `entity-catalog-domains.ts`. A scan of one
 * file cannot see through that — it read 47 names where the registry has 100+
 * — and 47 is under the anti-vacuity floor, so this whole lane went red rather
 * than quietly under-counting. Both failure modes are the same defect: the
 * scanner has to follow the composition the registry actually has.
 *
 * AN UNRESOLVABLE SPREAD THROWS. Silently skipping one is exactly how a text
 * scanner goes vacuous behind its own guard: the count would still look
 * plausible, and every `writes:` naming a domain table would pass unchecked.
 * `checkDeclaredWrites` turns the throw into a finding.
 */
export function vaultEntityNames(root = ROOT): Set<string> {
  const names = new Set<string>();
  for (const constant of ["VAULT_ENTITIES", "JOURNAL_ENTITIES"])
    collectEntityNames(root, VAULT_TABLES_PATH, constant, names, new Set());
  return names;
}

/** `import { A, B } from "./x.js"` → which file each name comes from. */
function importedFrom(source: string, fromFile: string): Map<string, string> {
  const sources = new Map<string, string>();
  const importRe =
    /import\s+(?:type\s+)?\{(?<names>[^}]*)\}\s*from\s*["'](?<spec>[^"']+)["']/gu;
  for (const match of source.matchAll(importRe)) {
    // A relative specifier only: the registry composes files, never packages,
    // and a scanner that started resolving node_modules would be guessing.
    const spec = match.groups?.spec;
    if (!spec?.startsWith(".")) continue;
    const file = path.join(
      path.dirname(fromFile),
      // Source, not build output: the declarations live in the `.ts`.
      spec.replace(/\.js$/u, ".ts")
    );
    for (const name of (match.groups?.names ?? "").split(",")) {
      const bound = name
        .trim()
        .split(/\s+as\s+/u)
        .pop()
        ?.trim();
      if (!bound) continue;
      // `A as B` binds B locally, which is the name a spread would use.
      sources.set(bound, file);
    }
  }
  return sources;
}

/**
 * Read one registry constant, following `...IDENT` spreads into the files that
 * declare them. `seen` breaks a cycle rather than recursing forever.
 */
function collectEntityNames(
  root: string,
  file: string,
  constant: string,
  names: Set<string>,
  seen: Set<string>
): void {
  const key = `${file}#${constant}`;
  if (seen.has(key)) return;
  seen.add(key);
  let source;
  try {
    source = blankComments(readFileSync(path.join(root, file), "utf8"));
  } catch {
    throw new Error(`${file}: the registry names it and it cannot be read`);
  }
  const start = source.indexOf(`export const ${constant}`);
  if (start === -1) {
    if (seen.size === 1) return;
    throw new Error(`${file}: does not export ${constant}`);
  }
  const imports = importedFrom(source, file);
  const open = source.indexOf("{", start);
  let depth = 0;
  let schema: string | null = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      // A label's own braces would otherwise be counted as structure.
      const quote = char;
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === quote) break;
      }
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      if (--depth === 0) break;
      if (depth === 1) schema = null;
      continue;
    }
    // A SPREAD OF ANOTHER REGISTRY, at the level a schema key sits.
    const spread = /^\.\.\.(?<name>[A-Za-z_][\w]*)/u.exec(source.slice(i));
    if (spread && depth === 1) {
      const spreadName = spread.groups?.name;
      if (!spreadName) continue;
      const from = imports.get(spreadName);
      if (!from)
        throw new Error(
          `${file}: spreads ${spreadName} into ${constant} and this scan ` +
            `cannot resolve where it comes from — the entity vocabulary would be ` +
            `under-counted, which is how this gate goes vacuous`
        );
      collectEntityNames(root, from, spreadName, names, seen);
      i += spread[0].length - 1;
      continue;
    }
    // A key sits immediately before its `:` at the depth it belongs to.
    const key2 = /^(?<name>[A-Za-z_][\w]*)\s*:/u.exec(source.slice(i));
    if (!key2) continue;
    const keyName = key2.groups?.name;
    if (!keyName) continue;
    if (depth === 1) schema = keyName;
    else if (depth === 2 && schema) names.add(`${schema}.${keyName}`);
    i += key2[0].length - 1;
  }
}

export function checkDeclaredWrites(root: string) {
  const findings: string[] = [];
  let entities;
  try {
    entities = vaultEntityNames(root);
  } catch (error) {
    // A registry this scan cannot read whole is a RED lane, never a smaller
    // vocabulary quietly passing every declaration made against it.
    return [
      `${VAULT_TABLES_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  // Anti-vacuity: an empty or tiny vocabulary would pass every declaration.
  // Floor is 90, not 100: post-#929 catalog after the commons rail left
  // (~14 share.commons_* tables gone; share.subscription + lineage added).
  if (entities.size < 90 || !entities.has("core.content_item"))
    return [
      `${VAULT_TABLES_PATH}: read ${entities.size} entity names — the declared-writes ` +
        `gate is anchored on this registry and has gone vacuous`,
    ];
  const appsDir = path.join(root, BUNDLED_APPS_DIR_NAME);
  const seen = new Set<string>();
  const apps = existsSync(appsDir)
    ? readdirSync(appsDir).filter(
        (name) =>
          !name.startsWith("_") &&
          existsSync(path.join(appsDir, name, "app.json"))
      )
    : [];
  if (apps.length < 8)
    findings.push(
      `${BUNDLED_APPS_DIR_NAME}: found ${apps.length} bundled manifests — the ` +
        `declared-writes lane's walk drifted from the layout`
    );
  for (const app of apps.toSorted()) {
    const rel = path.join(BUNDLED_APPS_DIR_NAME, app, "app.json");
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, rel), "utf8")
    );
    const actions =
      typeof manifest === "object" &&
      manifest !== null &&
      "actions" in manifest &&
      Array.isArray(manifest.actions)
        ? manifest.actions
        : [];
    for (const rawAction of actions) {
      const action =
        typeof rawAction === "object" && rawAction !== null
          ? (rawAction as Record<string, unknown>)
          : {};
      const key = `${app}/${String(action.name ?? "")}`;
      const writes = action.writes;
      if (!Array.isArray(writes)) {
        findings.push(
          `${rel}: action \`${action.name}\` declares no \`writes\` array — ` +
            `every action names the vault tables its command writes`
        );
        continue;
      }
      for (const table of writes) {
        if (typeof table === "string" && entities.has(table)) continue;
        findings.push(
          `${rel}: action \`${action.name}\` declares \`${table}\`, which is not ` +
            `a vault entity (${VAULT_TABLES_PATH}) — a dropped table or a typo ` +
            `reads as a write that can never happen`
        );
      }
      if (writes.length > 0) continue;
      seen.add(key);
      const reason = WRITES_NONE_LEDGER.get(key);
      if (!reason)
        findings.push(
          `${rel}: action \`${action.name}\` declares \`writes: []\` — trace the ` +
            `command it dispatches and name the tables, or add it to ` +
            `WRITES_NONE_LEDGER with the reason it writes nothing`
        );
    }
  }
  for (const [key, reason] of WRITES_NONE_LEDGER) {
    if (!seen.has(key))
      findings.push(
        `${key}: ledgered as writing nothing (${reason}) but it now declares ` +
          `writes, or the action is gone — drop the WRITES_NONE_LEDGER entry`
      );
  }
  return findings;
}
