import type { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";

interface UncoveredFk {
  table: string;
  columns: string[];
  toTable: string;
}

interface IndexColumns {
  name: string;
  columns: string[];
}

function findUncoveredForeignKeys(db: DatabaseSync): UncoveredFk[] {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  const uncovered: UncoveredFk[] = [];

  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      pk: number;
    }[];
    const pkColumns = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

    const indexList = db.prepare(`PRAGMA index_list(${table})`).all() as {
      name: string;
    }[];
    const indexColumnSets: IndexColumns[] = indexList.map((idx) => {
      const info = db.prepare(`PRAGMA index_info(${idx.name})`).all() as {
        name: string | null;
        seqno: number;
      }[];
      return {
        name: idx.name,
        columns: info
          .sort((a, b) => a.seqno - b.seqno)
          .map((r) => r.name)
          .filter((n): n is string => n !== null),
      };
    });
    if (pkColumns.length > 0) {
      indexColumnSets.push({ name: "(primary key)", columns: pkColumns });
    }

    const fkRows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      id: number;
      seq: number;
      table: string;
      from: string;
    }[];
    const byId = new Map<number, typeof fkRows>();
    for (const row of fkRows) {
      const group = byId.get(row.id) ?? [];
      group.push(row);
      byId.set(row.id, group);
    }

    for (const group of byId.values()) {
      group.sort((a, b) => a.seq - b.seq);
      const fromColumns = group.map((r) => r.from);
      const toTable = group[0]!.table;
      const covered = indexColumnSets.some((ix) => {
        if (ix.columns.length < fromColumns.length) return false;
        return fromColumns.every((c, i) => ix.columns[i] === c);
      });
      if (!covered) {
        uncovered.push({ table, columns: fromColumns, toTable });
      }
    }
  }

  return uncovered;
}

function describeUncovered(items: UncoveredFk[]): string {
  return items
    .map((u) => `${u.table}.${u.columns.join(",")} -> ${u.toTable}`)
    .join("\n  ");
}

describe("fk-index", () => {
  test("every vault.db FK child column-set is covered by a leftmost index prefix", () => {
    const { vault, close } = openVaultDb();
    try {
      const uncovered = findUncoveredForeignKeys(vault);
      expect(
        uncovered,
        `uncovered FK child columns:\n  ${describeUncovered(uncovered)}`
      ).toStrictEqual([]);
    } finally {
      close();
    }
  });
});
