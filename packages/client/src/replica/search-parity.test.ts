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

import { REPLICA_LOCAL_SEARCH } from "./search.js";

const FTS_PATH = path.resolve(
  import.meta.dirname,
  "../../../vault/src/schema/fts.ts"
);

interface ScannedSpec {
  entity: string;
  /** Direct columns only: a content body is never held eagerly. */
  columns: string[];
  deletedColumn?: string;
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
  const blocks = source.matchAll(
    /entity:\s*"(?<entity>[a-z_]+\.[a-z_]+)",\s*\n\s*idColumn:\s*"(?<id>\w+)",\s*\n\s*columns:\s*\[(?<columns>.*?)\],\s*\n(?<tail>\s*deletedColumn:\s*"(?<deleted>\w+)",\s*\n)?\s*\}/gsu
  );
  for (const block of blocks) {
    const entity = block.groups!.entity!;
    if (retired.has(entity)) continue;
    specs.set(entity, {
      entity,
      columns: columnsOf(block.groups!.columns!),
      ...(block.groups?.deleted ? { deletedColumn: block.groups.deleted } : {}),
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
    }
  );
});
