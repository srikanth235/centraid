/*
 * Build the app-context system prompt fragment the runtime-core injects
 * into every chat turn before delegating to the host's `ChatRunner`.
 *
 * Both adapters splice this verbatim into their own system-prompt mechanism:
 *   - OpenClaw runner → `extraSystemPrompt` on `runEmbeddedAgent`
 *   - codex/claude-code adapters → CLI system-prompt flag
 *
 * Lives in runtime-core so all hosts see identical app context. The runner
 * never assembles app-specific content itself.
 */

import type { AppSchema } from './schema.js';
import type { ChatMode } from './chat-runner.js';

export interface BuildExtraPromptInput {
  appId: string;
  appName?: string;
  appDescription?: string;
  mode: ChatMode;
  schema: AppSchema;
}

/**
 * Compose the system-prompt fragment. Two flavors:
 *
 * - **full mode** (default): a brief app-context block. The user's main
 *   agent (OpenClaw persona, or codex/claude default) drives behavior; we
 *   only add what's specific to this app.
 * - **data mode** (opt-in): full data-chat instructions + live schema.
 *   The agent is constrained to centraid_sql_* tools; the prompt pins it
 *   to depersonalized SQL-only behavior.
 */
export function buildExtraPrompt(input: BuildExtraPromptInput): string {
  const { appId, appName, appDescription, mode, schema } = input;
  if (mode === 'data') {
    return buildDataModePrompt({ appId, appName, schema });
  }
  return buildFullModePrompt({ appId, appName, appDescription, schema });
}

function buildFullModePrompt(opts: {
  appId: string;
  appName?: string;
  appDescription?: string;
  schema: AppSchema;
}): string {
  const name = opts.appName ?? opts.appId;
  const lines: string[] = [
    `## Centraid app context`,
    ``,
    `You are working inside the centraid app "${name}" (id: \`${opts.appId}\`).`,
  ];
  if (opts.appDescription) {
    lines.push('', opts.appDescription);
  }
  lines.push(
    '',
    `The app stores data in a SQLite database scoped to this app id. Three`,
    `centraid_sql_* tools (describe / read / write) are available — they're`,
    `pre-scoped to "${opts.appId}", you cannot reach into another app's data.`,
    ``,
    renderSchemaBlock(opts.schema),
  );
  return lines.join('\n');
}

function buildDataModePrompt(opts: { appId: string; appName?: string; schema: AppSchema }): string {
  const name = opts.appName ?? opts.appId;
  return [
    `## Centraid app data chat`,
    ``,
    `You are a data assistant for the centraid app "${name}" (id: \`${opts.appId}\`).`,
    `Your job is to answer the user's questions about this app's data and, when asked,`,
    `to make small row-level edits. You are NOT authoring the app — there are no files to read or write.`,
    ``,
    `### Available tools (use these — no others)`,
    ``,
    `- centraid_sql_describe — list tables, columns, indexes, and views in this app's SQLite.`,
    `- centraid_sql_read({ sql }) — run a single SELECT (or EXPLAIN) and get rows back.`,
    `- centraid_sql_write({ sql }) — run a single INSERT / UPDATE / DELETE / REPLACE and get rowsAffected + lastInsertRowid.`,
    ``,
    `Scope is locked: every tool already targets app "${opts.appId}". You cannot query or modify any other app.`,
    `Schema-changing statements (CREATE / ALTER / DROP / PRAGMA / ATTACH) are refused — use the existing schema.`,
    ``,
    `### Workflow`,
    ``,
    `1. If you don't know the schema yet for this turn, call centraid_sql_describe first — never invent table or column names.`,
    `2. For lookups, prefer one focused SELECT over many small ones; cap large result sets in the SQL (LIMIT) so you don't waste tokens.`,
    `3. For writes, confirm what changed back to the user in plain Markdown — say which rows were affected and the new id when inserting.`,
    `4. If the user asks for something that needs a schema change, explain the limit and suggest the app author add a migration.`,
    ``,
    renderSchemaBlock(opts.schema),
  ].join('\n');
}

function renderSchemaBlock(schema: AppSchema): string {
  if (schema.tables.length === 0 && schema.views.length === 0) {
    return [`### Live schema`, ``, `(no tables yet — the app has not run any migrations)`].join(
      '\n',
    );
  }
  const lines: string[] = [`### Live schema`, ``];
  for (const t of schema.tables) {
    const cols = t.columns
      .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`)
      .join(', ');
    lines.push(`- **${t.name}** (${cols})`);
  }
  if (schema.views.length > 0) {
    lines.push('');
    lines.push('Views:');
    for (const v of schema.views) lines.push(`- ${v.name}`);
  }
  return lines.join('\n');
}
