import type { DatabaseSync } from "node:sqlite";

import { sealedColumnsOf } from "./sealed.js";
import { resolveEntity } from "./tables.js";

export function contentText(
  mediaType: unknown,
  contentUri: unknown
): string | null {
  if (typeof mediaType !== "string" || !mediaType.startsWith("text/"))
    return null;
  if (typeof contentUri !== "string" || !contentUri.startsWith("data:"))
    return null;
  const comma = contentUri.indexOf(",");
  if (comma < 0) return null;
  const meta = contentUri.slice(0, comma);
  const payload = contentUri.slice(comma + 1);
  try {
    return meta.includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

export function registerContentTextFn(db: DatabaseSync): void {
  db.function("vault_content_text", { deterministic: true }, contentText);
}

type FtsColumn =
  | { name: string; kind: "column" }
  | { name: string; kind: "content"; fk: string }
  | { name: string; kind: "self-content" };

export interface FtsEntitySpec {
  entity: string;
  idColumn: string;
  columns: FtsColumn[];
  deletedColumn?: string;
}

const RETIRED_ENTITIES: ReadonlySet<string> = new Set([
  "social.contact_card",
  "home.asset_item",
]);

const BASELINE_SPECS: readonly FtsEntitySpec[] = [
  {
    entity: "core.content_item",
    idColumn: "content_id",
    columns: [{ name: "title", kind: "column" }],
    deletedColumn: "deleted_at",
  },
  {
    entity: "knowledge.note",
    idColumn: "note_id",
    columns: [
      { name: "title", kind: "column" },
      { name: "body", kind: "content", fk: "body_content_id" },
    ],
    deletedColumn: "deleted_at",
  },
  {
    entity: "core.document",
    idColumn: "document_id",
    columns: [
      { name: "title", kind: "column" },
      { name: "body", kind: "content", fk: "current_content_id" },
    ],
    deletedColumn: "deleted_at",
  },
  {
    entity: "social.thread",
    idColumn: "thread_id",
    columns: [{ name: "subject", kind: "column" }],
  },
  {
    entity: "social.message",
    idColumn: "message_id",
    columns: [{ name: "body", kind: "content", fk: "body_content_id" }],
  },
  {
    entity: "core.party",
    idColumn: "party_id",
    columns: [
      { name: "display_name", kind: "column" },
      { name: "sort_name", kind: "column" },
    ],
  },
  {
    entity: "social.contact_card",
    idColumn: "card_id",
    columns: [
      { name: "nickname", kind: "column" },
      { name: "org_title", kind: "column" },
    ],
  },
  {
    entity: "knowledge.annotation",
    idColumn: "annotation_id",
    columns: [{ name: "body_text", kind: "column" }],
  },
  {
    entity: "schedule.task",
    idColumn: "task_id",
    columns: [
      { name: "title", kind: "column" },
      { name: "description", kind: "column" },
    ],
  },
  {
    entity: "core.event",
    idColumn: "event_id",
    columns: [
      { name: "summary", kind: "column" },
      { name: "description", kind: "column" },
    ],
  },
  {
    entity: "core.transaction",
    idColumn: "txn_id",
    columns: [{ name: "description", kind: "column" }],
  },
  {
    entity: "home.asset_item",
    idColumn: "item_id",
    columns: [
      { name: "name", kind: "column" },
      { name: "serial_no", kind: "column" },
    ],
  },
  {
    entity: "people.profile",
    idColumn: "profile_id",
    columns: [{ name: "role", kind: "column" }],
  },
  {
    entity: "locker.item",
    idColumn: "item_id",
    columns: [
      { name: "title", kind: "column" },
      { name: "username", kind: "column" },
      { name: "url", kind: "column" },
    ],
    deletedColumn: "deleted_at",
  },
  {
    entity: "tally.expense",
    idColumn: "expense_id",
    columns: [{ name: "description", kind: "column" }],
  },
];

const SPEC_PATCHES: Readonly<Record<string, Partial<FtsEntitySpec>>> = {
  "schedule.task": { deletedColumn: "deleted_at" },
  "core.event": { deletedColumn: "deleted_at" },
  "people.profile": {
    columns: [
      { name: "role", kind: "column" },
      { name: "nickname", kind: "column" },
    ],
    deletedColumn: "deleted_at",
  },
  "tally.expense": { deletedColumn: "deleted_at" },
};

const ADDED_SPECS: readonly FtsEntitySpec[] = [
  {
    entity: "core.collection",
    idColumn: "collection_id",
    columns: [{ name: "name", kind: "column" }],
  },
  {
    entity: "core.place",
    idColumn: "place_id",
    columns: [{ name: "name", kind: "column" }],
  },
  {
    entity: "schedule.project",
    idColumn: "project_id",
    columns: [{ name: "name", kind: "column" }],
  },
  {
    entity: "social.circle",
    idColumn: "circle_id",
    columns: [{ name: "name", kind: "column" }],
  },
];

const SPECS: readonly FtsEntitySpec[] = [
  ...BASELINE_SPECS.filter((spec) => !RETIRED_ENTITIES.has(spec.entity)).map(
    (spec) => ({ ...spec, ...SPEC_PATCHES[spec.entity] })
  ),
  ...ADDED_SPECS,
];

export interface SearchableEntity {
  fts: string;
  idColumn: string;
  maskColumns: readonly string[];
  alsoConsent: readonly string[];
}

function physical(entity: string): string {
  return resolveEntity(entity)?.physical ?? entity.replace(".", "_");
}

export function assertFtsSpecsRegistered(): void {
  for (const spec of SPECS) {
    if (resolveEntity(spec.entity)) continue;
    throw new Error(
      `fts spec names ${spec.entity}, which the table registry does not declare — the registry is the one owner of an entity's name (issue #883, ruling O-label)`
    );
  }
}

function maskColumnsOf(spec: FtsEntitySpec): string[] {
  return spec.columns.map((c) =>
    c.kind === "column" ? c.name : c.kind === "content" ? c.fk : "content_uri"
  );
}

export const SEARCHABLE: Readonly<Record<string, SearchableEntity>> =
  Object.fromEntries(
    SPECS.map((spec) => [
      spec.entity,
      {
        fts: `fts_${physical(spec.entity)}`,
        idColumn: spec.idColumn,
        maskColumns: maskColumnsOf(spec),
        alsoConsent: spec.columns.some((c) => c.kind === "content")
          ? ["core.content_item"]
          : [],
      },
    ])
  );

export const FTS_BODY_INDEX_BUDGET_CHARS = 256 * 1024;

const TRUNCATION_MARKER = " ...(truncated for search index)";

export function truncateForIndex(
  expr: string,
  budgetChars: number = FTS_BODY_INDEX_BUDGET_CHARS
): string {
  return `(CASE WHEN ${expr} IS NULL THEN NULL
                 WHEN length(${expr}) > ${budgetChars}
                 THEN substr(${expr}, 1, ${budgetChars}) || '${TRUNCATION_MARKER}'
                 ELSE ${expr} END)`;
}

function valueExpr(column: FtsColumn, prefix: string): string {
  if (column.kind === "column") return `${prefix}."${column.name}"`;
  if (column.kind === "self-content") {
    return truncateForIndex(
      `vault_content_text(${prefix}."media_type", ${prefix}."content_uri")`
    );
  }
  return truncateForIndex(`(SELECT vault_content_text(media_type, content_uri) FROM core_content_item
            WHERE content_id = ${prefix}."${column.fk}")`);
}

export function assertNoSealedFtsColumns(spec: FtsEntitySpec): void {
  const sealed = sealedColumnsOf(spec.entity);
  if (sealed.length === 0) return;
  for (const col of spec.columns) {
    const name =
      col.kind === "column"
        ? col.name
        : col.kind === "content"
          ? col.fk
          : "content_uri";
    if (sealed.includes(name)) {
      throw new Error(
        `fts spec for ${spec.entity} names sealed column "${name}" — sealed columns are never indexed (issue #293)`
      );
    }
  }
}

function insertColumnsOf(spec: FtsEntitySpec): string {
  return ["rowid", spec.idColumn, ...spec.columns.map((c) => c.name)].join(
    ", "
  );
}

function valuesOf(spec: FtsEntitySpec, prefix: string): string {
  return [
    `${prefix}.rowid`,
    `${prefix}."${spec.idColumn}"`,
    ...spec.columns.map((c) => valueExpr(c, prefix)),
  ].join(", ");
}

function liveGuardOf(spec: FtsEntitySpec, prefix: string): string {
  return spec.deletedColumn
    ? ` WHERE ${prefix}."${spec.deletedColumn}" IS NULL`
    : "";
}

function backfillStatement(spec: FtsEntitySpec): string {
  const base = physical(spec.entity);
  const fts = `fts_${base}`;
  return `INSERT INTO ${fts}(${insertColumnsOf(spec)})
SELECT ${valuesOf(spec, "b")} FROM ${base} b${liveGuardOf(spec, "b")};`;
}

function entityDdl(spec: FtsEntitySpec): string {
  assertNoSealedFtsColumns(spec);
  const base = physical(spec.entity);
  const fts = `fts_${base}`;
  const ftsColumns = [
    `${spec.idColumn} UNINDEXED`,
    ...spec.columns.map((c) => c.name),
  ];
  const insertColumns = insertColumnsOf(spec);
  const insertRow = `INSERT INTO ${fts}(${insertColumns}) SELECT ${valuesOf(spec, "new")}${liveGuardOf(spec, "new")};`;
  return `
CREATE VIRTUAL TABLE ${fts} USING fts5(
  ${ftsColumns.join(", ")},
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER ${fts}_ai AFTER INSERT ON ${base} BEGIN
  ${insertRow}
END;
CREATE TRIGGER ${fts}_au AFTER UPDATE ON ${base} BEGIN
  DELETE FROM ${fts} WHERE rowid = old.rowid;
  ${insertRow}
END;
CREATE TRIGGER ${fts}_ad AFTER DELETE ON ${base} BEGIN
  DELETE FROM ${fts} WHERE rowid = old.rowid;
END;
${backfillStatement(spec)}
`;
}

export const FTS_DDL: string = SPECS.map(entityDdl).join("\n");

const SPEC_BY_ENTITY: ReadonlyMap<string, FtsEntitySpec> = new Map(
  SPECS.map((s) => [s.entity, s])
);

export function rebuildFtsIndex(vault: DatabaseSync, entity: string): void {
  if (entity === "core.document") {
    throw new Error(
      "core.document has a derivative-aware FTS rebuild — use rebuildDocumentFtsIndex from schema/blob.js"
    );
  }
  const spec = SPEC_BY_ENTITY.get(entity);
  if (!spec) throw new Error(`not a searchable entity: ${entity}`);
  const fts = `fts_${physical(spec.entity)}`;
  vault.exec(`DELETE FROM ${fts};`);
  vault.exec(backfillStatement(spec));
}
