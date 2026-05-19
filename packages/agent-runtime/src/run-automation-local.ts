/**
 * Local-side orchestrator for one automation fire.
 *
 * High-level flow (see issue #70 § Headless run path):
 *
 *   1. Open per-app SQLite (WAL), load manifest.
 *   2. Preflight: claude/codex on PATH, MCPs declared in manifest are
 *      present in the host CLI config.
 *   3. Start ephemeral mock-LLM HTTP server (per-fire bearer token).
 *   4. Construct ctx dispatchers wired to the mock URL + bearer.
 *   5. Execute the JS handler via runAutomationHandler:
 *        - Each ctx.tool batch from the worker spawns one fresh CLI
 *          subprocess. The mock stages a tool_use turn carrying all
 *          calls in the batch; the CLI executes them through its MCP
 *          pipeline; the mock captures the tool_result blocks back
 *          and resolves the per-call results. The mock then serves
 *          an end_turn ack so the CLI exits cleanly.
 *        - Each ctx.agent call spawns a separate CLI subprocess
 *          configured against the user's REAL provider (no mock),
 *          one-shot prompt, structured-output parsed by us.
 *   6. Return a run record (success / failure / duration / batches /
 *      agent calls). Persistence is the caller's responsibility — the
 *      CLI wrapper prints to stdout, the desktop will mirror into the
 *      `automations` gateway-db table once that surface is wired (see
 *      issue #70 § Implementation phases).
 *   7. Kill mock server.
 *
 * Spawn paths factor through `defaultSpawnCli` so tests can inject a
 * mock spawn that drives the mock server without needing real CLIs
 * installed. The production default uses `claude -p` for the Claude
 * runner and `codex exec` for the codex runner.
 *
 * KNOWN LIMITATIONS (issue #70 spike items still to verify against
 * live binaries before this can be considered production-ready):
 *
 *   - `codex exec -c model_providers.X.base_url=...` must actually take
 *     effect (the issue strongly implies yes; ten-minute spike confirms).
 *     If it doesn't, fall back to writing a transient CODEX_HOME via
 *     materializeCodexHome() and pointing CODEX_HOME at it.
 *   - `claude -p --output-format stream-json` must emit tool_use AND
 *     tool_result events, not just final text. Pin the claude version.
 *   - Non-interactive permission bypass (`claude -p --permission-mode
 *     bypassPermissions`, `codex exec --ask-for-approval never`) must
 *     also bypass MCP-level prompts, not just CLI-level.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  parseManifest,
  runAutomationHandler,
  type AutomationDispatchContext,
  type AutomationHandlerOutcome,
  type AutomationManifest,
  type AutomationToolCall,
  type AutomationToolResult,
} from '@centraid/runtime-core';
import { startMockLlmServer, type StagedTurn } from './mock-llm-server.js';
import { materializeCodexHome } from './codex-provider-config.js';

export type LocalRunnerKind = 'codex' | 'claude-code';

export interface SpawnCliInput {
  /** Which CLI to invoke. */
  readonly kind: LocalRunnerKind;
  /** Mock-LLM base URL (`http://127.0.0.1:<port>/v1`). */
  readonly mockBaseUrl: string;
  /** Per-spawn bearer token (`centraid-mock-<dispatchId>`). */
  readonly mockBearerToken: string;
  /** The natural-language prompt to feed the CLI. Contains the dispatch sentinel. */
  readonly prompt: string;
  /** Tool allowlist from the manifest — passed to the CLI's MCP tool restriction flag. */
  readonly toolsAllow: readonly string[];
  /** Workspace dir (app code dir) the CLI should treat as cwd. */
  readonly cwd: string;
  /** Scratch dir for transient files (CODEX_HOME, etc). Auto-cleaned on close. */
  readonly scratchDir: string;
  /** AbortSignal — fires on timeout or external cancel. */
  readonly abortSignal: AbortSignal;
}

export interface SpawnCliResult {
  /** Process exit code, or null when killed by signal. */
  readonly exitCode: number | null;
  /** True on graceful exit (code === 0). */
  readonly ok: boolean;
  /** Buffered stderr — surfaced in the run record on failure. */
  readonly stderr: string;
}

/**
 * Default CLI spawn — production behavior. Tests inject their own
 * spawn implementation (typically one that drives the mock server's
 * staged turns without launching a real subprocess).
 */
export const defaultSpawnCli = async (input: SpawnCliInput): Promise<SpawnCliResult> => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let proc: ChildProcess;
  if (input.kind === 'claude-code') {
    env.ANTHROPIC_BASE_URL = input.mockBaseUrl;
    env.ANTHROPIC_API_KEY = input.mockBearerToken;
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
    ];
    for (const tool of input.toolsAllow) {
      args.push('--allowed-tools', tool);
    }
    proc = spawn('claude', args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // Codex: per-invocation provider override via -c flags. If the
    // override doesn't take effect in the installed codex version,
    // swap in a materialized CODEX_HOME (see comment at top of file).
    const codexHome = await materializeCodexHome(
      {
        id: 'centraid-mock',
        name: 'Centraid Automation Mock',
        baseUrl: input.mockBaseUrl,
        wireApi: 'chat',
        envKey: 'CENTRAID_MOCK_KEY',
      },
      input.scratchDir,
    );
    env.CODEX_HOME = codexHome;
    env.CENTRAID_MOCK_KEY = input.mockBearerToken;
    const args = ['exec', '--json', '--ask-for-approval', 'never'];
    for (const tool of input.toolsAllow) {
      args.push('--allowed-tools', tool);
    }
    args.push(input.prompt);
    proc = spawn('codex', args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  // We don't need to parse stdout — tool results come back through
  // the mock server, not the CLI's stdout. Drain it so the buffer
  // doesn't fill up and the process can exit.
  proc.stdout?.on('data', () => undefined);

  const abortListener = (): void => {
    if (!proc.killed) proc.kill('SIGTERM');
  };
  input.abortSignal.addEventListener('abort', abortListener, { once: true });

  return await new Promise<SpawnCliResult>((resolve) => {
    proc.on('exit', (code) => {
      input.abortSignal.removeEventListener('abort', abortListener);
      resolve({
        exitCode: code,
        ok: code === 0,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    proc.on('error', (err) => {
      input.abortSignal.removeEventListener('abort', abortListener);
      resolve({
        exitCode: null,
        ok: false,
        stderr: `spawn error: ${err.message}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
      });
    });
  });
};

/** Override seam for tests. Defaults to invoking the real CLIs. */
export type SpawnCli = typeof defaultSpawnCli;

export interface RunAutomationLocalOptions {
  /** App id (folder name under the projects dir). */
  appId: string;
  /**
   * Absolute path to the app's *data* directory — where `data.sqlite`,
   * the scratch folder, and CLI cwd live. For uploaded apps this is the
   * persistent root that survives version swaps; for path-registered apps
   * (centraid CLI run from a project root) it's just the project dir.
   */
  appDir: string;
  /**
   * Absolute path to the app's *code* directory — where `automations/`
   * and `actions/` live. For uploaded apps this is the active version's
   * subdir (`<appDir>/versions/<activeVersion>/`); for path-registered
   * apps it's the same as `appDir`. Defaults to `appDir` when omitted.
   */
  codeDir?: string;
  /** Automation name. The manifest is loaded from `<codeDir>/automations/<name>.json`. */
  automationName: string;
  /** Which CLI to drive. Defaults to codex. */
  runner?: LocalRunnerKind;
  /** Hard timeout. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override spawn for tests. */
  spawnCli?: SpawnCli;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Optional write notifier — called after the handler exits with the set of touched tables. */
  onWrite?: (tables: string[]) => void;
}

export interface AutomationRunRecord {
  appId: string;
  automationName: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  toolBatches: number;
  agentCalls: number;
}

/**
 * Compose the per-batch CLI prompt the mock server expects. The
 * sentinel `<<<centraid:appId:name>>>` matches the openclaw remote-path
 * convention so the same automation handlers run identically across
 * surfaces.
 */
function buildBatchPrompt(appId: string, automationName: string): string {
  return `<<<centraid:${appId}:${automationName}>>>\nExecute the staged tool calls and return tool_result blocks.`;
}

/**
 * Convert a tool call from the worker into the StagedTurn shape the
 * mock returns to the CLI. Each tool call needs a stable id we can
 * later match against the inbound tool_result.
 */
function batchToStagedTurn(calls: readonly AutomationToolCall[]): StagedTurn {
  return {
    stopReason: 'tool_use',
    toolUses: calls.map((c, idx) => ({
      id: `toolu_${idx}_${randomUUID().slice(0, 8)}`,
      name: c.name,
      input: c.args,
    })),
  };
}

/**
 * Single automation fire. Returns the run record + the handler outcome.
 * Failures during preflight throw; failures during handler execution
 * surface in `outcome.ok === false`.
 */
export async function runAutomationLocal(
  opts: RunAutomationLocalOptions,
): Promise<{ outcome: AutomationHandlerOutcome; record: AutomationRunRecord }> {
  const runner: LocalRunnerKind = opts.runner ?? 'codex';
  const onLog = opts.onLog ?? (() => undefined);
  const spawnCli = opts.spawnCli ?? defaultSpawnCli;
  const runId = `${opts.appId}:${opts.automationName}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  const codeDir = opts.codeDir ?? opts.appDir;
  const manifestPath = path.join(codeDir, 'automations', `${opts.automationName}.json`);
  let manifest: AutomationManifest;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = parseManifest(raw);
  } catch (err) {
    throw new Error(
      `automation ${opts.appId}/${opts.automationName}: failed to load manifest at ${manifestPath} — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const handlerFile = path.join(codeDir, 'actions', manifest.action);
  await fs.access(handlerFile).catch(() => {
    throw new Error(
      `automation ${opts.appId}/${opts.automationName}: handler ${handlerFile} not found — re-run the builder to regenerate it`,
    );
  });

  // Scratch dir for codex's transient CODEX_HOME and any tmp files.
  const scratchDir = path.join(opts.appDir, '.automation-scratch', runId);
  await fs.mkdir(scratchDir, { recursive: true });

  const mock = await startMockLlmServer({
    onLog,
    onToolResults: (dispatchId, results) => {
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.deliverResults(results);
    },
  });

  // Track in-flight batches keyed by dispatch id so the mock's
  // onToolResults callback can hand results to the right awaiter.
  interface BatchAwaiter {
    deliverResults(results: ReadonlyArray<{ id: string; content: string; isError: boolean }>): void;
  }
  const batchAwaiters = new Map<string, BatchAwaiter>();

  const toolDispatcher = async (
    calls: readonly AutomationToolCall[],
    ctx: AutomationDispatchContext,
  ): Promise<AutomationToolResult[]> => {
    const { dispatchId, bearerToken } = mock.mintDispatchToken();
    const turn = batchToStagedTurn(calls);
    mock.stageTurn(dispatchId, turn);

    // Wait for tool_result delivery from the mock OR for the CLI to
    // exit before delivering them (failure case — we still resolve so
    // the worker doesn't hang).
    const resultPromise = new Promise<
      ReadonlyArray<{ id: string; content: string; isError: boolean }>
    >((resolve) => {
      batchAwaiters.set(dispatchId, {
        deliverResults(results) {
          batchAwaiters.delete(dispatchId);
          resolve(results);
        },
      });
    });

    // Stage the end_turn ack so the CLI exits cleanly after returning
    // tool_result blocks — but stage it *after* spawning the CLI,
    // because spawning consumes the first staged turn (the tool_use)
    // and we don't want the ack ordering to race.
    const spawnPromise = spawnCli({
      kind: runner,
      mockBaseUrl: mock.baseUrl,
      mockBearerToken: bearerToken,
      prompt: buildBatchPrompt(ctx.appId, ctx.automationName),
      toolsAllow: manifest.requires.tools ?? [],
      cwd: opts.appDir,
      scratchDir,
      abortSignal: ctx.abortSignal,
    });

    // Wait for the tool_results to arrive before staging the ack —
    // the CLI's request flow is request → mock returns tool_use → CLI
    // runs the tools → CLI's NEXT request carries tool_result; that's
    // when our ack needs to be ready.
    let collected: ReadonlyArray<{ id: string; content: string; isError: boolean }> | undefined;
    const results = await Promise.race([
      resultPromise.then((r) => {
        collected = r;
        return r;
      }),
      // If the CLI exits first without sending tool_result, we'll
      // surface failures on every call.
      spawnPromise.then(() => undefined as undefined),
    ]);

    if (results) {
      // Stage the end-turn ack so the CLI can finish its second POST.
      try {
        mock.stageTurn(dispatchId, { text: 'ok', stopReason: 'end_turn' });
      } catch {
        /* the dispatch may have already cleared */
      }
    }

    const cliOutcome = await spawnPromise;
    batchAwaiters.delete(dispatchId);

    if (!cliOutcome.ok && !collected) {
      // CLI failed before delivering any tool_results — fail all calls.
      const errMsg = `CLI exited code=${cliOutcome.exitCode ?? '?'}\n${cliOutcome.stderr.slice(0, 2000)}`;
      return calls.map(() => ({ ok: false, error: errMsg }));
    }

    const captured = collected ?? [];
    // Map the captured tool_result blocks back to the original call
    // order. The tool_use ids in the staged turn carry an `_<idx>_`
    // suffix so we can recover the position.
    const byIdx = new Map<number, { content: string; isError: boolean }>();
    const turnUses = turn.toolUses ?? [];
    for (const r of captured) {
      const useIdx = turnUses.findIndex((u) => u.id === r.id);
      if (useIdx >= 0) byIdx.set(useIdx, { content: r.content, isError: r.isError });
    }
    return calls.map((_call, idx) => {
      const r = byIdx.get(idx);
      if (!r) return { ok: false, error: 'no tool_result returned by host CLI' };
      if (r.isError) return { ok: false, error: r.content };
      // Parse JSON when possible — most MCP tools return JSON-stringified
      // payloads. Fall back to raw string for plain-text returns.
      try {
        return { ok: true, result: JSON.parse(r.content) as unknown };
      } catch {
        return { ok: true, result: r.content };
      }
    });
  };

  // For ctx.agent we route to the user's REAL provider — no mock
  // involvement. This is a one-shot prompt, no tools. The simplest
  // shape: spawn the same CLI without mock injection and with no
  // tool allowlist; capture stdout as the assistant text. JSON
  // schema enforcement happens post-hoc in this layer.
  const agentDispatcher = async (
    call: { prompt: string; json?: unknown },
    _ctx: AutomationDispatchContext,
  ): Promise<unknown> => {
    // For v1 simplicity, we route through a fresh `claude -p` /
    // `codex exec` against the user's real config. Tests inject
    // their own dispatcher.
    const env = { ...process.env };
    const args =
      runner === 'claude-code'
        ? ['-p', call.prompt, '--output-format', 'text', '--permission-mode', 'bypassPermissions']
        : ['exec', '--json', '--ask-for-approval', 'never', call.prompt];
    const proc = spawn(runner === 'claude-code' ? 'claude' : 'codex', args, { env });
    const stdoutChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    const result = await new Promise<{ ok: boolean; text: string; stderr: string }>((resolve) => {
      const stderrChunks: Buffer[] = [];
      proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
      proc.on('exit', (code) =>
        resolve({
          ok: code === 0,
          text: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        }),
      );
      proc.on('error', (err) =>
        resolve({ ok: false, text: '', stderr: `spawn error: ${err.message}` }),
      );
    });
    if (!result.ok) {
      throw new Error(`ctx.agent CLI failed: ${result.stderr.slice(0, 2000)}`);
    }
    const text = result.text.trim();
    if (!call.json) return text;
    // JSON schema mode — parse and validate. We don't ship a full
    // JSON-schema validator here; for v1 we just require valid JSON
    // and trust the caller's schema documentation. A real validator
    // is on the roadmap.
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(
        `ctx.agent expected JSON but got: ${text.slice(0, 500)} (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
  };

  const outcome = await runAutomationHandler({
    app: { id: opts.appId, dir: opts.appDir },
    handlerFile,
    automationName: opts.automationName,
    runId,
    toolDispatcher,
    agentDispatcher,
    timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000,
    ...(opts.onWrite ? { onWrite: opts.onWrite } : {}),
  });

  await mock.close().catch(() => undefined);
  await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);

  const endedAt = Date.now();
  const record: AutomationRunRecord = {
    appId: opts.appId,
    automationName: opts.automationName,
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ok: outcome.ok,
    ...(outcome.error ? { error: outcome.error } : {}),
    toolBatches: outcome.toolBatches,
    agentCalls: outcome.agentCalls,
  };
  return { outcome, record };
}
