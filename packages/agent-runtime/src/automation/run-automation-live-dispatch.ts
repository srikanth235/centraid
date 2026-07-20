/*
 * Live `ctx.tool` / `ctx.agent` dispatch for the local automation
 * runner.
 *
 * Split out of `run-automation.ts` so that file can stay focused
 * on the per-fire lifecycle (manifest load, audit store, onFailure
 * cascade). This module owns the "live" side: the persistent mock-LLM
 * session, the single long-lived agent turn that executes every
 * `ctx.tool` batch (an in-process Claude SDK `query()` for claude, a
 * `codex exec` subprocess for codex — see `run-automation-host-agent.ts`
 * for why only those two can host it), and the `ctx.agent` one-shot
 * against the user's real provider.
 *
 * Issue #479 — `ctx.agent` honours every registered runner kind through ONE
 * path: `getRunnerBackend(kind).runTurn`, the same seam chat uses. The
 * bespoke codex (`codex exec`) and claude (SDK `query()`) arms are gone
 * along with the bespoke turn backends they belonged to, so pinning
 * `runner.automations` to any kind actually drives that agent.
 *
 * Note the asymmetry with `ctx.tool` below, and that it is deliberate:
 * tool dispatch still invokes the claude/codex CLIs NATIVELY (see
 * `run-automation-host-agent.ts`) because it works by pointing a CLI at a
 * per-fire mock LLM endpoint — a deterministic test/dispatch harness, not a
 * user-facing runner. ACP agents drive their own model loop and expose no
 * base URL to redirect, so that mechanism cannot move to ACP.
 *
 * Issue #166 — persistent session: a fire opens ONE agent session pointed
 * at the mock and keeps it alive across the whole handler run. The
 * deterministic handler drives; each `ctx.tool` batch is staged into the
 * live session (the CLI executes the tools natively through its MCP/auth
 * machinery and returns `tool_result` blocks), and the session only exits
 * when the fire ends and the driver stages a final `end_turn`. This
 * replaces the previous per-batch cold-start spawn: one session, ~0 real
 * model tokens (the mock dictates every turn), a structurally single and
 * controlled session. `ctx.agent` is the only billed path — a separate
 * bounded turn against the user's real provider.
 *
 * Issue #91: an automation is a standalone app — the CLI runs with
 * the app directory as cwd, and the dispatch context carries the
 * automation id (no owning app).
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as automation from '@centraid/automation';
import type { RunnerKind } from '../types.js';
import { getRunnerBackend } from '../registry.js';
import { defaultRunHostAgent, type RunHostAgent } from './run-automation-host-agent.js';

export interface LiveDispatchOptions {
  /** The automation app directory — also the CLI's cwd. */
  workdir: string;
  /** Id of the automation being fired. */
  automationId: string;
  runId: string;
  runner: RunnerKind;
  runHostAgent: RunHostAgent;
  /** Manifest `requires.tools` allowlist forwarded to the CLI. */
  toolsAllow: readonly string[];
  /**
   * Model id/alias for `ctx.agent` calls (manifest `requires.model`, or the
   * caller's prefs-resolved fallback — see `RunAutomationOptions.model`).
   * Undefined means "no override" — the backend's own default applies.
   * Only `ctx.agent` (the billed, real-provider path) reads this; the
   * persistent tool-dispatch session always talks to the mock, which
   * ignores the model field entirely.
   */
  model?: string;
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface LiveDispatch {
  toolDispatcher: automation.ToolDispatcher;
  agentDispatcher: automation.AgentDispatcher;
  /** Tear down the mock server + scratch dir. Safe to call once. */
  close(): Promise<void>;
}

/**
 * Stand up the live dispatch surface for the CLI runner: the shared persistent
 * mock session (issue #166) plus a scratch dir. The agent session is started
 * lazily on the first `ctx.tool` batch (an automation that never calls a tool
 * never opens one). The only runner-specific piece is the `driveAgent` adapter,
 * which runs the Claude SDK `query()` / `codex exec` against the mock;
 * everything else (the mock, batch staging/correlation, timing) is shared.
 */
export async function startLiveDispatch(opts: LiveDispatchOptions): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.workdir, '.automation-scratch', opts.runId);
  await fs.mkdir(scratchDir, { recursive: true });

  // The host agent adapter: point an in-process Claude SDK `query()` / a
  // `codex exec` subprocess at the mock for the lifetime of the fire. Resolves
  // when the agent turn ends (`close()` stages the final `end_turn`).
  const driveAgent: automation.AgentDriver = async (input) => {
    const outcome = await opts.runHostAgent({
      kind: opts.runner,
      mockBaseUrl: input.mockBaseUrl,
      mockBearerToken: input.mockBearerToken,
      prompt: input.prompt,
      toolsAllow: opts.toolsAllow,
      cwd: input.cwd,
      scratchDir,
      abortSignal: input.abortSignal,
    });
    return outcome.ok
      ? { ok: true }
      : {
          ok: false,
          error: `CLI exited code=${outcome.exitCode ?? '?'}\n${outcome.stderr.slice(0, 2000)}`,
        };
  };

  const session = await automation.startPersistentMockSession({
    workdir: opts.workdir,
    automationId: opts.automationId,
    driveAgent,
    onLog: opts.onLog,
  });
  const toolDispatcher: automation.ToolDispatcher = session.toolDispatcher;

  // Vault-derivative attachments (issue #299): the runner already resolved
  // and receipted them; here they become scratch files the CLI's native
  // multimodal Read path picks up — one mechanism for both runners, no
  // per-backend wire format.
  const stageAttachments = async (call: automation.AgentCall): Promise<string> => {
    if (!call.attachments?.length) return call.prompt;
    const lines: string[] = [];
    for (const att of call.attachments) {
      const file = path.join(scratchDir, `attach-${randomUUID().slice(0, 8)}-${att.name}`);
      if (att.base64 !== undefined) {
        await fs.writeFile(file, Buffer.from(att.base64, 'base64'));
      } else {
        await fs.writeFile(file, att.text ?? '', 'utf8');
      }
      lines.push(`- ${file} (${att.mediaType})`);
    }
    return `${call.prompt}\n\nAttached files — read each from disk before answering (images are visual input):\n${lines.join('\n')}`;
  };

  // ctx.agent routes to the user's REAL provider through the SAME runner
  // registry chat uses — one integration path for every kind (issue #479).
  // `runTurn` normalizes each agent's stream into TurnStreamEvents, so this
  // reads `final` / `error` and coerces the answer with no per-backend wire
  // format anywhere in this file.
  //
  // Two deliberate limits. (1) ACP has no `--output-schema` equivalent, so
  // `call.json` is enforced by `coerceAgentAnswer` alone — this is what the
  // claude arm always did, and codex now matches it (it previously had the
  // schema handed to `codex exec`). (2) A fire carries only the runner KIND
  // (the gateway drops binPath / extraArgs for every kind), so the backend
  // resolves its default binary off PATH. The custom `acp` kind has no
  // default binary and therefore surfaces a clear `error` event, raised below.
  const agentDispatcher: automation.AgentDispatcher = async (call, ctx): Promise<unknown> => {
    const effectivePrompt = await stageAttachments(call);
    let finalText = '';
    let errorMessage: string | undefined;
    await getRunnerBackend(opts.runner).runTurn(
      {
        cwd: opts.workdir,
        message: effectivePrompt,
        extraSystemPrompt: '',
        ...(opts.model ? { model: opts.model } : {}),
        abortSignal: ctx.abortSignal,
        onEvent: (ev) => {
          if (ev.type === 'final') finalText = ev.text;
          else if (ev.type === 'error') errorMessage = ev.message;
          call.onEvent?.(ev);
        },
      },
      { prefs: { kind: opts.runner } },
    );
    if (errorMessage && !finalText) {
      throw new Error(`ctx.agent (${opts.runner}) failed: ${errorMessage}`);
    }
    return automation.coerceAgentAnswer(finalText, call.json);
  };

  let closed = false;
  return {
    toolDispatcher,
    agentDispatcher,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // End the shared session (final `end_turn` + drain + mock stop), then
      // remove the CLI scratch dir this host owns.
      await session.close().catch(() => undefined);
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export { defaultRunHostAgent };
