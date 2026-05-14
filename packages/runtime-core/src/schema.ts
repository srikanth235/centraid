import { DatabaseSync } from 'node:sqlite';

/**
 * JSON-serializable summary of an app's `data.sqlite` schema.
 *
 * Returned by `GET /centraid/_apps/<id>/schema`. Consumed by the agent
 * harness to inject live schema into the system prompt before the agent
 * authors a new migration.
 */
export interface AppSchema {
  /** `PRAGMA user_version` — the highest applied migration id. */
  schemaVersion: number;
  tables: AppSchemaTable[];
  indexes: AppSchemaIndex[];
  views: AppSchemaView[];
}

export interface AppSchemaTable {
  name: string;
  /** The original `CREATE TABLE …` statement, as stored by sqlite. */
  sql: string | null;
  columns: AppSchemaColumn[];
}

export interface AppSchemaColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt_value: string | null;
}

export interface AppSchemaIndex {
  name: string;
  tbl_name: string;
  sql: string;
}

export interface AppSchemaView {
  name: string;
  sql: string;
}

/**
 * Read the live schema from `dataDbFile`. Internal `sqlite_*` rows and
 * auto-generated indexes are excluded. The DB file is created if missing
 * (which is the desired behavior for a freshly registered app with no
 * migrations applied yet — the result is just `schemaVersion: 0` plus
 * empty arrays).
 */
export function readAppSchema(dataDbFile: string): AppSchema {
  const db = new DatabaseSync(dataDbFile);
  try {
    const userVersionRow = db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const schemaVersion = userVersionRow?.user_version ?? 0;

    const tableRows = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string | null }>;

    const tables: AppSchemaTable[] = tableRows.map((t) => {
      const cols = db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>;
      return {
        name: t.name,
        sql: t.sql,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          notnull: c.notnull !== 0,
          pk: c.pk !== 0,
          dflt_value: c.dflt_value,
        })),
      };
    });

    const indexes = db
      .prepare(
        `SELECT name, tbl_name, sql FROM sqlite_master
         WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' AND sql IS NOT NULL
         ORDER BY name`,
      )
      .all() as unknown as AppSchemaIndex[];

    const views = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'view' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as unknown as AppSchemaView[];

    return { schemaVersion, tables, indexes, views };
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
