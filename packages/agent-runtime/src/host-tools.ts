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
 *   - `codex` — codex has no tool-registry CLI; its verifiable surface is
 *     the configured MCP servers (`codex mcp list`). Each becomes a tool
 *     entry; the grounding block tells the agent the per-server tool ids
 *     are `<server>.<tool>`.
 *
 * Enumeration is best-effort: any failure (missing/old CLI, no API key,
 * parse miss) resolves to `[]` and the grounding block is simply omitted.
 */

import { spawn } from 'node:child_process';
import type { RunnerKind } from './types.js';

const MCP_LIST_TIMEOUT_MS = 6_000;

export interface HostTool {
  /**
   * The callable name as the agent sees it — a specific tool (`Read`,
   * `github.list_pull_requests`) or, when the runtime only exposes
   * servers, an MCP server id (`github`). See `granularity`.
   */
  name: string;
  /** Where the tool comes from — informational; the harness treats both alike. */
  source: 'native' | 'mcp';
  /** `'tool'` for a specific callable; `'server'` when only the MCP server is known. */
  granularity: 'tool' | 'server';
  /** MCP server id, when `source === 'mcp'`. */
  server?: string;
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
        return (msg.tools ?? []).map(toHostTool);
      }
    }
  } finally {
    abortController.abort();
  }
  return [];
}

/** Map a Claude SDK tool name to a `HostTool`. MCP tools are `mcp__<server>__<tool>`. */
function toHostTool(name: string): HostTool {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2);
      return { name: `${server}.${tool}`, source: 'mcp', granularity: 'tool', server };
    }
  }
  return { name, source: 'native', granularity: 'tool' };
}

/** Codex: enumerate configured MCP servers (`codex mcp list`). */
async function enumerateCodexTools(binPath?: string): Promise<HostTool[]> {
  const bin = binPath && binPath.length > 0 ? binPath : 'codex';
  const servers = parseMcpList(await runMcpList(bin));
  return servers.map((s) => ({
    name: s.name,
    source: 'mcp' as const,
    granularity: 'server' as const,
    server: s.name,
  }));
}

/**
 * Parse `<cli> mcp list` output into server ids. Tolerant by design —
 * both Claude Code (`name: command - status`) and Codex (whitespace
 * columns) put the server id first on each line. Exported for tests.
 */
export function parseMcpList(raw: string): { name: string }[] {
  const out: { name: string }[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^no mcp servers/i.test(trimmed)) return [];
    if (/^(checking|health|name\b|listing|configured mcp)/i.test(trimmed)) continue;
    const m = trimmed.match(/^([A-Za-z0-9_.-]+)\s*(?::|\s{2,}|$)/);
    if (!m) continue;
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}

function runMcpList(bin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['mcp', 'list'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error('`mcp list` timed out'));
      });
    }, MCP_LIST_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (code === 0) settle(() => resolve(text));
      else settle(() => reject(new Error(`\`mcp list\` exited ${code ?? 'null'}`)));
    });
  });
}
