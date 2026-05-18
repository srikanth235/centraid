#!/usr/bin/env node
/*
 * stdio MCP server exposing the three `centraid_sql_*` tools to a locally
 * spawned coding CLI (Codex or Claude Code). The local-chat-runner starts
 * one of these per chat-window session and hands the spawn command to the
 * CLI; the CLI manages the lifecycle from there.
 *
 * The server is a standalone Node entrypoint (built into `dist/`) so a
 * subprocess can `node /path/to/centraid-mcp-server.js --apps-dir ... --app-id ...`
 * without pulling Electron / the Electron main process state. Database
 * access uses `runQuery` / `readAppSchema` from `@centraid/runtime-core`,
 * which operate on file paths — no in-process state is shared.
 *
 * AppId scoping is enforced HERE, at the tool boundary. The spawn args
 * pin one appId; the model cannot reach into another app's data even if
 * it fabricates a tool parameter, because the appId comes from argv, not
 * the parameters.
 *
 * Modes:
 *  - `--mode full` (default) exposes describe / read / write.
 *  - `--mode data` is identical for now (the data-mode lockdown happens
 *    on the CLI side via permission flags + tool allowlists; the MCP
 *    server has the same surface either way).
 */

import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readAppSchema, runQuery, RunQueryError } from '@centraid/runtime-core';

interface Args {
  appsDir: string;
  appId: string;
  selectRowCap: number;
}

function parseArgs(argv: string[]): Args {
  let appsDir = '';
  let appId = '';
  let selectRowCap = 50;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apps-dir') appsDir = argv[++i] ?? '';
    else if (a === '--app-id') appId = argv[++i] ?? '';
    else if (a === '--select-row-cap') selectRowCap = Number(argv[++i] ?? '50') || 50;
  }
  if (!appsDir || !appId) {
    process.stderr.write('centraid-mcp-server: --apps-dir <path> and --app-id <id> are required\n');
    process.exit(2);
  }
  return { appsDir, appId, selectRowCap };
}

function isSelectOnly(sql: string): boolean {
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

function isWriteDml(sql: string): boolean {
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

const TOOLS = [
  {
    name: 'centraid_sql_describe',
    description:
      "Return the tables, columns, indexes, and views of this app's SQLite database. " +
      'Call this before issuing centraid_sql_read / centraid_sql_write so you target real tables and columns.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'centraid_sql_read',
    description:
      "Run a single SELECT statement against this app's SQLite database and return the rows. " +
      'Reads only; INSERT/UPDATE/DELETE/DDL are refused.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A single SELECT or EXPLAIN statement.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'centraid_sql_write',
    description:
      "Run a single INSERT/UPDATE/DELETE/REPLACE statement against this app's SQLite database. " +
      'DDL (CREATE/ALTER/DROP) and PRAGMA are refused.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A single INSERT/UPDATE/DELETE/REPLACE statement.' },
      },
      required: ['sql'],
    },
  },
];

function dataFileFor(args: Args): string {
  return path.join(args.appsDir, args.appId, 'data.sqlite');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = new Server(
    {
      name: 'centraid',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'centraid_sql_describe') {
      try {
        const schema = readAppSchema(dataFileFor(args));
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
        return {
          content: [{ type: 'text', text: JSON.stringify(compact) }],
        };
      } catch (err) {
        return errorResult(err);
      }
    }

    if (name === 'centraid_sql_read') {
      const sql = typeof rawArgs.sql === 'string' ? rawArgs.sql : '';
      if (!isSelectOnly(sql)) {
        return textResult('only SELECT (or EXPLAIN) statements are allowed.', true);
      }
      try {
        const result = runQuery(dataFileFor(args), sql);
        if (result.kind !== 'rows') {
          return textResult('query produced a write result, not rows.', true);
        }
        const trimmed = result.rows.slice(0, args.selectRowCap);
        const payload = {
          columns: result.columns,
          rows: trimmed,
          totalRows: result.rows.length,
          truncated: result.rows.length > trimmed.length,
          durationMs: result.durationMs,
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult(err);
      }
    }

    if (name === 'centraid_sql_write') {
      const sql = typeof rawArgs.sql === 'string' ? rawArgs.sql : '';
      if (!isWriteDml(sql)) {
        return textResult(
          'only INSERT/UPDATE/DELETE/REPLACE are allowed; DDL and PRAGMA are refused.',
          true,
        );
      }
      try {
        const result = runQuery(dataFileFor(args), sql);
        if (result.kind !== 'exec') {
          return textResult('statement produced rows, not an exec result.', true);
        }
        const payload = {
          rowsAffected: result.rowsAffected,
          lastInsertRowid:
            typeof result.lastInsertRowid === 'bigint'
              ? result.lastInsertRowid.toString()
              : result.lastInsertRowid,
          durationMs: result.durationMs,
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      } catch (err) {
        return errorResult(err);
      }
    }

    return textResult(`unknown tool: ${name}`, true);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function textResult(
  text: string,
  isError = false,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): ReturnType<typeof textResult> {
  if (err instanceof RunQueryError) {
    return textResult(`${err.code}: ${err.message}`, true);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return textResult(`error: ${msg}`, true);
}

main().catch((err) => {
  process.stderr.write(
    `centraid-mcp-server fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
