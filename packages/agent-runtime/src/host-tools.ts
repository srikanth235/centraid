/*
 * Host tool enumeration for the builder's available-tools grounding
 * block (issue #80 follow-up).
 *
 * The builder agent authors `ctx.tool(...)` calls and `requires` manifest
 * fields. Without grounding it guesses tool names — and argument shapes —
 * from training priors. So at session start we ask the host runtime which
 * tools it exposes, *with their exact JSON input schemas*.
 *
 * Mechanism — capture from the mock-LLM server:
 *   Every coding agent must tell its LLM, on the very first request, the
 *   full set of callable tools (builtins + MCP) with complete JSON
 *   schemas — that is the agent↔model contract. So we point the CLI at
 *   the same per-run mock-LLM server the automation runtime uses, stage
 *   an immediate end-turn, and snapshot the `tools` array off that first
 *   request. The CLI gets an "ok" and exits; zero model tokens are spent.
 *
 * This is deliberately *the same path* the automation runtime drives, so
 * the enumerated surface is exactly what a deployed handler's `ctx.tool`
 * can reach — not a second-hand registry that might over- or
 * under-promise.
 *
 * "A tool is a tool": native builtins and MCP-backed tools are treated
 * uniformly; `source` is an informational tag only.
 *
 * Enumeration is best-effort: any failure (missing/old CLI, no API key,
 * parse miss, timeout) resolves to `[]` and the grounding block is simply
 * omitted.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerKind } from './types.js';
import { startMockLlmServer } from './mock-llm-server.js';
import { defaultSpawnCli, type SpawnCliInput } from './run-automation-cli-spawn.js';

/** Hard cap on the probe — a hung/missing CLI must not stall the builder. */
const PROBE_TIMEOUT_MS = 30_000;

export interface HostTool {
  /**
   * The callable name as the agent sees it — a native builtin (`Read`)
   * or an MCP tool (`github.list_pull_requests`).
   */
  name: string;
  /** Where the tool comes from — informational; the harness treats both alike. */
  source: 'native' | 'mcp';
  /** MCP server id, when `source === 'mcp'`. */
  server?: string;
  /** One-line description, when the runtime reports one. */
  description?: string;
  /**
   * The tool's JSON Schema for arguments, verbatim from the agent↔model
   * contract. Present for every function-style tool; absent for native
   * provider tools (e.g. `web_search`) that take no caller-supplied args.
   */
  inputSchema?: unknown;
}

/**
 * Enumerate the tools the host runtime exposes, with input schemas.
 * Best-effort — resolves to `[]` on any failure.
 */
export async function enumerateHostTools(
  kind: RunnerKind,
  opts: { cwd: string; binPath?: string },
): Promise<HostTool[]> {
  try {
    const tools = await probeRuntimeTools(kind, opts);
    return tools;
  } catch {
    return [];
  }
}

/**
 * Drive one throwaway CLI turn against a mock-LLM server and snapshot the
 * `tools` array off the first request.
 */
async function probeRuntimeTools(
  kind: RunnerKind,
  opts: { cwd: string; binPath?: string },
): Promise<HostTool[]> {
  let captured: unknown[] | undefined;
  const abort = new AbortController();
  const server = await startMockLlmServer({
    onRequest: (_dispatchId, body) => {
      if (captured === undefined && Array.isArray(body.tools)) {
        captured = body.tools;
        // The first request carries the full tool set — stop the CLI
        // now rather than waiting for it to finish its turn (codex
        // exits promptly; `claude -p` otherwise lingers).
        abort.abort();
      }
    },
  });
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-tool-probe-'));
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const { dispatchId, bearerToken } = server.mintDispatchToken();
    // An immediate end-turn: the CLI sends its tools, gets "ok", exits.
    server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
    const input: SpawnCliInput = {
      kind,
      mockBaseUrl: server.baseUrl,
      mockBearerToken: bearerToken,
      prompt: 'centraid tool-enumeration probe — reply with: ok',
      toolsAllow: [],
      cwd: opts.cwd,
      scratchDir,
      abortSignal: abort.signal,
      ...(opts.binPath ? { binPath: opts.binPath } : {}),
    };
    await defaultSpawnCli(input);
  } finally {
    clearTimeout(timer);
    await server.close();
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!captured) return [];
  return kind === 'codex' ? normalizeCodexTools(captured) : normalizeClaudeTools(captured);
}

/**
 * Normalize the `tools` array codex ships in an OpenAI Responses request:
 *   - `{type:'function', name, description?, parameters}` — function tool;
 *     `parameters` is the JSON args schema.
 *   - `{type:'custom', name, description?, format}` — freeform/custom
 *     tool (e.g. `apply_patch`); named, but no JSON args schema.
 *   - `{type:'web_search', ...}` — native provider tool; the `type` *is*
 *     the tool name and it takes no caller-authored arguments.
 *
 * codex tool names are flat (`exec_command`, `update_plan`); MCP tools —
 * when configured — also surface as function tools. Exported for tests.
 */
export function normalizeCodexTools(raw: readonly unknown[]): HostTool[] {
  const out: HostTool[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    // Prefer an explicit `name`; fall back to `type` for the nameless
    // native tools whose `type` is the identity (`web_search`).
    const name =
      typeof entry.name === 'string' && entry.name
        ? entry.name
        : typeof entry.type === 'string' && entry.type
          ? entry.type
          : undefined;
    if (!name) continue;
    const tool: HostTool = { name, source: 'native' };
    if (typeof entry.description === 'string' && entry.description) {
      tool.description = entry.description;
    }
    if (entry.parameters !== undefined) tool.inputSchema = entry.parameters;
    out.push(tool);
  }
  return out;
}

/**
 * Normalize the `tools` array claude ships in an Anthropic Messages
 * request. Entries are `{name, description?, input_schema}`; MCP tools
 * carry the `mcp__<server>__<tool>` name shape. Exported for tests.
 */
export function normalizeClaudeTools(raw: readonly unknown[]): HostTool[] {
  const out: HostTool[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    if (!name) continue;
    const tool: HostTool = claudeToolToHostTool(name);
    if (typeof entry.description === 'string' && entry.description) {
      tool.description = entry.description;
    }
    if (entry.input_schema !== undefined) tool.inputSchema = entry.input_schema;
    out.push(tool);
  }
  return out;
}

/** Map a Claude tool name to a `HostTool`. MCP tools are `mcp__<server>__<tool>`. */
export function claudeToolToHostTool(name: string): HostTool {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2);
      return { name: `${server}.${tool}`, source: 'mcp', server };
    }
  }
  return { name, source: 'native' };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}
