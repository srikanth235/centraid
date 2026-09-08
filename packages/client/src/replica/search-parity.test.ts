/*
 * The replica's local search surface is a PROJECTION of the vault's FTS specs
 * (#883, ruling O-label): WHICH entities rank offline is this seat's decision,
 * but their names and columns are the vault's, and this pins them.
 *
 * A SOURCE SCAN, not an import: `@centraid/vault` is Node-only and not a
 * dependency of this package.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPLICA_LOCAL_SEARCH, replicaSearchTables } from "./search.js";
import { seatSearchStatement } from "./seat/search-page.js";

const FTS_PATH = path.resolve(
  import.meta.dirname,
  "../../../vault/src/schema/fts.ts"
);

interface ScannedSpec {
  entity: string;
  /** Direct columns only: a content body is never held eagerly. */
  columns: string[];
  deletedColumn?: string;
  /** The base-table PK the shadow table mirrors UNINDEXED, and the join key. */
  idColumn: string;
}

function scanFtsSpecs(): Map<string, ScannedSpec> {
  const source = readFileSync(FTS_PATH, "utf8");
  const retired = new Set(
    [
      ...(
        /const RETIRED_ENTITIES[^;]*?new Set\(\[(?<body>[^\]]*)\]/su.exec(
          source
        )?.groups?.body ?? ""
      ).matchAll(/"(?<entity>[a-z_]+\.[a-z_]+)"/gu),
    ].map((match) => match.groups!.entity!)
  );
  const specs = new Map<string, ScannedSpec>();
  // SPLIT ON THE ENTITY, THEN READ THE FIELDS. One regex over the whole spec
  // body cannot be written positionally: `core.content_item` carries `foldsIn`
  // AFTER `deletedColumn`, and a pattern that expected the closing brace next
  // silently dropped the soft-delete column — which is a search that keeps
  // showing rows the member deleted.
  const chunks = source.split(/\n\s*entity:\s*"/u).slice(1);
  for (const chunk of chunks) {
    const entity = /^(?<entity>[a-z_]+\.[a-z_]+)"/u.exec(chunk)?.groups?.entity;
    if (!entity || retired.has(entity)) continue;
    const id = /idColumn:\s*"(?<id>\w+)"/u.exec(chunk)?.groups?.id;
    const columns = /columns:\s*\[(?<columns>.*?)\],\n/su.exec(chunk)?.groups
      ?.columns;
    if (!id || columns === undefined) continue;
    const deleted = /deletedColumn:\s*"(?<column>\w+)"/u.exec(chunk)?.groups
      ?.column;
    specs.set(entity, {
      entity,
      idColumn: id,
      columns: columnsOf(columns),
      ...(deleted ? { deletedColumn: deleted } : {}),
    });
  }
  for (const [entity, patch] of scanPatches(source)) {
    const spec = specs.get(entity);
    if (spec) specs.set(entity, { ...spec, ...patch });
  }
  return specs;
}

function columnsOf(body: string): string[] {
  return [
    ...body.matchAll(
      /\{\s*name:\s*"(?<name>\w+)",\s*kind:\s*"(?<kind>[a-z-]+)"/gu
    ),
  ]
    .filter((match) => match.groups!.kind === "column")
    .map((match) => match.groups!.name!);
}

function scanPatches(source: string): Map<string, Partial<ScannedSpec>> {
  const body =
    /const SPEC_PATCHES[^=]*=\s*\{(?<body>.*?)\n\};/su.exec(source)?.groups
      ?.body ?? "";
  const patches = new Map<string, Partial<ScannedSpec>>();
  // One level of nesting, which is as deep as a spec patch goes.
  for (const entry of body.matchAll(
    /"(?<entity>[a-z_]+\.[a-z_]+)":\s*\{(?<patch>(?:[^{}]|\{[^{}]*\})*)\}/gu
  )) {
    const patch: Partial<ScannedSpec> = {};
    const deleted = /deletedColumn:\s*"(?<column>\w+)"/u.exec(
      entry.groups!.patch!
    );
    if (deleted) patch.deletedColumn = deleted.groups!.column!;
    if (entry.groups!.patch!.includes("columns:"))
      patch.columns = columnsOf(entry.groups!.patch!);
    patches.set(entry.groups!.entity!, patch);
  }
  return patches;
}

describe("replica local search mirrors the vault's FTS specs", () => {
  const specs = scanFtsSpecs();

  it("the scan found the vault's live spec list", () => {
    // Anti-vacuity: a regex that stopped matching would pass every claim below.
    expect(specs.size).toBeGreaterThanOrEqual(
      Object.keys(REPLICA_LOCAL_SEARCH).length
    );
    expect(specs.has("core.party")).toBe(true);
    expect(specs.has("social.contact_card")).toBe(false);
  });

  it.each(Object.keys(REPLICA_LOCAL_SEARCH))(
    "%s names a live FTS entity and carries its columns",
    (entity) => {
      const spec = specs.get(entity);
      expect(spec, `${entity} is not a live searchable entity`).toBeDefined();
      const local = REPLICA_LOCAL_SEARCH[entity]!;
      expect([...local.columns].toSorted()).toStrictEqual(
        [...spec!.columns].toSorted()
      );
      expect(local.deletedColumn).toBe(spec!.deletedColumn);
      // A SEAT SEARCH JOINS ON THIS (#996, W5-D1). The shadow table mirrors the
      // base PK UNINDEXED under the vault's name for it; a client that guessed
      // a different one would join nothing and report an empty search.
      expect(local.idColumn).toBe(spec!.idColumn);
    }
  );

  it.each(Object.keys(REPLICA_LOCAL_SEARCH))(
    "%s resolves to the physical names the vault composes",
    (entity) => {
      // The vault owns the name (#883, ruling O-label): `resolveEntity`
      // composes `schema_table` and `schema/fts.ts` prefixes `fts_`. This pins
      // the client's derivation to those two spellings in the vault's source,
      // so a registry that renamed a table cannot leave a seat searching a
      // table that is not there.
      const source = readFileSync(FTS_PATH, "utf8");
      const tablesSource = readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../vault/src/schema/tables.ts"
        ),
        "utf8"
      );
      // REGEXES, not strings: both spellings are template literals in the
      // vault's source, and `${…}` inside a plain string is a placeholder that
      // never interpolates — which the lint rule is right to refuse.
      expect(tablesSource).toMatch(/physical: `\$\{schema\}_\$\{table\}`/u);
      expect(source).toMatch(/`fts_\$\{physical\(spec\.entity\)\}`/u);
      const { base, fts } = replicaSearchTables(entity);
      const [schema, table] = entity.split(".");
      expect(base).toBe(`${schema}_${table}`);
      expect(fts).toBe(`fts_${base}`);
    }
  );

  it("the seat's statement is the gateway's statement (#996, W5-D1)", () => {
    // A SOURCE PIN, not a second implementation. `seat/search-page.ts` says it
    // mirrors `vault/src/gateway/search.ts`; a comment that says so is a
    // comment, and the two would drift the first time either was edited. So
    // the gateway's own SELECT tail, JOIN and ORDER BY are read out of its
    // source and compared to what the seat actually emits.
    //
    // The door's half — the grant row filter, the caller's filters and the R17
    // field mask — is DELIBERATELY absent from the seat's: a seat's file is
    // already the rows this member may see (W4-D2, R12). That subtraction is
    // the only difference, and it is asserted rather than assumed.
    const gateway = readFileSync(
      path.resolve(import.meta.dirname, "../../../vault/src/gateway/search.ts"),
      "utf8"
    );
    for (const fragment of [
      /rank AS _rank/u,
      /snippet\(\$\{spec\.fts\}, -1, '⟦', '⟧', '…', 12\) AS _snippet/u,
      /JOIN "\$\{ref\.physical\}" b ON b\."\$\{spec\.idColumn\}" = \$\{spec\.fts\}\."\$\{spec\.idColumn\}"/u,
      /ORDER BY \$\{spec\.fts\}\.rank, b\."\$\{spec\.idColumn\}"/u,
    ])
      expect(gateway, `the gateway still spells ${String(fragment)}`).toMatch(
        fragment
      );
    expect(gateway).toMatch(
      /Math\.min\(Math\.max\(request\.limit \?\? 100, 1\), 1000\)/u
    );

    const seat = seatSearchStatement({
      entity: "schedule.task",
      query: "ferry",
    });
    expect(seat.sql).toContain("fts_schedule_task.rank AS _rank");
    expect(seat.sql).toContain(
      "snippet(fts_schedule_task, -1, '⟦', '⟧', '…', 12) AS _snippet"
    );
    expect(seat.sql).toContain(
      'JOIN "schedule_task" b ON b."task_id" = fts_schedule_task."task_id"'
    );
    expect(seat.sql).toContain(
      'ORDER BY fts_schedule_task.rank, b."task_id" LIMIT ?'
    );
    // The door's half, absent by design.
    expect(seat.sql).not.toContain("access_");
    expect(seat.sql).not.toMatch(/fieldMask|rowFilter/u);
  });
});
