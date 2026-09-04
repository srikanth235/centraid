/*
 * A read scope is what the gateway turns into a consent grant and a replica
 * shape (#883). UNDECLARED fails late as a refused read; UNUSED never fails at
 * all — the member granted reach no surface needed.
 *
 * THE POOL IS BOTH SEATS: a blueprint app, its native half in
 * `apps/mobile/src/apps/<id>`, and any shell surface reading through the app's
 * scope all share one manifest scope.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const APPS_DIR = path.join(PACKAGE_ROOT, "apps");

interface Scope {
  schema: string;
  table?: string;
  verbs: string;
}

/**
 * Every TABLE-level read scope each app declares, so adding one to a manifest
 * is a decision made twice. SCHEMA-level scopes (`{schema: "media"}`) are an
 * app's own band, not a table it borrows, and are not listed.
 */
const READS: Readonly<Record<string, readonly string[]>> = {
  agenda: [
    "core.vault",
    "core.event",
    "core.party",
    "core.content_item",
    "core.attachment",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
  ],
  docs: [
    "core.document",
    "core.content_item",
    "social.circle",
    "social.circle_member",
    "share.authority",
    "share.fulfillment",
    "core.party",
    "core.link",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
    "access.provenance",
    "blob.custody_state",
    // The Shared shelf: which shapes placed a row here, and whose vault served
    // them (#929).
    "share.subscription",
    "share.subscription_lineage",
    "share.party_vault_binding",
  ],
  locker: [
    "locker.item",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
    "locker.item_alias",
    "locker.item_field",
    "locker.item_address",
    "locker.item_passkey",
    // The item pane's history section reads the shared revision ledger; the
    // per-app `locker.item_history` table is gone (#916).
    "core.entity_revision",
    "core.attachment",
    "core.content_item",
    "access.receipt",
  ],
  notes: [
    "core.content_item",
    "core.attachment",
    "core.link",
    "core.link_anchor",
    "core.party",
    "core.event",
    "core.document",
    "schedule.task",
    "tally.expense",
    "media.asset",
    "core.collection",
    "core.collection_entry",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
  ],
  people: [
    "core.party",
    "core.vault",
    "core.party_identifier",
    "core.activity",
    "core.link",
    "core.content_item",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
    "knowledge.annotation",
    "knowledge.note",
    "schedule.task",
    "tally.obligation",
    "social.contact_channel",
    "share.party_vault_binding",
    // V-dashboard: Settings → Access reads the authority plane through People.
    "share.authority",
    "core.entity_revision",
  ],
  photos: [
    "core.content_item",
    "core.content_derivative",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
    "core.collection",
    "core.collection_entry",
    "social.circle",
    "social.circle_member",
    "media.face_region",
    "media.face_cluster",
    "media.memory",
    "media.memory_member",
    "core.party",
    "core.place",
    "enrich.policy",
    "blob.custody_state",
    "blob.custody_rollup",
  ],
  tally: [
    "core.vault",
    "core.party",
    "core.content_item",
    "core.attachment",
    "tally.friend",
    "tally.group",
    "social.circle",
    "social.circle_member",
    "tally.expense",
    "tally.expense_split",
    "tally.expense_payer",
    "tally.expense_line_item",
    "tally.expense_line_allocation",
    "tally.settlement",
    "tally.obligation",
    "tally.nudge",
    "tally.recurring_expense",
    "schedule.recurrence_exception",
    "core.entity_revision",
  ],
  tasks: [
    "schedule.task",
    "schedule.project",
    "schedule.section",
    "core.content_item",
    "core.attachment",
    "core.link",
    "core.link_anchor",
    "core.tag",
    "core.concept",
    "core.concept_scheme",
  ],
};

function appIds(): string[] {
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((id) => existsSync(path.join(APPS_DIR, id, "app.json")))
    .filter((id) => {
      const manifest = JSON.parse(
        readFileSync(path.join(APPS_DIR, id, "app.json"), "utf8")
      ) as { vault?: unknown };
      return manifest.vault !== undefined;
    })
    .toSorted();
}

function scopesOf(id: string): Scope[] {
  const manifest = JSON.parse(
    readFileSync(path.join(APPS_DIR, id, "app.json"), "utf8")
  ) as { vault?: { scopes: Scope[] } };
  return manifest.vault?.scopes ?? [];
}

function declaredReads(id: string): { tables: string[]; schemas: string[] } {
  const scopes = scopesOf(id).filter((scope) => scope.verbs.includes("read"));
  return {
    tables: scopes
      .filter((scope) => scope.table !== undefined)
      .map((scope) => `${scope.schema}.${scope.table!}`),
    schemas: scopes
      .filter((scope) => scope.table === undefined)
      .map((scope) => scope.schema),
  };
}

function sourceFiles(dir: string): string[] {
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

function join(files: readonly string[]): string {
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

/**
 * A seat NAMES the scope at the call site, so the read is attributed to that
 * scope and never to the directory it sits in: Photos legitimately reads
 * `core.vault` through PEOPLE's scope.
 */
function scopedSeatReads(): Map<string, Set<string>> {
  const byScope = new Map<string, Set<string>>();
  const seats = [
    ...sourceFiles(path.join(REPO_ROOT, "apps/mobile/src")),
    ...sourceFiles(path.join(REPO_ROOT, "packages/client/src/react")),
  ];
  for (const source of seats.map((file) => readFileSync(file, "utf8"))) {
    for (const call of source.matchAll(
      /(?:useReplicaQuery|\.read)\(\s*"(?<scope>[a-z-]+)",[^;]{0,300}?entity:\s*"(?<entity>[a-z_]+\.[a-z_]+)"/gu
    )) {
      const scope = call.groups!.scope!;
      const reads = byScope.get(scope) ?? new Set<string>();
      reads.add(call.groups!.entity!);
      byScope.set(scope, reads);
    }
  }
  return byScope;
}

const SEAT_READS = scopedSeatReads();

/** Everything read THROUGH this app's scope, on either seat. */
function ownReads(id: string): Set<string> {
  return new Set([
    ...entitiesRead(join(sourceFiles(path.join(APPS_DIR, id)))),
    ...(SEAT_READS.get(id) ?? []),
  ]);
}

/**
 * The "unused" question is not per app — a shared kit reads through whichever
 * scope called it — so it asks the weaker, checkable one: is the entity named
 * anywhere a seat reads from?
 */
const SEAT_TEXT = join([
  ...sourceFiles(path.join(APPS_DIR, "_shared")),
  ...sourceFiles(path.join(REPO_ROOT, "apps/mobile/src")),
  ...sourceFiles(path.join(REPO_ROOT, "packages/client/src")),
]);

/** Everything that can reach for this app's scope. */
function sourcesFor(id: string): string {
  return [
    join([
      ...sourceFiles(path.join(APPS_DIR, id)),
      ...sourceFiles(path.join(REPO_ROOT, "apps/mobile/src/apps", id)),
    ]),
    SEAT_TEXT,
    readFileSync(path.join(APPS_DIR, id, "app.json"), "utf8"),
  ].join("\n");
}

/** Read CALL SITES, precisely: `entity: "schema.table"`. */
function entitiesRead(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/entity:\s*"(?<entity>[a-z_]+\.[a-z_]+)"/gu)].map(
      (match) => match.groups!.entity!
    )
  );
}

describe("manifest reads", () => {
  const ids = appIds();

  it("the matrix names every app that declares a vault block", () => {
    expect(Object.keys(READS).toSorted()).toStrictEqual(ids);
  });

  it.each(ids.map((id) => [id] as const))(
    "apps/%s declares exactly the reads the matrix names",
    (id) => {
      expect(declaredReads(id).tables.toSorted()).toStrictEqual(
        [...READS[id]!].toSorted()
      );
    }
  );

  it.each(ids.map((id) => [id] as const))(
    "apps/%s reads nothing it has not declared",
    (id) => {
      const { tables, schemas } = declaredReads(id);
      const allowed = new Set(tables);
      const bands = new Set(schemas);
      const undeclared = [...ownReads(id)].filter(
        (entity) => !allowed.has(entity) && !bands.has(entity.split(".")[0]!)
      );
      expect(undeclared, `${id} reads what it never asked for`).toStrictEqual(
        []
      );
    }
  );

  it.each(ids.map((id) => [id] as const))(
    "apps/%s declares no read nothing reaches for",
    (id) => {
      const source = sourcesFor(id);
      const unused = READS[id]!.filter(
        (entity) => !source.includes(`"${entity}"`)
      );
      expect(
        unused,
        `${id} asks the member for reads no surface uses`
      ).toStrictEqual([]);
    }
  );
});
