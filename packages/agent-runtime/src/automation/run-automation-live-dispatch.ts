/*
 * Live `ctx.agent` dispatch for the local automation runner.
 *
 * Split out of `run-automation.ts` so that file can stay focused on the
 * per-fire lifecycle (manifest load, audit store, onFailure cascade). This
 * module owns the one billed rail — `ctx.agent`, a bounded one-shot turn
 * against the user's real provider.
 *
 * Issue #479 — `ctx.agent` honours every registered runner kind through ONE
 * path: `getRunnerBackend(kind).runTurn`, the same seam chat uses. Pinning
 * `runner.automations` to any kind actually drives that agent.
 *
 * Issue #484 — the `ctx.tool` rail was removed. It used to dispatch tool
 * batches to a persistent mock-LLM session that puppeted the claude/codex
 * CLIs; that mock HTTP server started eagerly per fire even when unused. It
 * is gone. A fire whose handler never calls `ctx.agent` now starts ZERO child
 * processes and ZERO HTTP servers: the deterministic rails (`ctx.vault`,
 * `ctx.fetch`, `ctx.state`, `ctx.runs`) are serviced in-process, parent-side.
 * The only thing this surface allocates lazily is a scratch dir — and only
 * when a `ctx.agent` call actually carries vault-derivative attachments.
 *
 * Issue #91: an automation is a standalone app — the agent runs with the app
 * directory as cwd, and the dispatch context carries the automation id (no
 * owning app).
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as automation from '@centraid/automation';
import type { RunnerKind } from '../types.js';
import { getRunnerBackend } from '../registry.js';

export interface LiveDispatchOptions {
  /** The automation app directory — also the agent's cwd. */
  workdir: string;
  runId: string;
  runner: RunnerKind;
  /**
   * Model id/alias for `ctx.agent` calls (manifest `requires.model`, or the
   * caller's prefs-resolved fallback — see `RunAutomationOptions.model`).
   * Undefined means "no override" — the backend's own default applies.
   */
  model?: string;
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface LiveDispatch {
  agentDispatcher: automation.AgentDispatcher;
  /** Tear down the scratch dir (only ever created if an attachment was
   *  staged). Safe to call once. */
  close(): Promise<void>;
}

/**
 * Stand up the live dispatch surface for the CLI runner. `ctx.agent` routes to
 * the user's REAL provider through the runner registry; everything else on the
 * `ctx.*` surface is deterministic and serviced parent-side, so this allocates
 * nothing eagerly. The scratch dir is created lazily, only when a `ctx.agent`
 * call carries vault derivatives to stage.
 */
export async function startLiveDispatch(opts: LiveDispatchOptions): Promise<LiveDispatch> {
  const scratchDir = path.join(opts.workdir, '.automation-scratch', opts.runId);
  let scratchReady = false;
  const ensureScratch = async (): Promise<void> => {
    if (scratchReady) return;
    await fs.mkdir(scratchDir, { recursive: true });
    scratchReady = true;
  };

  // Vault-derivative attachments (issue #299): the runner already resolved
  // and receipted them; here they become scratch files the agent's native
  // multimodal Read path picks up — one mechanism for every runner, no
  // per-backend wire format. The scratch dir materializes only on first use.
  const stageAttachments = async (call: automation.AgentCall): Promise<string> => {
    if (!call.attachments?.length) return call.prompt;
    await ensureScratch();
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
  // `call.json` is enforced by `coerceAgentAnswer` alone. (2) A fire carries
  // only the runner KIND (the gateway drops binPath / extraArgs for every
  // kind), so the backend resolves its default binary off PATH. The custom
  // `acp` kind has no default binary and therefore surfaces a clear `error`
  // event, raised below.
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
    agentDispatcher,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Only ever created if an attachment was staged — the rm is a no-op
      // otherwise, so a tool-free / attachment-free fire touches no disk here.
      if (scratchReady) {
        await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
