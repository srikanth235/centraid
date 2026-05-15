/**
 * Three custom pi-coding-agent tools that let the data-chat agent read and
 * write a deployed centraid app's SQLite over the runtime's HTTP surface:
 *
 *   - centraid_sql_describe → GET  /centraid/_apps/{appId}/schema
 *   - centraid_sql_read → POST /centraid/_apps/{appId}/query  (SELECT only)
 *   - centraid_sql_write  → POST /centraid/_apps/{appId}/query  (INSERT/UPDATE/DELETE/REPLACE only)
 *
 * Scoping: each factory closes over a single `appId`. The tool schema does
 * NOT expose an `appId` parameter — the model can't target a different app,
 * which is the in-process equivalent of the openclaw `before_tool_call`
 * cross-check used in the remote-only path.
 *
 * Both wire endpoints exist on the embedded local runtime and on remote
 * OpenClaw, so this tool set works in both desktop runtime modes.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fetchAppSchema, runAppQuery, type HarnessConfig } from '@centraid/builder-harness';

export interface CentraidSqlToolsOptions {
  /** Resolved harness config — selects local-runtime or remote URL+token. */
  config: HarnessConfig;
  /** App id the chat is scoped to. The model cannot read/write any other app. */
  appId: string;
  /** Max rows surfaced to the model per SELECT. Defaults to 50. */
  selectRowCap?: number;
}

/**
 * Reject anything that isn't a bare SELECT/EXPLAIN. Mirrors the openclaw
 * plugin's guard so the data-chat tool set has the same blast radius.
 */
export function isSelectOnly(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'EXPLAIN') return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma)\b/i.test(
    stripped,
  );
}

/**
 * Row-mutating DML only — INSERT/UPDATE/DELETE/REPLACE. DDL and PRAGMA are
 * deliberately refused so the model can't reshape the schema; migrations
 * remain the app author's job.
 */
export function isWriteDml(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'INSERT' && first !== 'UPDATE' && first !== 'DELETE' && first !== 'REPLACE') {
    return false;
  }
  return !/\b(drop|alter|create|attach|detach|vacuum|reindex|pragma)\b/i.test(stripped);
}

function textResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

const GetSchemaParams = Type.Object({});

const SqlParams = Type.Object({
  sql: Type.String({
    description: 'A single SQL statement. No semicolons mid-statement.',
  }),
});

export function createCentraidSqlDescribeTool(opts: CentraidSqlToolsOptions): ToolDefinition {
  const { config, appId } = opts;
  return defineTool({
    name: 'centraid_sql_describe',
    label: 'Centraid: get app schema',
    description:
      "Return the tables, columns, indexes, and views of this app's SQLite database. " +
      'Call this before issuing centraid_sql_read / centraid_sql_write so you target real tables and columns.',
    promptSnippet: "centraid_sql_describe — list this app's tables, columns, indexes, and views.",
    parameters: GetSchemaParams,
    executionMode: 'sequential',
    async execute() {
      const schema = await fetchAppSchema(config, appId);
      if (!schema) {
        // 404 / 503 / 409 from the runtime → app has no live schema yet.
        const payload = { tables: [], views: [], indexes: [], note: 'app has no live schema yet' };
        return textResult(JSON.stringify(payload), payload);
      }
      const compact = {
        schemaVersion: schema.schemaVersion,
        tables: schema.tables.map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({
            name: c.name,
            type: c.type,
            notnull: c.notnull,
            pk: c.pk,
          })),
        })),
        views: schema.views.map((v) => v.name),
        indexes: schema.indexes.map((i) => ({ name: i.name, table: i.tbl_name })),
      };
      return textResult(JSON.stringify(compact), compact);
    },
  });
}

export function createCentraidSqlReadTool(opts: CentraidSqlToolsOptions): ToolDefinition {
  const { config, appId } = opts;
  const cap = opts.selectRowCap ?? 50;
  return defineTool({
    name: 'centraid_sql_read',
    label: 'Centraid: run SELECT',
    description:
      "Run a single SELECT statement against this app's SQLite database and return the rows. " +
      'Reads only; INSERT/UPDATE/DELETE/DDL are refused — use centraid_sql_write for mutations.',
    promptSnippet: 'centraid_sql_read — run a single SELECT/EXPLAIN and get rows back.',
    parameters: SqlParams,
    executionMode: 'sequential',
    async execute(_id, params) {
      const sql = params.sql;
      if (!isSelectOnly(sql)) {
        throw new Error('only SELECT (or EXPLAIN) statements are allowed.');
      }
      const result = await runAppQuery(config, appId, sql);
      if (result.kind !== 'rows') {
        throw new Error('query produced a write result, not rows.');
      }
      const trimmed = result.rows.slice(0, cap);
      const payload = {
        columns: result.columns,
        rows: trimmed,
        totalRows: result.rows.length,
        truncated: result.rows.length > trimmed.length,
        durationMs: result.durationMs,
      };
      return textResult(JSON.stringify(payload), payload);
    },
  });
}

export function createCentraidSqlWriteTool(opts: CentraidSqlToolsOptions): ToolDefinition {
  const { config, appId } = opts;
  return defineTool({
    name: 'centraid_sql_write',
    label: 'Centraid: run INSERT/UPDATE/DELETE',
    description:
      "Run a single INSERT, UPDATE, DELETE, or REPLACE statement against this app's SQLite database. " +
      'Returns rowsAffected and lastInsertRowid. DDL (CREATE/ALTER/DROP) and PRAGMA are refused — call centraid_sql_describe first to confirm tables and columns.',
    promptSnippet:
      'centraid_sql_write — run a single INSERT/UPDATE/DELETE/REPLACE and get side effects.',
    parameters: SqlParams,
    executionMode: 'sequential',
    async execute(_id, params) {
      const sql = params.sql;
      if (!isWriteDml(sql)) {
        throw new Error(
          'only INSERT/UPDATE/DELETE/REPLACE are allowed; DDL and PRAGMA are refused.',
        );
      }
      const result = await runAppQuery(config, appId, sql);
      if (result.kind !== 'exec') {
        throw new Error('statement produced rows, not an exec result.');
      }
      const payload = {
        rowsAffected: result.rowsAffected,
        lastInsertRowid:
          typeof result.lastInsertRowid === 'bigint'
            ? result.lastInsertRowid.toString()
            : result.lastInsertRowid,
        durationMs: result.durationMs,
      };
      return textResult(JSON.stringify(payload), payload);
    },
  });
}

/**
 * Convenience: the full trio bound to one (config, appId) pair, in the order
 * the data-chat factory passes them to `customTools`.
 */
export function createCentraidSqlTools(opts: CentraidSqlToolsOptions): ToolDefinition[] {
  return [
    createCentraidSqlDescribeTool(opts),
    createCentraidSqlReadTool(opts),
    createCentraidSqlWriteTool(opts),
  ];
}
