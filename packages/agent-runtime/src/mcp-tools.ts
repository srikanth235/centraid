/*
 * Host MCP-server enumeration for the builder's available-tools
 * grounding block (issue #80 follow-up).
 *
 * The builder agent authors `ctx.tool('<server>.<tool>', …)` calls and
 * `requires.mcps` / `requires.tools` manifest fields. Without grounding
 * it guesses server names from training priors — declaring a `jira`
 * MCP that isn't installed, or misspelling `github`. So at session
 * start we ask the host CLI which MCP servers it actually has wired up
 * (`claude mcp list` / `codex mcp list`) and splice the real list into
 * the system prompt.
 *
 * Enumeration is strictly best-effort: a missing CLI, an old CLI
 * without the `mcp` subcommand, or a parse miss all degrade to an empty
 * list and the grounding block is simply omitted (the agent falls back
 * to declaring servers from the user's prompt, as before).
 */

import { spawn } from 'node:child_process';
import type { RunnerKind } from './types.js';

const MCP_LIST_TIMEOUT_MS = 6_000;

export interface McpServerInfo {
  /** Server id as the CLI knows it — the prefix in `ctx.tool('id.tool')`. */
  name: string;
  /** Connection status text when the CLI reports one (`Connected`, `Failed`, …). */
  status?: string;
}

/**
 * Parse the output of `<cli> mcp list`. Tolerant by design — both
 * Claude Code (`name: command - ✓ Connected`) and Codex (whitespace
 * columns) put the server id first on each line. Header / chrome /
 * empty-state lines are skipped.
 */
export function parseMcpList(raw: string): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Empty-state / chrome lines — bail on the whole thing only for the
    // explicit "none" message; otherwise just skip the line.
    if (/^no mcp servers/i.test(trimmed)) return [];
    if (/^(checking|health|name\b|listing|configured mcp)/i.test(trimmed)) continue;
    // Server id: leading identifier, then a `:` (Claude) or whitespace
    // gap (Codex table) or end-of-line.
    const m = trimmed.match(/^([A-Za-z0-9_.-]+)\s*(?::|\s{2,}|$)/);
    if (!m) continue;
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const info: McpServerInfo = { name };
    const status = trimmed.match(/(connected|failed|disconnected|error|needs auth)/i);
    if (status) info.status = status[1]!;
    out.push(info);
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

/**
 * Enumerate the MCP servers the host CLI has configured. Best-effort:
 * any failure (no CLI, old CLI, parse miss) resolves to `[]`.
 */
export async function enumerateMcpServers(
  kind: RunnerKind,
  binPath?: string,
): Promise<McpServerInfo[]> {
  const bin = binPath && binPath.length > 0 ? binPath : kind === 'codex' ? 'codex' : 'claude';
  try {
    return parseMcpList(await runMcpList(bin));
  } catch {
    return [];
  }
}
