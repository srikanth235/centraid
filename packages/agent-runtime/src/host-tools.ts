/*
 * governance: allow-repo-hygiene file-size-limit (#378) 5 lines over from the
 * codex additional_tools/namespace-flattening fix; splitting the codex and
 * claude capture/normalize halves into separate files would fragment one
 * coherent host-tool-enumeration story across two files with no readability
 * gain.
 *
 * Host tool enumeration for the builder's available-tools grounding
 * block (issue #80 follow-up).
 *
 * The builder agent authors `ctx.tool(...)` calls and `requires` manifest
 * fields. Without grounding it guesses tool names — and argument shapes —
 * from training priors. So at session start we ask the host runtime which
 * tools it exposes, *with their exact JSON input schemas*.
 *
 * Mechanism — snapshot the tools off the agent's first model request:
 *   Every coding agent sends its LLM, on the first request, the full set of
 *   callable tools (builtins + MCP) with complete JSON schemas — the
 *   agent↔model contract. We capture that request against a throwaway local
 *   endpoint and abort; zero model tokens are spent.
 *     - claude: the Agent SDK is pointed at a trivial loopback server. claude
 *       connects MCP asynchronously, so we drive the turn in streaming-input
 *       mode and hold the message until `mcpServerStatus()` reports the servers
 *       have connected — otherwise the snapshot under-counts MCP tools.
 *     - codex: `codex exec` runs against the mock-LLM server the automation
 *       runtime uses. codex connects its `[mcp_servers.*]` synchronously, so the
 *       first request is already complete — no gate needed.
 *
 * The enumerated surface is exactly what a deployed handler's `ctx.tool` can
 * reach — not a second-hand registry that might over- or under-promise.
 *
 * "A tool is a tool": native builtins and MCP-backed tools are treated
 * uniformly; `source` is an informational tag only.
 *
 * Enumeration is best-effort: any failure (missing/old CLI, no API key,
 * parse miss, timeout) resolves to `[]` and the grounding block is simply
 * omitted.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunnerKind } from './types.js';
import { startMockLlmServer } from '@centraid/automation';
import { codexProviderOverrideArgs } from './backends/codex/provider-config.js';
import { agentSpawnEnv } from './spawn-env.js';
import { lowPriorityCommand } from './low-priority.js';

/** The throwaway prompt; the mock ends the turn at once, so it's never acted on. */
const PROBE_PROMPT = 'centraid tool-enumeration probe — reply with: ok';

/** Hard cap on the probe — a hung/missing CLI must not stall the builder. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Max time to wait for MCP servers to leave `pending` before snapshotting the
 * tool list. MCP servers connect asynchronously after the agent starts; if we
 * capture the first request before they finish, their tools are missing from
 * the enumerated surface (an under-count the builder would read as "tool
 * doesn't exist"). Bounded so a slow/stuck server can't stall the probe past
 * `PROBE_TIMEOUT_MS`.
 */
const MCP_SETTLE_TIMEOUT_MS = 15_000;
const MCP_POLL_INTERVAL_MS = 120;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn `codex exec` pointed at the mock-LLM server. Routes model calls through
 * the mock provider via `-c` overrides on the user's REAL ~/.codex (no
 * CODEX_HOME redirect), so the enumerated tool surface includes the user's
 * `[mcp_servers.*]` (issue #160). The bearer token flows via env under the
 * provider's env_key.
 */
async function spawnProbeCli(input: {
  binPath?: string;
  mockBaseUrl: string;
  mockBearerToken: string;
  cwd: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const env = agentSpawnEnv({
    binPath: input.binPath,
    baseEnv: { ...process.env, CENTRAID_MOCK_KEY: input.mockBearerToken },
  });
  const args = [
    'exec',
    ...codexProviderOverrideArgs({
      id: 'centraid-mock',
      name: 'Centraid Automation Mock',
      baseUrl: input.mockBaseUrl,
      envKey: 'CENTRAID_MOCK_KEY',
    }),
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    PROBE_PROMPT,
  ];
  const command = lowPriorityCommand(input.binPath ?? 'codex', args);
  const proc = spawn(command.bin, command.args, {
    cwd: input.cwd,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const onAbort = (): void => {
    if (!proc.killed) proc.kill('SIGTERM');
  };
  input.abortSignal.addEventListener('abort', onAbort, { once: true });
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });
  input.abortSignal.removeEventListener('abort', onAbort);
}

/**
 * Wait until no configured MCP server is still `pending` (all connected /
 * failed / disabled / needs-auth), or until the bounded deadline. Best-effort:
 * the control method may throw before the session is ready, so we just retry
 * until the deadline; an empty server list returns immediately. This closes
 * the MCP race — the first Messages request must carry the MCP tool set, which
 * only appears once the servers have connected.
 */
async function waitForMcpSettled(
  q: { mcpServerStatus(): Promise<Array<{ status: string }>> },
  abortSignal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline && !abortSignal.aborted) {
    let statuses: Array<{ status: string }>;
    try {
      // Guard each poll: before init the control method can hang, which would
      // block the gated turn indefinitely. A timed-out poll just retries until
      // the deadline.
      statuses = await Promise.race([
        q.mcpServerStatus(),
        delay(1000).then(() => {
          throw new Error('mcp-status-timeout');
        }),
      ]);
    } catch {
      await delay(MCP_POLL_INTERVAL_MS);
      continue;
    }
    // `[].every()` is true, so this also covers the no-servers case.
    if (statuses.every((s) => s.status !== 'pending')) return;
    await delay(MCP_POLL_INTERVAL_MS);
  }
}

/**
 * Capture claude's tool definitions, with schemas, the simple way: point the
 * Agent SDK at a throwaway loopback server and snapshot the `tools` array off
 * the single Messages request. No mock-LLM is needed — the response is
 * irrelevant because we abort the instant we have the tools, so the server just
 * replies `{}`.
 *
 * The one real subtlety is timing: claude connects MCP servers asynchronously,
 * so we drive the turn in streaming-input mode and hold the user message until
 * `mcpServerStatus()` reports every server has left `pending`. That guarantees
 * the request carries the full builtin + MCP tool set in one shot. Best-effort:
 * any failure resolves to `undefined` and the caller falls back to `[]`.
 */
async function captureClaudeTools(opts: {
  cwd: string;
  binPath?: string;
}): Promise<unknown[] | undefined> {
  let mod: typeof import('@anthropic-ai/claude-agent-sdk');
  try {
    mod = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return undefined;
  }

  return await new Promise<unknown[] | undefined>((resolve) => {
    let captured: unknown[] | undefined;
    let settled = false;
    const abort = new AbortController();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(captured);
    };

    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        if (captured === undefined) {
          try {
            const parsed = JSON.parse(body) as { tools?: unknown };
            if (Array.isArray(parsed.tools) && parsed.tools.length > 0) captured = parsed.tools;
          } catch {
            /* ignore non-JSON bodies */
          }
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
        if (captured !== undefined) finish();
      });
    });

    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    timer.unref?.();
    server.on('error', finish);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        finish();
        return;
      }

      // Replace the child env: strip inherited Anthropic routing/auth (so the
      // probe can't reach the real provider) and the CLAUDE_*/CLAUDECODE session
      // markers that hijack the child when the gateway runs nested in a Claude
      // session. Keep CLAUDE_CONFIG_DIR so the user's MCP servers are still
      // discovered. process.env is never mutated.
      const scrubbed: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k === 'CLAUDE_CONFIG_DIR') {
          scrubbed[k] = v;
          continue;
        }
        if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE')) continue;
        scrubbed[k] = v;
      }
      // PATH sanitization (see spawn-env.ts) applies here too: an explicit
      // `opts.binPath` already pins the exact executable via
      // `pathToClaudeCodeExecutable` below, so this only matters for the
      // default (vendored-binary) path, but stays consistent with every
      // other agent-CLI spawn in this module.
      const env = agentSpawnEnv({ baseEnv: scrubbed, binPath: opts.binPath });
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
      env.ANTHROPIC_API_KEY = 'centraid-probe';

      // `query()` may start pulling the prompt iterator before it returns, so
      // hand the Query handle to the gate via a deferred promise.
      let resolveQ!: (q: unknown) => void;
      const qReady = new Promise<unknown>((resolve) => {
        resolveQ = resolve;
      });

      async function* gatedPrompt(): AsyncGenerator<{
        type: 'user';
        message: { role: 'user'; content: string };
        parent_tool_use_id: null;
      }> {
        const q = (await qReady) as {
          mcpServerStatus(): Promise<Array<{ status: string }>>;
        };
        await waitForMcpSettled(q, abort.signal);
        if (abort.signal.aborted) return;
        yield {
          type: 'user',
          message: { role: 'user', content: PROBE_PROMPT },
          parent_tool_use_id: null,
        };
      }

      const options: Record<string, unknown> = {
        cwd: opts.cwd,
        permissionMode: 'bypassPermissions',
        // Documented requirement alongside permissionMode: 'bypassPermissions'.
        allowDangerouslySkipPermissions: true,
        abortController: abort,
        env,
      };
      if (opts.binPath) options.pathToClaudeCodeExecutable = opts.binPath;

      let q: AsyncGenerator<unknown>;
      try {
        q = mod.query({
          prompt: gatedPrompt() as unknown as Parameters<typeof mod.query>[0]['prompt'],
          options: options as Parameters<typeof mod.query>[0]['options'],
        }) as unknown as AsyncGenerator<unknown>;
      } catch {
        finish();
        return;
      }
      resolveQ(q);
      void (async () => {
        try {
          for await (const _ of q) {
            if (abort.signal.aborted) break;
          }
        } catch {
          /* aborted on capture / teardown — expected */
        }
      })();
    });
  });
}

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
 * Pull the tool-declaration array out of a codex `/v1/responses` request
 * body, across two wire shapes we've observed:
 *   - codex-cli ≤0.128ish: a top-level `tools` array on the request body.
 *   - codex-cli 0.144+: no top-level `tools` field at all — the
 *     declarations instead ride inside `input` as an item shaped
 *     `{type: 'additional_tools', role: 'developer', tools: [...]}`.
 * Checked in that order so a future revert to the flat shape still works.
 */
function extractCodexRequestTools(body: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(body.tools) && body.tools.length > 0) return body.tools;
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isObject(item) &&
        item.type === 'additional_tools' &&
        Array.isArray(item.tools) &&
        item.tools.length > 0
      ) {
        return item.tools;
      }
    }
  }
  return undefined;
}

/**
 * Capture codex's tool definitions by spawning `codex exec` against the
 * mock-LLM server and snapshotting the first request's tool declarations
 * (see `extractCodexRequestTools` for the wire shapes handled). codex
 * connects its `[mcp_servers.*]` synchronously during startup, so the first
 * request already carries the full set — no readiness gate needed. The `-c`
 * overrides layer on the user's real ~/.codex so those servers stay reachable
 * (issue #160). Best-effort: resolves to `undefined` on any failure.
 */
async function captureCodexTools(opts: {
  cwd: string;
  binPath?: string;
}): Promise<unknown[] | undefined> {
  let captured: unknown[] | undefined;
  const abort = new AbortController();
  const server = await startMockLlmServer({
    onRequest: (_dispatchId, body) => {
      if (captured === undefined) {
        const tools = extractCodexRequestTools(body);
        if (tools) {
          captured = tools;
          // The first request carries the full tool set — stop the CLI now
          // rather than waiting for it to finish its turn.
          abort.abort();
        }
      }
    },
  });
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const { dispatchId, bearerToken } = server.mintDispatchToken();
    // An immediate end-turn: the CLI sends its tools, gets "ok", exits.
    server.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
    await spawnProbeCli({
      mockBaseUrl: server.baseUrl,
      mockBearerToken: bearerToken,
      cwd: opts.cwd,
      abortSignal: abort.signal,
      ...(opts.binPath ? { binPath: opts.binPath } : {}),
    });
  } finally {
    clearTimeout(timer);
    await server.close();
  }
  return captured;
}

/**
 * Capture the host runtime's tool `tools` array and normalize it. claude drives
 * the SDK against a trivial loopback server with an MCP-readiness gate; codex
 * spawns `codex exec` against the mock-LLM server.
 */
async function probeRuntimeTools(
  kind: RunnerKind,
  opts: { cwd: string; binPath?: string },
): Promise<HostTool[]> {
  // Only codex/claude-code expose a capturable tool set via their
  // mock-LLM / SDK probe. ACP-backed kinds (gemini/qwen/acp) have no
  // equivalent capture path — report no host tools rather than mis-spawning
  // one CLI under another's probe protocol.
  if (kind !== 'codex' && kind !== 'claude-code') return [];
  const captured =
    kind === 'claude-code' ? await captureClaudeTools(opts) : await captureCodexTools(opts);
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
    // A `namespace` groups related tools (e.g. codex's "collaboration" set —
    // spawn_agent, send_message, ...) under one entry with its own nested
    // `tools` array rather than being callable itself. Flatten it so the
    // enumerated surface lists exactly what the agent can call by name.
    if (entry.type === 'namespace' && Array.isArray(entry.tools)) {
      out.push(...normalizeCodexTools(entry.tools));
      continue;
    }
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
