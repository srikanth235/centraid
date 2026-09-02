// The text-search plane: one FTS5 shadow table per text-bearing entity, kept
// in sync by AFTER INSERT/UPDATE/DELETE triggers on the base table. Search
// stays inside SQLite — the gateway's `search` walks the same consent
// pipeline as `read` but resolves matches through the index instead of
// shipping whole tables to callers (there is no upper bound on vault data).
//
// Canonical note/message bodies are not prose columns — they are data: URIs
// on the referenced core.content_item (rent the bytes, own the reference).
// Triggers therefore decode through `vault_content_text`, an app-defined
// function `openVaultDb` registers on every vault connection before
// migrations run. Only the gateway holds connections (§10), so the function
// is always present when a trigger fires.

import type { DatabaseSync } from "node:sqlite";

import { sealedColumnsOf } from "./sealed.js";
import { resolveEntity } from "./tables.js";

/** Decoded text of a canonical body, or null for anything non-text. */
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

/** Register `vault_content_text` on a vault connection (triggers call it). */
export function registerContentTextFn(db: DatabaseSync): void {
  db.function("vault_content_text", { deterministic: true }, contentText);
}

type FtsColumn =
  /** A text column of the base table itself. */
  | { name: string; kind: "column" }
  /** Decoded body of the core.content_item the base row references via `fk`. */
  | { name: string; kind: "content"; fk: string }
  /** core.content_item indexing its own uri (text media only). */
  | { name: string; kind: "self-content" };

export interface FtsEntitySpec {
  /** Logical entity, e.g. `knowledge.note`. */
  entity: string;
  /** Base-table PK, mirrored UNINDEXED into the fts table for joins. */
  idColumn: string;
  columns: FtsColumn[];
  /** Column that, when non-null, keeps the row out of the index (soft delete). */
  deletedColumn?: string;
}

// The baseline's spec list, in the order rung one composed it. Two entries
// are RETIRED by #883 (`social.contact_card`, `home.asset_item`) and rung
// seven drops their shadow tables, but rung one's text is history and stays
// byte-identical — so they live on here and are filtered out of `SPECS`, the
// live registry every other reader uses.
const RETIRED_ENTITIES: ReadonlySet<string> = new Set([
  "social.contact_card",
  "home.asset_item",
]);

const BASELINE_SPECS: readonly FtsEntitySpec[] = [
  {
    // Photo captions are stored as the content item's title. Keeping this a
    // direct-column surface makes the Photos grid search complete without
    // indexing blob bytes; soft-deleted content leaves the index immediately.
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
    // Documents are searched under their OWN identity, not the raw content
    // item (#352): title lives on core_document, body decodes through
    // whichever content item is current. blob.ts overrides this spec's
    // triggers to be derivative-aware (extracted PDF/scan text wins over the
    // raw decode), same as it always did for the parent row.
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
    // Owner memos (#274): the running note about a person, the remark
    // on a workout — annotations on canonical entities, searchable as text.
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
    // Disposed items stay in the index — disposal keeps the row as history,
    // and "where did that old dehumidifier go" is exactly a search question.
    entity: "home.asset_item",
    idColumn: "item_id",
    columns: [
      { name: "name", kind: "column" },
      { name: "serial_no", kind: "column" },
    ],
  },
  {
    // The CRM person's role line ("Eng lead · Portland") — the third search
    // surface People folds in beyond the party's name (core.party) and the
    // owner's running notes (knowledge.annotation).
    entity: "people.profile",
    idColumn: "profile_id",
    columns: [{ name: "role", kind: "column" }],
  },
  {
    // The locker's non-secret face (#310): title, username, url.
    // Sealed columns structurally cannot feed the index — the gate below
    // throws at DDL-build time (#293) — and `notes` stays out
    // deliberately: it routinely carries recovery codes.
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
    // "That dinner at Olive we split" is a search question (#310).
    entity: "tally.expense",
    idColumn: "expense_id",
    columns: [{ name: "description", kind: "column" }],
  },
];

/**
 * Spec changes applied to the LIVE registry only (#883). Rung one's text never
 * changes, so a patch here reaches an existing file the one way a generated
 * trigger body can: rung seven re-generates that entity's shadow table.
 */
const SPEC_PATCHES: Readonly<Record<string, Partial<FtsEntitySpec>>> = {
  // O-trash: Tasks and Agenda gained the trash pair, so a trashed row leaves
  // the index the moment it is trashed, exactly as Docs/Photos/Locker's does.
  "schedule.task": { deletedColumn: "deleted_at" },
  "core.event": { deletedColumn: "deleted_at" },
  // O-contact: `social.contact_card` retired and its display facts are the
  // profile's now, so the nickname stays searchable where the role already was.
  "people.profile": {
    columns: [
      { name: "role", kind: "column" },
      { name: "nickname", kind: "column" },
    ],
    // #916, R11 / review 9.1: both tables carry the trash pair and neither
    // declared it here, so a trashed profile and a trashed expense stayed
    // findable — search was the one surface the trash did not reach.
    deletedColumn: "deleted_at",
  },
  "tally.expense": { deletedColumn: "deleted_at" },
};

/**
 * Surfaces the pre-#916 schema never indexed (ruling ONT-12): search coverage
 * was by touch, so the names of an album, a notebook, a task project and a
 * circle were unfindable while the things inside them were not. Kept as its
 * own list rather than folded into `BASELINE_SPECS` so the ruling stays
 * legible next to what it added; both feed `SPECS` and the one baseline
 * creates every index in it.
 */
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

/** The baseline minus what #883 retired, plus its patches and #916's additions. */
const SPECS: readonly FtsEntitySpec[] = [
  ...BASELINE_SPECS.filter((spec) => !RETIRED_ENTITIES.has(spec.entity)).map(
    (spec) => ({ ...spec, ...SPEC_PATCHES[spec.entity] })
  ),
  ...ADDED_SPECS,
];

/** What the gateway needs to run (and consent-clamp) a search. */
export interface SearchableEntity {
  /** Physical FTS5 table. */
  fts: string;
  /** Base-table PK column (also the fts join column). */
  idColumn: string;
  /**
   * Base-table columns feeding the index. A grant field mask that hides any
   * of them fails a search closed — the index must never answer over text
   * the grant does not let the caller read.
   */
  maskColumns: readonly string[];
  /**
   * Entities whose content the index folds in beyond the base row (canonical
   * bodies). Each needs its own read consent before a search runs.
   */
  alsoConsent: readonly string[];
}

/**
 * THE REGISTRY OWNS THE NAME (#883). A spec names its entity logically and
 * asks `tables.ts` what that is physically. The mechanical fallback answers
 * for RETIRED entities only — the ones `BASELINE_SPECS` still carries because
 * rung one's text is history — and `assertFtsSpecsRegistered` proves nothing
 * live reaches it.
 */
function physical(entity: string): string {
  return resolveEntity(entity)?.physical ?? entity.replace(".", "_");
}

/**
 * Every live spec names a registered entity. Called by `migrateVault`, so an
 * unregistered spec fails at open rather than generating triggers over a name
 * nothing else can resolve.
 */
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

/** Logical entity → its search surface. Absence = not text-searchable. */
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

/**
 * Per-document index budget (#367). The shadow tables are a SEARCH index, not
 * a second copy: the canonical body stays complete and untruncated, and only
 * what feeds the index is capped. Anything past the cut is still searchable up
 * to it.
 */
export const FTS_BODY_INDEX_BUDGET_CHARS = 256 * 1024;

const TRUNCATION_MARKER = " ...(truncated for search index)";

/**
 * Cap a body-text SQL expression at `budgetChars`. `expr` is inlined twice
 * (length check + substr): trigger bodies are static DDL, so this must stay a
 * pure expression with no bound parameters.
 */
export function truncateForIndex(
  expr: string,
  budgetChars: number = FTS_BODY_INDEX_BUDGET_CHARS
): string {
  return `(CASE WHEN ${expr} IS NULL THEN NULL
                 WHEN length(${expr}) > ${budgetChars}
                 THEN substr(${expr}, 1, ${budgetChars}) || '${TRUNCATION_MARKER}'
                 ELSE ${expr} END)`;
}

/** Value expression for one indexed column, `prefix` = `new` or a base alias. */
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

/**
 * The structural FTS gate (#293): a sealed column can never feed a
 * text index, whatever a spec declares — the throw happens at DDL-build
 * time, so a bad declaration fails the migration, not the audit.
 */
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

/** Soft-deleted rows leave the index — the WHERE guard shared by every path that (re)builds it. */
function liveGuardOf(spec: FtsEntitySpec, prefix: string): string {
  return spec.deletedColumn
    ? ` WHERE ${prefix}."${spec.deletedColumn}" IS NULL`
    : "";
}

/**
 * The full-table backfill. Shared by the migration DDL and `rebuildFtsIndex`
 * so both apply the same truncation policy from one definition.
 */
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
  // detail= tuning (#367): left at the FTS5 default, detail=full.
  // detail=column/none shrink the index by dropping per-term POSITION data,
  // but snippet()/highlight() degrade to whole-column matches without it —
  // the owner-facing search surface (#274) uses snippet() for match
  // context, so that quality loss isn't free. The size problem detail=
  // would address is now handled at the source instead: the per-document
  // budget above bounds how much text ever reaches the index, and journal
  // archival (journal-archive.ts) keeps the OTHER fast-growing file small —
  // so detail=full's extra position data no longer has an unbounded body to
  // multiply against. Revisit only with evidence the index itself (not the
  // bodies feeding it) is the dominant cost.
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

/**
 * Every live index: shadow table, sync triggers, and a backfill that selects
 * nothing on a fresh file.
 *
 * Built from `SPECS` — the PATCHED registry — not from `BASELINE_SPECS`
 * (#916). Trigger bodies are static DDL, so a spec change used to reach a file
 * only by a rung dropping and re-creating the index; with the shape stated in
 * the baseline instead, the index a patch describes is simply the index a
 * fresh file gets. `BASELINE_SPECS` stays the place a spec is WRITTEN, and
 * `SPEC_PATCHES`/`ADDED_SPECS` the place later decisions amend it, so the
 * history of each decision stays legible next to it.
 */
export const FTS_DDL: string = SPECS.map(entityDdl).join("\n");

const SPEC_BY_ENTITY: ReadonlyMap<string, FtsEntitySpec> = new Map(
  SPECS.map((s) => [s.entity, s])
);

/**
 * Rebuild path (#367). FTS5's own `('rebuild')` re-derives only from what fts5
 * already stored, so it leaves the OLD truncation in place when
 * `FTS_BODY_INDEX_BUDGET_CHARS` or a spec changes; this re-runs the real
 * backfill from the base table instead.
 *
 * `core.document` is NOT covered here — `schema/blob.ts` overrides its
 * triggers with a derivative-aware body expression; use
 * `rebuildDocumentFtsIndex` for it.
 */
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
