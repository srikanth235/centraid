import type { ToolContext } from "@centraid/server/engine";

export const VAULT_SQL_TOOL = {
  name: "vault_sql",
  description:
    "Run ONE read-only SQL statement (SELECT / WITH … SELECT / EXPLAIN) over the whole vault — " +
    "the canonical personal-data model whose schema and conventions are in your system prompt. " +
    "Joins, window functions, recursive CTEs (e.g. over core_link) and FTS5 MATCH against the fts_* " +
    "tables are all available in a single statement. Rows are capped (use LIMIT and aggregate in SQL " +
    "rather than pulling raw rows). Writes/DDL/PRAGMA are refused — propose changes to the owner instead.",
  inputSchema: {
    type: "object",
    required: ["sql"],
    properties: {
      sql: {
        type: "string",
        description:
          "One read-only statement: SELECT / WITH … SELECT / EXPLAIN.",
      },
    },
    additionalProperties: false,
  },
} as const;

export const VAULT_INVOKE_TOOL = {
  name: "vault_invoke",
  description:
    "Invoke ONE typed vault command (the only write path) — the available commands and their risk " +
    "levels are listed in your system prompt. Input must match the command schema; a schema error " +
    "comes back verbatim so you can correct it. High-risk commands PARK for the owner to approve — " +
    "a `parked` outcome is success-so-far: tell the owner it awaits their approval, do not retry.",
  inputSchema: {
    type: "object",
    required: ["command", "input"],
    properties: {
      command: {
        type: "string",
        description: "Registered command name, e.g. schedule.propose_event.",
      },
      input: {
        type: "object",
        description: "Input matching the command schema.",
      },
    },
    additionalProperties: false,
  },
} as const;

export const VAULT_CONTENT_TOOL = {
  name: "vault_content",
  description:
    "Read the TEXT of one document/content item by content_id (its extracted-text derivative, or " +
    "the inline body for text items) — how you actually read a PDF, scan or note the owner asks " +
    "about, since vault_sql only returns rows. Size-bounded and receipted. Returns " +
    '{ text, truncated } or a status explaining why nothing is readable (e.g. "no-variant" — no ' +
    "extracted text exists yet for a binary item).",
  inputSchema: {
    type: "object",
    required: ["content_id"],
    properties: {
      content_id: {
        type: "string",
        description: "core_content_item.content_id to read.",
      },
    },
    additionalProperties: false,
  },
} as const;

export type VaultSqlToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; errorText: string };

export async function runVaultContentTool(
  ctx: ToolContext,
  args: unknown
): Promise<VaultSqlToolOutcome> {
  if (!ctx.vaultContent)
    return {
      ok: false,
      errorText: "vault_content is not available on this turn",
    };
  const a = (args ?? {}) as { content_id?: unknown };
  if (typeof a.content_id !== "string" || a.content_id.trim() === "") {
    return { ok: false, errorText: "vault_content requires { content_id }" };
  }
  try {
    return {
      ok: true,
      result: await ctx.vaultContent({ contentId: a.content_id }),
    };
  } catch (error) {
    return {
      ok: false,
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runVaultInvokeTool(
  ctx: ToolContext,
  args: unknown
): Promise<VaultSqlToolOutcome> {
  if (!ctx.vaultInvoke)
    return {
      ok: false,
      errorText: "vault_invoke is not available on this turn",
    };
  const a = (args ?? {}) as { command?: unknown; input?: unknown };
  if (typeof a.command !== "string" || a.command.trim() === "") {
    return { ok: false, errorText: "vault_invoke requires { command, input }" };
  }
  const input =
    a.input && typeof a.input === "object" && !Array.isArray(a.input)
      ? (a.input as Record<string, unknown>)
      : {};
  try {
    return {
      ok: true,
      result: await ctx.vaultInvoke({ command: a.command, input }),
    };
  } catch (error) {
    return {
      ok: false,
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runVaultSqlTool(
  ctx: ToolContext,
  sql: unknown
): Promise<VaultSqlToolOutcome> {
  if (!ctx.vaultSql)
    return { ok: false, errorText: "vault_sql is not available on this turn" };
  if (typeof sql !== "string" || sql.trim() === "") {
    return {
      ok: false,
      errorText: 'vault_sql requires { sql: "<single read-only statement>" }',
    };
  }
  try {
    return { ok: true, result: await ctx.vaultSql(sql) };
  } catch (error) {
    return {
      ok: false,
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}
