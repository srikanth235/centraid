/**
 * The static app entity tripwire (#928 A1(ii)) — the build-time half.
 *
 * Two jobs, and the second is why this file exists as well as the module:
 *
 *  1. SCAN THE REAL TREE. Every `apps/<id>/app.json` against that app's
 *     `queries/*`, `actions/*` and its own mobile tree. A reference the
 *     manifest does not carry fails the build, naming app, file and entity.
 *  2. ENUMERATE THE FILTERS. Every `rowFilter` and `fieldMask` in use today is
 *     pinned to `app-entity-tripwire.filters.json`. #928 deletes the evaluator
 *     that honours them, so each has to be re-expressed in its own query first
 *     (waves 2 and 4). The fixture is that work order; a filter added or
 *     removed moves the fixture in the same PR.
 *
 * The rules live in `app-entity-tripwire.ts` so they can be proven against
 * synthetic apps — including SEEDED RED, the acceptance criterion "the static
 * tripwire fails a build in which an app query touches an undeclared entity".
 *
 * WHY THIS IS NOT `app-manifest-reads.test.ts`. That test guards the READ half
 * against a hand-kept matrix of table scopes. This one adds the half no test
 * had: `act` — the commands an app invokes against the `act` verbs it declares
 * — and it closes the two blind spots a literal scan has (one-hop imports and
 * variable-borne entities) rather than leaving them open. Both are kept: the
 * matrix makes a new read scope a decision made twice, this makes an
 * undeclared reference a build failure.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INDIRECT_ENTITY_READS,
  declaredScopes,
  filtersOf,
  findUndeclared,
  formatFinding,
  hasIndirectEntity,
  literalsIn,
  knownSchemas,
  reachedEntities,
  referencesIn,
  registerDrift,
  registerIntegrity,
  unregisteredIndirection,
} from "./app-entity-tripwire.ts";
import type { AppInput, FilterRow, SourceFile } from "./app-entity-tripwire.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const APPS_DIR = path.join(PACKAGE_ROOT, "apps");
const MOBILE_APPS = path.join(REPO_ROOT, "apps/mobile/src/apps");
const FIXTURE = path.join(
  import.meta.dirname,
  "app-entity-tripwire.filters.json"
);

/** Repo-relative and forward-slashed, so a finding reads the same everywhere. */
function relative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function appIds(): string[] {
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((id) => existsSync(path.join(APPS_DIR, id, "app.json")))
    .toSorted();
}

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.includes(".test.")
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The handlers and the phone screens: an app's `queries/*` and `actions/*`, and
 * everything under its own mobile directory.
 */
function entryFiles(id: string): string[] {
  return [
    ...sourcesUnder(path.join(APPS_DIR, id, "queries")),
    ...sourcesUnder(path.join(APPS_DIR, id, "actions")),
    ...sourcesUnder(path.join(MOBILE_APPS, id)),
  ];
}

const RELATIVE_IMPORT = /from\s+"(?<specifier>\.[A-Za-z0-9./_-]+)"/gu;

/**
 * One hop out from an entry file, and only INSIDE the app tree: the blueprint
 * apps directory (so `_shared` kits and an app's own sibling tables resolve) or
 * this app's own mobile directory. A shell-wide module that names every app's
 * entities is out of bounds by construction — importing it must not charge
 * `core.document` to Photos.
 */
function oneHopImports(id: string, files: readonly string[]): string[] {
  const bounds = [APPS_DIR, path.join(MOBILE_APPS, id)];
  const reached = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT)) {
      const base = path.resolve(path.dirname(file), match.groups!.specifier!);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
        if (
          existsSync(candidate) &&
          !candidate.includes(".test.") &&
          /\.tsx?$/u.test(candidate) &&
          bounds.some((bound) => candidate.startsWith(`${bound}${path.sep}`))
        ) {
          reached.add(candidate);
        }
      }
    }
  }
  return [...reached];
}

function read(absolute: string): SourceFile {
  return { path: relative(absolute), text: readFileSync(absolute, "utf8") };
}

function loadApps(): AppInput[] {
  return appIds().map((id) => {
    const entries = entryFiles(id);
    const files = [...new Set([...entries, ...oneHopImports(id, entries)])]
      .toSorted()
      .map(read);
    return {
      id,
      manifest: JSON.parse(
        readFileSync(path.join(APPS_DIR, id, "app.json"), "utf8")
      ) as AppInput["manifest"],
      files,
    };
  });
}

const APPS = loadApps();

describe("[law:app-entity-tripwire] static app entity tripwire (#928 A1)", () => {
  it("scans every bundled app, its handlers and its phone screens", () => {
    expect(APPS.map((app) => app.id)).toStrictEqual([
      "agenda",
      "docs",
      "locker",
      "notes",
      "people",
      "photos",
      "tally",
      "tasks",
    ]);
    // A manifest with no scopes, or an app whose files stopped resolving, would
    // pass every check below by reading nothing at all.
    for (const app of APPS) {
      expect(
        app.files.length,
        `${app.id} has no scannable files`
      ).toBeGreaterThan(0);
      const declared = declaredScopes(app.manifest);
      expect(
        declared.readEntities.size + declared.readSchemas.size,
        `${app.id} declares no reads`
      ).toBeGreaterThan(0);
    }
  });

  it("no app reads or invokes anything its manifest does not declare", () => {
    const findings = findUndeclared(APPS);
    expect(findings.map(formatFinding)).toStrictEqual([]);
  });

  it("charges a read to the scope its call site names, not to its directory", () => {
    // Photos' grant entry reads `core.vault` and `tally.group` through PEOPLE's
    // and TALLY's scopes — the pooled-scope rule `app-manifest-reads.test.ts`
    // established. Directory attribution would report three false findings.
    const file = path.join(MOBILE_APPS, "photos/photo-grants.ts");
    const { reads } = referencesIn(read(file), "photos");
    const byEntity = new Map(reads.map((entry) => [entry.entity, entry.scope]));
    expect(byEntity.get("core.vault")).toBe("people");
    expect(byEntity.get("tally.group")).toBe("tally");
  });

  it("counts the commands it checks, so the act half is not vacuous", () => {
    const acts = APPS.flatMap((app) =>
      app.files.flatMap((file) =>
        referencesIn(file, app.id).acts.map((act) => act.entity)
      )
    );
    // 134 distinct (app, command) pairs today; the floor keeps a refactor that
    // silently stops matching call sites from passing as "nothing undeclared".
    expect(new Set(acts).size).toBeGreaterThanOrEqual(60);
  });

  it("registers every file whose entity travels through a variable", () => {
    expect(unregisteredIndirection(APPS)).toStrictEqual([]);
    expect(Object.keys(INDIRECT_ENTITY_READS).toSorted()).toStrictEqual([
      "apps/mobile/src/apps/agenda/useAgenda.ts",
      "apps/mobile/src/apps/docs/useDocs.ts",
      "apps/mobile/src/apps/notes/NotesPowerbox.tsx",
      "apps/mobile/src/apps/photos/timeline-engine.ts",
      "apps/mobile/src/apps/tasks/useTasks.ts",
      "packages/blueprints/apps/_shared/pending-overlay.ts",
      "packages/blueprints/apps/locker/queries/item-sidecars.ts",
      "packages/blueprints/apps/locker/queries/item.ts",
      "packages/blueprints/apps/notes/link-targets-table.ts",
      "packages/blueprints/apps/notes/queries/link-targets.ts",
    ]);
  });

  it("sweeps the register the other way, so it cannot become a hiding place", () => {
    // Every entity-shaped literal a registered file names must appear in its
    // entry. Without this direction the register EXCUSES a file instead of
    // describing it: a literal added to the file and not to the list would pass
    // silently. The two consumers that hold no literal of their own inherit the
    // link-target table through `via`, so there is nothing to transcribe.
    expect(registerDrift(APPS)).toStrictEqual([]);
    // Every `via` resolves. An unresolved one would answer "reaches nothing",
    // which checks nothing and trips no sweep — the same hiding place again.
    expect(registerIntegrity()).toStrictEqual([]);
    expect(
      reachedEntities("packages/blueprints/apps/notes/queries/link-targets.ts")
    ).toStrictEqual(
      reachedEntities("packages/blueprints/apps/notes/link-targets-table.ts")
    );
    expect(
      reachedEntities("apps/mobile/src/apps/notes/NotesPowerbox.tsx")
    ).toStrictEqual(
      reachedEntities("packages/blueprints/apps/notes/link-targets-table.ts")
    );
  });
});

describe("the filters #928 must re-express before the evaluator goes", () => {
  const rows: FilterRow[] = APPS.flatMap(filtersOf);

  it("pins every rowFilter and fieldMask in use to the fixture", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      filters: FilterRow[];
    };
    expect(rows).toStrictEqual(fixture.filters);
  });

  it("names the four scopes that carry one", () => {
    expect(rows.map((row) => `${row.app} ${row.scope}`)).toStrictEqual([
      "locker core.entity_revision",
      "locker access.receipt",
      "people core.entity_revision",
      "tally core.entity_revision",
    ]);
    // Every one is an app reading its own undo history or its own receipts —
    // a WHERE clause, which is why #928 folds them into the queries.
    for (const row of rows) expect(row.rowFilter).not.toBeNull();
  });
});

/**
 * SEEDED RED (#928 acceptance: "the static tripwire fails a build in which an
 * app query touches an undeclared entity, proven with a seeded violation").
 * Synthetic apps, so the proof does not depend on breaking the real tree.
 */
describe("seeded violations", () => {
  const manifest = {
    vault: {
      scopes: [
        { schema: "schedule", table: "task", verbs: "read" },
        { schema: "schedule", table: "add_task", verbs: "act" },
      ],
    },
  };

  it("fails on a query reading an entity the manifest forgot, naming all three", () => {
    const findings = findUndeclared([
      {
        id: "tasks",
        manifest,
        files: [
          {
            path: "packages/blueprints/apps/tasks/queries/board.ts",
            text: 'ctx.vault.read({ entity: "schedule.task" });\nctx.vault.read({ entity: "locker.item" });',
          },
        ],
      },
    ]);
    expect(findings.map(formatFinding)).toStrictEqual([
      'tasks: read "locker.item" in packages/blueprints/apps/tasks/queries/board.ts is not in app.json#vault.scopes',
    ]);
    expect(findings[0]!.app).toBe("tasks");
    expect(findings[0]!.entity).toBe("locker.item");
    expect(findings[0]!.file).toBe(
      "packages/blueprints/apps/tasks/queries/board.ts"
    );
  });

  it("fails on an action invoking a command the manifest does not declare", () => {
    const findings = findUndeclared([
      {
        id: "tasks",
        manifest,
        files: [
          {
            path: "packages/blueprints/apps/tasks/actions/purge.ts",
            text: 'runVaultAction(ctx, { command: "locker.purge_item" });',
          },
        ],
      },
    ]);
    expect(findings.map(formatFinding)).toStrictEqual([
      'tasks: act "locker.purge_item" in packages/blueprints/apps/tasks/actions/purge.ts is not in app.json#vault.scopes',
    ]);
  });

  it("does not let a read verb pay for a command, or a command for a read", () => {
    // `schedule.task` is readable and `schedule.add_task` invocable; swapping
    // the two must still fail, or the verbs are decorative.
    const findings = findUndeclared([
      {
        id: "tasks",
        manifest,
        files: [
          {
            path: "queries/x.ts",
            text: 'read({ entity: "schedule.add_task" });\nrun({ command: "schedule.task" });',
          },
        ],
      },
    ]);
    expect(
      findings.map((finding) => `${finding.verb} ${finding.entity}`)
    ).toStrictEqual(["act schedule.task", "read schedule.add_task"]);
  });

  it("charges a read named for an unknown scope to the app that wrote it", () => {
    // A typo'd scope must fail, never vanish into a scope nobody declares.
    const findings = findUndeclared([
      {
        id: "tasks",
        manifest,
        files: [
          {
            path: "Screen.tsx",
            text: 'useReplicaQuery("peple", { entity: "core.party" })',
          },
        ],
      },
    ]);
    expect(findings.map(formatFinding)).toStrictEqual([
      'tasks: read "core.party" in Screen.tsx is not in app.json#vault.scopes',
    ]);
  });

  it("accepts a schema-level band and a reveal verb as reads", () => {
    expect(
      findUndeclared([
        {
          id: "photos",
          manifest: {
            vault: {
              scopes: [
                { schema: "media", verbs: "read" },
                { schema: "locker", table: "item_field", verbs: "reveal" },
              ],
            },
          },
          files: [
            {
              path: "queries/library.ts",
              text: 'read({ entity: "media.asset" });\nread({ entity: "locker.item_field" });',
            },
          ],
        },
      ])
    ).toStrictEqual([]);
  });

  it("sees indirection, and ignores an `entity: string` type position", () => {
    expect(
      hasIndirectEntity("ctx.vault.read({ entity: sidecar.entity })")
    ).toBe(true);
    expect(hasIndirectEntity("interface Ask {\n  entity: string;\n}")).toBe(
      false
    );
    expect(hasIndirectEntity('read({ entity: "core.party" })')).toBe(false);
    // An unregistered indirect file is itself a failure, so the scanner cannot
    // go blind without someone saying so.
    expect(
      unregisteredIndirection([
        {
          id: "tasks",
          manifest,
          files: [
            { path: "queries/new.ts", text: "read({ entity: kind.entity })" },
          ],
        },
      ])
    ).toStrictEqual(["queries/new.ts"]);
  });

  /**
   * Both reproductions from the #928 w1b audit, kept as tests so neither hole
   * can reopen. Each was verified to FAIL against the module as it stood before
   * the fix.
   */
  it("catches a literal added to a registered file but not to the register", () => {
    // AUDIT FINDING 1. Adding a `locker.item` link-target kind to
    // `notes/link-targets-table.ts` — a file Notes reaches through a variable —
    // used to pass: the register was transcribed by hand and read one way only,
    // so `locker.item` entered Notes' reach without any check. Notes declares no
    // `locker.*` scope. The sweep now reports the literal the entry omits.
    const drift = registerDrift([
      {
        id: "notes",
        manifest: {
          vault: { scopes: [{ schema: "knowledge", verbs: "read" }] },
        },
        files: [
          {
            path: "packages/blueprints/apps/notes/link-targets-table.ts",
            text: 'const LOCKER_TARGET_ENTITY = "locker.item";\nconst NOTE = "knowledge.note";',
          },
        ],
      },
      // Locker is what puts `locker` in the schema vocabulary a bare literal is
      // read against — the bands come from the manifests, not a hard-coded list.
      {
        id: "locker",
        manifest: {
          vault: {
            scopes: [{ schema: "locker", table: "item", verbs: "read" }],
          },
        },
        files: [],
      },
    ]);
    expect(drift).toStrictEqual([
      'packages/blueprints/apps/notes/link-targets-table.ts names "locker.item" but INDIRECT_ENTITY_READS does not list it',
    ]);
  });

  it("sweeps a `via` consumer too, so inheritance is not an exemption", () => {
    // RE-AUDIT FINDING. The first fix skipped `via` entries in the sweep, which
    // rebuilt at the CONSUMER the exemption it had just removed at the table: a
    // literal written into `notes/queries/link-targets.ts` instead of into
    // `link-targets-table.ts` reached Notes unchecked and the suite stayed at 17
    // passed. A consumer is answerable for the set it inherits, so it is swept
    // against `reachedEntities` rather than skipped.
    const drift = registerDrift([
      {
        id: "notes",
        manifest: {
          vault: { scopes: [{ schema: "knowledge", verbs: "read" }] },
        },
        files: [
          {
            path: "packages/blueprints/apps/notes/queries/link-targets.ts",
            text: 'const EXTRA_TARGET = "locker.item";\nctx.vault.search({ entity: EXTRA_TARGET, term });',
          },
        ],
      },
      {
        id: "locker",
        manifest: {
          vault: {
            scopes: [{ schema: "locker", table: "item", verbs: "read" }],
          },
        },
        files: [],
      },
    ]);
    expect(drift).toStrictEqual([
      'packages/blueprints/apps/notes/queries/link-targets.ts names "locker.item" but INDIRECT_ENTITY_READS does not list it',
    ]);
    // What the consumer legitimately inherits still passes the same sweep.
    expect(
      registerDrift([
        {
          id: "notes",
          manifest: {
            vault: { scopes: [{ schema: "knowledge", verbs: "read" }] },
          },
          files: [
            {
              path: "packages/blueprints/apps/notes/queries/link-targets.ts",
              text: 'search({ entity: "knowledge.note" });',
            },
          ],
        },
      ])
    ).toStrictEqual([]);
  });

  it("sees all four indirection shapes, not only the trailing-comma one", () => {
    // AUDIT FINDING 2. `{ entity }` and `{ entity, limit: 5 }` used to read as
    // false, so a new file of either shape was neither scanned nor reported
    // unregistered — a blind spot that announced nothing.
    expect(hasIndirectEntity("ctx.vault.read({ entity });")).toBe(true);
    expect(hasIndirectEntity("read({ entity, limit: 5 });")).toBe(true);
    expect(hasIndirectEntity("read({\n  entity,\n  limit: 5,\n});")).toBe(true);
    expect(hasIndirectEntity("read({ entity: kind.entity })")).toBe(true);
    // THIRD-PASS GAP. A template-built key is never a scannable literal, so a
    // file using one must be registered; a backtick used to slip past both the
    // variable branch and the shorthand branch, leaving such a file neither
    // scanned nor reported.
    expect(hasIndirectEntity(`read({ entity: \`\${SCHEMA}.item\` })`)).toBe(
      true
    );
    expect(hasIndirectEntity("read({ entity: `core.party` })")).toBe(true);
    expect(
      unregisteredIndirection([
        {
          id: "tasks",
          manifest,
          files: [
            {
              path: "queries/templated.ts",
              text: `ctx.vault.read({ entity: \`\${SCHEMA}.item\`, limit: 10 });`,
            },
          ],
        },
      ])
    ).toStrictEqual(["queries/templated.ts"]);
    // Still not indirection: a literal, and a type position.
    expect(hasIndirectEntity('read({ entity: "core.party" })')).toBe(false);
    expect(hasIndirectEntity("interface Ask { entity: string }")).toBe(false);
    for (const text of ["read({ entity });", "read({ entity, limit: 5 });"]) {
      expect(
        unregisteredIndirection([
          { id: "tasks", manifest, files: [{ path: "queries/n.ts", text }] },
        ])
      ).toStrictEqual(["queries/n.ts"]);
    }
  });

  it("reads bare literals only in the schema bands the manifests declare", () => {
    const schemas = knownSchemas([{ id: "notes", manifest, files: [] }]);
    expect([...schemas].toSorted()).toStrictEqual(["schedule"]);
    // `logins.csv` and `notes.md` are filenames, not entities; the band closes
    // them out, which is why the sweep does not drown the register in noise.
    expect(
      literalsIn('"schedule.task" "logins.csv" "notes.md"', schemas)
    ).toStrictEqual(["schedule.task"]);
  });
});
