/**
 * The static app entity tripwire (#928 A1(ii)) — pure half.
 *
 * #928 retires the runtime app grant evaluator: a first-party app is the
 * owner's own screens running the owner's own code, not a principal to be told
 * yes or no. Minimisation does not disappear with the evaluator, it MOVES TO
 * BUILD TIME — this module is where it lands. It answers one question over
 * text: does every entity and command an app's handlers name appear in that
 * app's `app.json#vault.scopes`? A reference the manifest does not carry is a
 * finding, with a reviewable diff and zero runtime cost.
 *
 * No filesystem here on purpose: the caller supplies manifests and file text,
 * so the rules are unit-testable against synthetic apps and a seeded violation
 * can be proven red without touching the tree (`app-entity-tripwire.test.ts`).
 *
 * ATTRIBUTION IS BY NAMED SCOPE, NOT BY DIRECTORY, reusing the rule
 * `app-manifest-reads.test.ts` established: a seat that writes
 * `useReplicaQuery("people", { entity: "core.vault" })` reads through PEOPLE's
 * scope even when the file sits under `apps/photos`. Only an unnamed reference
 * falls to the app whose directory holds it.
 *
 * A TRIPWIRE, NOT A PROOF. It is a text scanner over two precise call-site
 * forms (`entity: "<schema>.<table>"`, `command: "<schema>.<verb>"`). Two
 * limits are deliberate and both are closed rather than ignored:
 *
 *  - ONE LEVEL OF IMPORTS. From each entry file (`queries/*`, `actions/*`, the
 *    mobile app's own tree) it follows relative imports one hop, which is what
 *    reaches `_shared` kits and an app's own sibling tables. A literal two hops
 *    out is not seen. Resolution stops at the blueprint apps tree and the app's
 *    own mobile directory, so a shell-wide registry naming every app's entities
 *    is never charged to whichever app happened to import it.
 *  - INDIRECTION IS REGISTERED, AND THE REGISTER IS SWEPT BOTH WAYS. Where an
 *    entity flows through a variable, a template literal, or either object
 *    shorthand (`ctx.vault.read({ entity })`) the literal is out of reach.
 *    Those files are named in INDIRECT_ENTITY_READS with the entities they
 *    reach, and those are checked against the manifest exactly like a literal.
 *    `unregisteredIndirection` fails when a NEW such file appears, and
 *    `registerDrift` fails when a registered file names an entity its entry
 *    does not carry — without that second direction the register would be a
 *    hiding place, since nothing would notice a literal added to the file but
 *    not to the list. A consumer holding no literal of its own inherits its
 *    table's set through `via` rather than transcribing it.
 *
 * Filter VALUES are not references. `object_type: "locker.auth"` names a column
 * value in a WHERE clause, not an entity being read — `locker.auth` is not an
 * entity at all. Only the two call-site forms above count.
 */

/** One `vault.scopes[]` entry of an `app.json`. */
export interface ManifestScope {
  schema: string;
  table?: string;
  verbs: string;
  rowFilter?: readonly unknown[];
  fieldMask?: readonly string[];
}

export interface AppManifest {
  vault?: { scopes?: readonly ManifestScope[] };
}

/** A scanned file: its repo-relative path and its text. */
export interface SourceFile {
  path: string;
  text: string;
}

export interface AppInput {
  id: string;
  manifest: AppManifest;
  files: readonly SourceFile[];
}

/** What a manifest permits, split by verb and by table-vs-band. */
export interface DeclaredScopes {
  readEntities: ReadonlySet<string>;
  readSchemas: ReadonlySet<string>;
  actCommands: ReadonlySet<string>;
  actSchemas: ReadonlySet<string>;
}

/** A reference the manifest does not carry. */
export interface Finding {
  app: string;
  verb: "read" | "act";
  entity: string;
  file: string;
}

/** A `rowFilter`/`fieldMask` in use today — wave 2/4's work order. */
export interface FilterRow {
  app: string;
  scope: string;
  verbs: string;
  rowFilter: readonly unknown[] | null;
  fieldMask: readonly string[] | null;
}

/** `read` and `reveal` both reach rows; `act` invokes a command. */
function verbsOf(scope: ManifestScope): readonly string[] {
  return scope.verbs.split("+");
}

export function declaredScopes(manifest: AppManifest): DeclaredScopes {
  const readEntities = new Set<string>();
  const readSchemas = new Set<string>();
  const actCommands = new Set<string>();
  const actSchemas = new Set<string>();
  for (const scope of manifest.vault?.scopes ?? []) {
    const verbs = verbsOf(scope);
    const qualified = scope.table ? `${scope.schema}.${scope.table}` : null;
    if (verbs.includes("read") || verbs.includes("reveal")) {
      if (qualified) readEntities.add(qualified);
      else readSchemas.add(scope.schema);
    }
    if (verbs.includes("act")) {
      if (qualified) actCommands.add(qualified);
      else actSchemas.add(scope.schema);
    }
  }
  return { readEntities, readSchemas, actCommands, actSchemas };
}

/** Every `rowFilter`/`fieldMask` an app declares, in manifest order. */
export function filtersOf(app: AppInput): FilterRow[] {
  return (app.manifest.vault?.scopes ?? [])
    .filter(
      (scope) => scope.rowFilter !== undefined || scope.fieldMask !== undefined
    )
    .map((scope) => ({
      app: app.id,
      scope: scope.table ? `${scope.schema}.${scope.table}` : scope.schema,
      verbs: scope.verbs,
      rowFilter: scope.rowFilter ?? null,
      fieldMask: scope.fieldMask ?? null,
    }));
}

const QUALIFIED = "[a-z_]+\\.[a-z_]+";

/** `useReplicaQuery("people", { entity: "core.vault" })` — the NAMED scope wins. */
const SCOPED_READ = new RegExp(
  `(?:useReplicaQuery|\\.read)\\(\\s*"(?<scope>[a-z-]+)",[^;]{0,300}?entity:\\s*"(?<entity>${QUALIFIED})"`,
  "gsu"
);
const ENTITY_LITERAL = new RegExp(
  `(?<![A-Za-z_$])entity:\\s*"(?<entity>${QUALIFIED})"`,
  "gu"
);
const COMMAND_LITERAL = new RegExp(
  `(?<![A-Za-z_$])command:\\s*"(?<command>${QUALIFIED})"`,
  "gu"
);

/**
 * `entity` reaching a read through a variable rather than a literal. TS type
 * positions (`entity: string`) are not indirection — nothing is read there.
 */
const TYPE_POSITIONS = new Set([
  "string",
  "number",
  "boolean",
  "unknown",
  "any",
  "never",
]);
/**
 * Four shapes, because an entity reaches a read in four ways and a scanner
 * blind to one of them goes quiet instead of failing: `entity: someVariable`,
 * a TEMPLATE literal (`` entity: `${SCHEMA}.item` ``, whose key is built at
 * runtime and so is never a scannable literal), and the two object shorthands
 * `{ entity }` and `{ entity, limit: 5 }`. A template is counted whether or not
 * it interpolates — the cheap, conservative reading, since a file that builds
 * its key must be registered either way.
 */
const ENTITY_INDIRECT =
  /(?<![A-Za-z_$])entity:\s*(?:(?<template>`)|(?!")(?<value>[A-Za-z_$][\w$.]*))|[{,]\s*entity\s*[,}]/gu;

export function hasIndirectEntity(text: string): boolean {
  for (const match of text.matchAll(ENTITY_INDIRECT)) {
    if (match.groups?.template !== undefined) return true;
    const value = match.groups?.value;
    if (value === undefined || !TYPE_POSITIONS.has(value)) return true;
  }
  return false;
}

/**
 * A registered file either NAMES the entities it reaches, as literals in its own
 * text, or reaches exactly what another registered file reaches.
 *
 * `entities` is not a hand-kept list to be trusted. It is swept BOTH WAYS
 * (`registerDrift`): every entity-shaped literal in the file must appear here,
 * so a literal added to the file and not to the register fails the build, and
 * every entity here is checked against the manifest like any other read. `via`
 * removes the transcription entirely for a consumer that holds no literal of
 * its own — it inherits the table's set, so extending the table extends the
 * consumers in the same edit.
 *
 * A `via` entry is NOT an exemption from the sweep. The consumer is swept
 * against the set it inherits, so a literal written into the consumer instead
 * of into the table fails there too — otherwise `via` would simply move the
 * hiding place one file along.
 */
export type IndirectEntry =
  | { readonly entities: readonly string[] }
  | { readonly via: string };

/**
 * The files where an entity reaches a read through a variable, so the literal is
 * out of the scanner's reach. Registering one is a decision made in the open:
 * `unregisteredIndirection` fails until it is made, and `registerDrift` fails
 * when a registered file's literals and its entry disagree.
 */
export const INDIRECT_ENTITY_READS: Readonly<Record<string, IndirectEntry>> = {
  // `rowsOf(ctx, "locker.item_alias", …)` — the entity is a positional argument
  // to the shared sidecar reader, so no `entity:` literal exists to scan.
  "packages/blueprints/apps/locker/queries/item-sidecars.ts": {
    entities: [
      "core.attachment",
      "core.content_item",
      "core.entity_revision",
      "locker.item",
      "locker.item_address",
      "locker.item_alias",
      "locker.item_field",
      "locker.item_passkey",
    ],
  },
  // `entity: sidecar.entity`, constrained to the `SIDECAR_COLUMNS` keys — the
  // sealed rows a Locker permit may be spent on (#873).
  "packages/blueprints/apps/locker/queries/item.ts": {
    entities: ["locker.item", "locker.item_field", "locker.item_passkey"],
  },
  // The link-target table: `NOTE_TARGET_ENTITY` plus the six other kinds. This
  // is the one file that HOLDS the literals, so the sweep guards it, and a kind
  // added for an app Notes cannot read fails here.
  "packages/blueprints/apps/notes/link-targets-table.ts": {
    entities: [
      "core.content_item",
      "core.document",
      "core.event",
      "core.party",
      "knowledge.note",
      "schedule.task",
      "tally.expense",
    ],
  },
  // `entity: target.entity` over `LINK_TARGET_KINDS` — what `[[` may point at.
  // No literal of its own, so it INHERITS the table rather than restating it.
  "packages/blueprints/apps/notes/queries/link-targets.ts": {
    via: "packages/blueprints/apps/notes/link-targets-table.ts",
  },
  // The same table, read from the phone's powerbox.
  "apps/mobile/src/apps/notes/NotesPowerbox.tsx": {
    via: "packages/blueprints/apps/notes/link-targets-table.ts",
  },
  // The five below reach a read through the object shorthand — `({ entity })`
  // from a per-entity hook, `session.read("photos", { entity, limit })`, or a
  // projection record built with `{ op, entity, rowId }`. Each names its own
  // entities as literals, so `registerDrift` holds these lists to the file.
  "apps/mobile/src/apps/agenda/useAgenda.ts": {
    entities: [
      "core.concept",
      "core.concept_scheme",
      "core.event",
      "core.party",
      "core.tag",
      "core.vault",
      "schedule.attendee",
      "schedule.calendar",
      "schedule.event_ext",
      "schedule.recurrence_exception",
      "schedule.task",
    ],
  },
  "apps/mobile/src/apps/docs/useDocs.ts": {
    entities: [
      "blob.custody_state",
      "core.concept",
      "core.concept_scheme",
      "core.content_item",
      "core.document",
      "core.party",
      "core.tag",
      "share.authority",
      "share.fulfillment",
      "share.party_vault_binding",
      "share.subscription",
      "share.subscription_lineage",
      "social.circle",
      "social.circle_member",
    ],
  },
  "apps/mobile/src/apps/photos/timeline-engine.ts": {
    entities: [
      "core.concept",
      "core.concept_scheme",
      "core.content_derivative",
      "core.content_item",
      "core.tag",
      "media.asset",
      "media.asset_phash",
    ],
  },
  "apps/mobile/src/apps/tasks/useTasks.ts": {
    entities: ["schedule.project", "schedule.section", "schedule.task"],
  },
  // A generic kit: the entity is its caller's, passed in as a parameter, so it
  // names none of its own and the caller's literals are scanned in the caller.
  "packages/blueprints/apps/_shared/pending-overlay.ts": { entities: [] },
};

/** The entities a registered file reaches, resolving one level of `via`. */
export function reachedEntities(filePath: string): readonly string[] {
  const entry = INDIRECT_ENTITY_READS[filePath];
  if (entry === undefined) return [];
  if ("via" in entry) {
    const target = INDIRECT_ENTITY_READS[entry.via];
    if (target === undefined || "via" in target) return [];
    return target.entities;
  }
  return entry.entities;
}

/**
 * A `via` that does not resolve, because it names an unregistered file or
 * another `via`. `reachedEntities` answers `[]` for one, which would quietly
 * mean "reaches nothing" — an empty set checks nothing against the manifest and
 * trips no sweep, so a broken pointer would be the same hiding place in a third
 * disguise. It is a build failure instead, checked with the register itself.
 */
export function registerIntegrity(): string[] {
  const broken: string[] = [];
  for (const [filePath, entry] of Object.entries(INDIRECT_ENTITY_READS)) {
    if (!("via" in entry)) continue;
    const target = INDIRECT_ENTITY_READS[entry.via];
    if (target === undefined) {
      broken.push(`${filePath} points at unregistered "${entry.via}"`);
    } else if ("via" in target) {
      broken.push(`${filePath} points at "${entry.via}", itself a via`);
    }
  }
  return broken.sort();
}

/** Scanned files whose entity flows through a variable and are NOT registered. */
export function unregisteredIndirection(apps: readonly AppInput[]): string[] {
  const seen = new Set<string>();
  for (const app of apps) {
    for (const file of app.files) {
      if (
        hasIndirectEntity(file.text) &&
        !(file.path in INDIRECT_ENTITY_READS)
      ) {
        seen.add(file.path);
      }
    }
  }
  return [...seen].sort();
}

/** Every schema band any app declares — the vocabulary a bare literal is read against. */
export function knownSchemas(apps: readonly AppInput[]): Set<string> {
  const schemas = new Set<string>();
  for (const app of apps) {
    for (const scope of app.manifest.vault?.scopes ?? [])
      schemas.add(scope.schema);
  }
  return schemas;
}

const BARE_LITERAL = new RegExp(`"(?<entity>${QUALIFIED})"`, "gu");

/** Every entity-shaped literal in one file, restricted to the known schema bands. */
export function literalsIn(
  text: string,
  schemas: ReadonlySet<string>
): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(BARE_LITERAL)) {
    const entity = match.groups!.entity!;
    if (schemas.has(entity.split(".")[0]!)) found.add(entity);
  }
  return [...found].sort();
}

/**
 * The register swept the OTHER way: a literal a registered file names that its
 * entry does not carry. Without this direction the register is a hiding place.
 *
 * EVERY registered file is swept, `via` consumers included, each against the set
 * it actually reaches (`reachedEntities`) — an inherited set is still the set
 * that file is answerable for. Skipping `via` here would rebuild at the consumer
 * exactly the exemption this sweep removes at the table: a literal added to
 * `link-targets.ts` rather than to `link-targets-table.ts` would reach Notes
 * unchecked, which is the shape the #928 w1b re-audit reproduced.
 */
export function registerDrift(apps: readonly AppInput[]): string[] {
  const schemas = knownSchemas(apps);
  const drift = new Set<string>();
  for (const app of apps) {
    for (const file of app.files) {
      if (!(file.path in INDIRECT_ENTITY_READS)) continue;
      const declared = new Set(reachedEntities(file.path));
      for (const entity of literalsIn(file.text, schemas)) {
        if (!declared.has(entity)) {
          drift.add(
            `${file.path} names "${entity}" but INDIRECT_ENTITY_READS does not list it`
          );
        }
      }
    }
  }
  return [...drift].sort();
}

interface Reference {
  entity: string;
  file: string;
}

/**
 * Every read and act reference in one file, already attributed. A read inside a
 * scope-naming call belongs to the scope it names; everything else to `appId`.
 */
export function referencesIn(
  file: SourceFile,
  appId: string
): { reads: (Reference & { scope: string })[]; acts: Reference[] } {
  const named = new Map<string, string>();
  for (const match of file.text.matchAll(SCOPED_READ)) {
    named.set(match.groups!.entity!, match.groups!.scope!);
  }
  const reads = [...file.text.matchAll(ENTITY_LITERAL)].map((match) => {
    const entity = match.groups!.entity!;
    return { entity, file: file.path, scope: named.get(entity) ?? appId };
  });
  for (const entity of reachedEntities(file.path)) {
    reads.push({ entity, file: file.path, scope: appId });
  }
  const acts = [...file.text.matchAll(COMMAND_LITERAL)].map((match) => ({
    entity: match.groups!.command!,
    file: file.path,
  }));
  return { reads, acts };
}

function undeclared(
  entity: string,
  entities: ReadonlySet<string>,
  schemas: ReadonlySet<string>
): boolean {
  return !entities.has(entity) && !schemas.has(entity.split(".")[0]!);
}

/**
 * Every reference no manifest carries, sorted so the failure message is stable.
 * A read attributed to a scope no app declares is charged to the app whose file
 * named it — a typo'd scope must fail, not vanish.
 */
export function findUndeclared(apps: readonly AppInput[]): Finding[] {
  const scopes = new Map(
    apps.map((app) => [app.id, declaredScopes(app.manifest)])
  );
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (finding: Finding): void => {
    // JSON, not a separator character: a file path may contain anything, and
    // an ambiguous key would silently collapse two distinct findings into one.
    const key = JSON.stringify([
      finding.app,
      finding.verb,
      finding.entity,
      finding.file,
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const app of apps) {
    for (const file of app.files) {
      const { reads, acts } = referencesIn(file, app.id);
      for (const read of reads) {
        const owner = scopes.has(read.scope) ? read.scope : app.id;
        const declared = scopes.get(owner)!;
        if (
          undeclared(read.entity, declared.readEntities, declared.readSchemas)
        ) {
          add({
            app: owner,
            verb: "read",
            entity: read.entity,
            file: read.file,
          });
        }
      }
      const declared = scopes.get(app.id)!;
      for (const act of acts) {
        if (undeclared(act.entity, declared.actCommands, declared.actSchemas)) {
          add({ app: app.id, verb: "act", entity: act.entity, file: act.file });
        }
      }
    }
  }
  return findings.toSorted((a, b) =>
    `${a.app}${a.verb}${a.entity}${a.file}`.localeCompare(
      `${b.app}${b.verb}${b.entity}${b.file}`
    )
  );
}

/** One finding as the build prints it. */
export function formatFinding(finding: Finding): string {
  return `${finding.app}: ${finding.verb} "${finding.entity}" in ${finding.file} is not in app.json#vault.scopes`;
}
