import { DatabaseSync } from 'node:sqlite';

/**
 * Row-browser payload for the Cloud → Database panel.
 *
 * `rows` carries SQLite native types verbatim — integers, floats, strings,
 * `null`, and `Buffer` (which `JSON.stringify` renders as `{ type: 'Buffer',
 * data: [...] }`). The renderer decides how to display each cell.
 */
export interface AppTableRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  totalCount: number;
  limit: number;
  offset: number;
}

export const TABLE_ROWS_MAX_LIMIT = 200;
export const TABLE_ROWS_DEFAULT_LIMIT = 50;

export class TableRowsError extends Error {
  constructor(
    public readonly code: 'unknown_table' | 'bad_request',
    message: string,
  ) {
    super(message);
    this.name = 'TableRowsError';
  }
}

/**
 * Read a page of rows from a table in `dataDbFile`. The table name is
 * validated against `sqlite_master` before being interpolated, so callers
 * can pass user input from the URL path without risking SQL injection.
 */
export function readTableRows(
  dataDbFile: string,
  tableName: string,
  opts: { limit?: number; offset?: number } = {},
): AppTableRows {
  const limit = clamp(opts.limit ?? TABLE_ROWS_DEFAULT_LIMIT, 1, TABLE_ROWS_MAX_LIMIT);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const db = new DatabaseSync(dataDbFile);
  try {
    const exists = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view') AND name = ? AND name NOT LIKE 'sqlite_%'`,
      )
      .get(tableName) as { name: string } | undefined;
    if (!exists) {
      throw new TableRowsError('unknown_table', `Table or view "${tableName}" does not exist.`);
    }

    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{
      name: string;
    }>;
    const columns = cols.map((c) => c.name);

    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(tableName)}`).get() as {
      n: number | bigint;
    };
    const totalCount = Number(countRow.n);

    const rows = db
      .prepare(`SELECT * FROM ${quoteIdent(tableName)} LIMIT ? OFFSET ?`)
      .all(limit, offset) as Array<Record<string, unknown>>;

    return { columns, rows, totalCount, limit, offset };
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
