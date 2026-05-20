/*
 * Host tool enumeration for the builder's available-tools grounding
 * block (issue #80 follow-up).
 *
 * The builder agent authors `ctx.tool(...)` calls and `requires` manifest
 * fields. Without grounding it guesses tool names from training priors.
 * So at session start we ask the host runtime which tools it actually
 * exposes — and we treat "tools" uniformly: a tool is a tool whether it's
 * a native CLI builtin or MCP-backed. The harness only cares about the
 * callable surface, not the source.
 *
 * Per-runtime mechanisms (each runtime exposes its own registry):
 *   - `claude-code` — the Claude Agent SDK's session `init` message
 *     reports the full resolved tool set (native builtins + MCP tools)
 *     in `tools: string[]`. We start a `query()`, read that message, and
 *     abort before any model turn — cheap, no tokens spent.
 *   - `codex` — the codex app-server's `mcpServerStatus/list` JSON-RPC
 *     returns each MCP server's full `tools` map (real tool names +
 *     descriptions). We drive a short app-server handshake and read it.
 *
 * Enumeration is best-effort: any failure (missing/old CLI, no API key,
 * parse miss) resolves to `[]` and the grounding block is simply omitted.
 */

import { spawn } from 'node:child_process';
import type { RunnerKind } from './types.js';

const CODEX_ENUM_TIMEOUT_MS = 15_000;

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
}

/**
 * Enumerate the tools the host runtime exposes. Best-effort — resolves to
 * `[]` on any failure.
 */
export async function enumerateHostTools(
  kind: RunnerKind,
  opts: { cwd: string; binPath?: string },
): Promise<HostTool[]> {
  try {
    return kind === 'claude-code'
      ? await enumerateClaudeTools(opts.cwd)
      : await enumerateCodexTools(opts.binPath);
  } catch {
    return [];
  }
}

/**
 * Claude Code: read the Agent SDK's `init` system message, which carries
 * the fully-resolved tool set. We abort the query the moment it arrives —
 * `init` is emitted during session setup, before any model call.
 */
async function enumerateClaudeTools(cwd: string): Promise<HostTool[]> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<{
      type?: string;
      subtype?: string;
      tools?: string[];
    }>;
  };
  const abortController = new AbortController();
  const q = sdk.query({
    prompt: 'centraid: tool enumeration probe',
    options: { cwd, abortController, maxTurns: 1 },
  });
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        return (msg.tools ?? []).map(claudeToolToHostTool);
      }
    }
  } finally {
    abortController.abort();
  }
  return [];
}

/** Map a Claude SDK tool name to a `HostTool`. MCP tools are `mcp__<server>__<tool>`. */
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

/** One MCP server entry from the codex `mcpServerStatus/list` response. */
export interface CodexMcpServerStatus {
  name: string;
  tools?: Record<string, { name?: string; description?: string | null }>;
}

/**
 * Flatten codex `mcpServerStatus/list` data into `HostTool[]` — each
 * server's `tools` map becomes `<server>.<tool>` entries. Exported for
 * tests.
 */
export function flattenCodexMcpServers(statuses: readonly CodexMcpServerStatus[]): HostTool[] {
  const out: HostTool[] = [];
  for (const s of statuses) {
    for (const [key, def] of Object.entries(s.tools ?? {})) {
      const toolName = def?.name ?? key;
      const tool: HostTool = { name: `${s.name}.${toolName}`, source: 'mcp', server: s.name };
      if (def?.description) tool.description = def.description;
      out.push(tool);
    }
  }
  return out;
}

/** Codex: enumerate MCP tools via the app-server `mcpServerStatus/list` RPC. */
async function enumerateCodexTools(binPath?: string): Promise<HostTool[]> {
  const bin = binPath && binPath.length > 0 ? binPath : 'codex';
  return flattenCodexMcpServers(await codexMcpServerStatuses(bin));
}

/**
 * Drive a minimal codex app-server handshake (`initialize` → `initialized`
 * → `mcpServerStatus/list`, paging on `nextCursor`) and return the server
 * statuses. The process is killed as soon as the list is complete.
 */
function codexMcpServerStatuses(bin: string): Promise<CodexMcpServerStatus[]> {
  return new Promise<CodexMcpServerStatus[]>((resolve, reject) => {
    const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const collected: CodexMcpServerStatus[] = [];
    let buf = '';
    let listId = 1;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('codex app-server tool enumeration timed out'))),
      CODEX_ENUM_TIMEOUT_MS,
    );
    timer.unref?.();

    const send = (msg: object): void => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n');
    };
    const requestList = (cursor?: string): void => {
      listId += 1;
      send({
        jsonrpc: '2.0',
        id: listId,
        method: 'mcpServerStatus/list',
        params: { detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) },
      });
    };

    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', () => finish(() => resolve(collected)));

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: {
          id?: unknown;
          method?: unknown;
          result?: { data?: CodexMcpServerStatus[]; nextCursor?: string | null };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        // Skip notifications and server-to-client requests.
        if (msg.method !== undefined) continue;
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          requestList();
          continue;
        }
        if (typeof msg.id === 'number') {
          if (msg.error) {
            finish(() => reject(new Error(msg.error?.message ?? 'mcpServerStatus/list failed')));
            return;
          }
          const data = msg.result?.data;
          if (Array.isArray(data)) collected.push(...data);
          const next = msg.result?.nextCursor;
          if (typeof next === 'string' && next) requestList(next);
          else finish(() => resolve(collected));
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'centraid-tool-probe', title: 'Centraid', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
