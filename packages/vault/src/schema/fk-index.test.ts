// Regression guard for issue #374 (SQLite hardening, Tier 2): SQLite never
// auto-indexes the child side of a foreign key. With `PRAGMA foreign_keys =
// ON` (always on — see ../db.ts) every DELETE/UPDATE on a parent row full-
// scans any child table whose FK columns aren't covered by an index, and
// commands/merge.ts re-points FKs via UPDATE...WHERE fk=old across every
// child table. This walks the live schema (both vault.db and journal.db)
// and asserts every FK child column-set is covered as the LEFTMOST prefix
// of some index — an explicit one, or the implicit index SQLite gives a
// rowid table's TEXT PRIMARY KEY / UNIQUE constraint, or a WITHOUT ROWID
// table's own PRIMARY KEY.
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { openVaultDb } from '../db.js';

interface UncoveredFk {
  table: string;
  columns: string[];
  toTable: string;
}

interface IndexColumns {
  name: string;
  columns: string[];
}

/** Every user table's FK child column-sets not covered as a leftmost index
 * prefix. Excludes sqlite_% internal tables (fts5 shadow tables are never
 * declared in these schema modules — see the header note in fts.ts). */
function findUncoveredForeignKeys(db: DatabaseSync): UncoveredFk[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
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

    const indexList = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
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
    // A rowid-alias INTEGER PRIMARY KEY, or a WITHOUT ROWID table's PK,
    // covers its column sequence as an index even though it may not
    // (always, for the rowid-alias case) surface in PRAGMA index_list.
    if (pkColumns.length > 0) {
      indexColumnSets.push({ name: '(primary key)', columns: pkColumns });
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
  return items.map((u) => `${u.table}.${u.columns.join(',')} -> ${u.toTable}`).join('\n  ');
}

test('every vault.db FK child column-set is covered by a leftmost index prefix', () => {
  const { vault, journal, close } = openVaultDb();
  try {
    const uncovered = findUncoveredForeignKeys(vault);
    expect(uncovered, `uncovered FK child columns:\n  ${describeUncovered(uncovered)}`).toEqual([]);
  } finally {
    close();
    // journal is closed by close() too; referencing it keeps the pair open
    // together for the duration of the assertion above.
    void journal;
  }
});

test('every journal.db FK child column-set is covered by a leftmost index prefix', () => {
  const { journal, close } = openVaultDb();
  try {
    const uncovered = findUncoveredForeignKeys(journal);
    expect(uncovered, `uncovered FK child columns:\n  ${describeUncovered(uncovered)}`).toEqual([]);
  } finally {
    close();
  }
});
