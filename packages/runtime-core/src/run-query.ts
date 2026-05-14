import { DatabaseSync } from 'node:sqlite';

/**
 * Execute one SQL statement against an app's `data.sqlite` for the Cloud →
 * SQL editor. Read-style statements (SELECT/PRAGMA/EXPLAIN/WITH/VALUES) come
 * back as `{ kind: 'rows' }`; everything else (INSERT/UPDATE/DELETE/DDL)
 * comes back as `{ kind: 'exec' }` with row-count metadata.
 *
 * Only one statement is accepted per call — multiple `;`-separated
 * statements are rejected. This keeps result reporting unambiguous and
 * matches what a Supabase-style editor's "Run" button does per Cmd-Enter.
 */
export type RunQueryResult =
  | {
      kind: 'rows';
      columns: string[];
      rows: Array<Record<string, unknown>>;
      durationMs: number;
    }
  | {
      kind: 'exec';
      rowsAffected: number;
      lastInsertRowid: number | bigint | null;
      durationMs: number;
    };

export class RunQueryError extends Error {
  constructor(
    public readonly code: 'bad_request' | 'sql_error',
    message: string,
  ) {
    super(message);
    this.name = 'RunQueryError';
  }
}

/** Hard cap on rows returned to the UI — protects from runaway `SELECT *`. */
export const RUN_QUERY_ROW_CAP = 1000;

export function runQuery(dataDbFile: string, sql: string): RunQueryResult {
  const cleaned = stripLeadingTriviaAndCheckSingle(sql);
  if (!cleaned.statement) {
    throw new RunQueryError('bad_request', 'No SQL statement provided.');
  }
  if (cleaned.multiStatement) {
    throw new RunQueryError(
      'bad_request',
      'Run one statement at a time. Remove extra semicolons or split statements into separate runs.',
    );
  }

  const isRead = isReadStatement(cleaned.statement);
  const db = new DatabaseSync(dataDbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const started = performance.now();
  try {
    const stmt = db.prepare(cleaned.statement);
    if (isRead) {
      const rows = stmt.all() as Array<Record<string, unknown>>;
      const capped = rows.slice(0, RUN_QUERY_ROW_CAP);
      // Column order from the first row preserves SQL projection order;
      // empty result sets fall back to no columns.
      const columns = capped[0] ? Object.keys(capped[0]) : [];
      return {
        kind: 'rows',
        columns,
        rows: capped,
        durationMs: Math.round(performance.now() - started),
      };
    }

    const r = stmt.run();
    return {
      kind: 'exec',
      rowsAffected: Number(r.changes ?? 0),
      lastInsertRowid: normalizeRowid(r.lastInsertRowid),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    throw new RunQueryError('sql_error', err instanceof Error ? err.message : String(err));
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}

function normalizeRowid(v: unknown): number | bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  return null;
}

const READ_KEYWORDS = new Set(['SELECT', 'PRAGMA', 'EXPLAIN', 'WITH', 'VALUES']);

function isReadStatement(sql: string): boolean {
  const first = sql.match(/^\s*(\w+)/)?.[1]?.toUpperCase();
  if (!first) return false;
  return READ_KEYWORDS.has(first);
}

/**
 * Strip leading whitespace and comments, then verify only a single SQL
 * statement is present. Returns the cleaned statement (no trailing `;`).
 *
 * A trailing `;` followed only by whitespace/comments is allowed; anything
 * after that counts as a second statement and gets rejected.
 */
function stripLeadingTriviaAndCheckSingle(sql: string): {
  statement: string;
  multiStatement: boolean;
} {
  const trimmed = sql.trim();
  if (!trimmed) return { statement: '', multiStatement: false };

  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let firstNonTriviaAt = -1;
  let lastNonTriviaAt = -1;
  let semiAt = -1;
  let trailingTriviaOnly = true;

  while (i < trimmed.length) {
    const ch = trimmed[i] ?? '';
    const next = trimmed[i + 1] ?? '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      if (firstNonTriviaAt === -1) firstNonTriviaAt = i;
      lastNonTriviaAt = i;
      trailingTriviaOnly = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (next === '"') {
          i += 2;
          continue;
        }
        inDouble = false;
      }
      if (firstNonTriviaAt === -1) firstNonTriviaAt = i;
      lastNonTriviaAt = i;
      trailingTriviaOnly = false;
      i++;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      if (firstNonTriviaAt === -1) firstNonTriviaAt = i;
      lastNonTriviaAt = i;
      trailingTriviaOnly = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      if (firstNonTriviaAt === -1) firstNonTriviaAt = i;
      lastNonTriviaAt = i;
      trailingTriviaOnly = false;
      i++;
      continue;
    }
    if (ch === ';') {
      if (semiAt === -1) {
        semiAt = i;
        trailingTriviaOnly = true;
      } else {
        // A second semicolon outside strings/comments — multiple statements.
        return { statement: '', multiStatement: true };
      }
      i++;
      continue;
    }
    if (!/\s/.test(ch)) {
      if (semiAt !== -1) {
        // Real content past the first `;` — multiple statements.
        return { statement: '', multiStatement: true };
      }
      if (firstNonTriviaAt === -1) firstNonTriviaAt = i;
      lastNonTriviaAt = i;
      trailingTriviaOnly = false;
    }
    i++;
  }

  if (semiAt !== -1 && !trailingTriviaOnly) {
    return { statement: '', multiStatement: true };
  }

  if (firstNonTriviaAt === -1) return { statement: '', multiStatement: false };
  const end = semiAt === -1 ? lastNonTriviaAt + 1 : semiAt;
  const statement = trimmed.slice(firstNonTriviaAt, end).trim();
  return { statement, multiStatement: false };
}
