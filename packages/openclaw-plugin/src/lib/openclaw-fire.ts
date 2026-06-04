/*
 * OpenClaw automation fire — mock-puppeted, on the shared spine (issue #166).
 *
 * `runOpenclawFire` delegates the per-fire orchestration (manifest load, ledger,
 * onFailure) to app-engine's `runAutomationFire`,
 * and injects an OpenClaw `OpenAutomationDispatch` — the ONLY host-specific
 * piece. Both dispatchers run one embedded-agent turn via the shared
 * `runEmbeddedTurn` helper (also used by the chat runner):
 *
 *   - `toolDispatcher` rides the shared `startPersistentMockSession`: ONE
 *     embedded-agent session per fire, pointed at a localhost `centraid-mock`
 *     provider (base_url → the mock). The deterministic handler stages each
 *     `ctx.tool` batch into that session; the embedded agent executes the
 *     mock-staged tool through its native tool/MCP machinery (the same
 *     `callGatewayTool` path, now driven from inside the agent loop) and
 *     returns the result — ~0 real model tokens (the mock dictates every turn).
 *   - `agentDispatcher` is `runEmbeddedAgent({ modelRun: true })` against the
 *     user's REAL provider — the one billed path, at the manifest's model tier.
 *
 * This is the same persistent-session runtime the codex/claude CLI host uses;
 * the only difference is the `driveAgent` adapter (an embedded run vs. a CLI
 * subprocess). The bespoke in-process dispatchers (`callGatewayTool` /
 * `prepareSimpleCompletionModelForAgent` wired directly) and the
 * `setOpenClawConfig` global are gone — `api` is captured by closure.
 *
 * NOTE: end-to-end execution (the embedded agent hitting the localhost mock on
 * a supported wire and running mock-staged tools) is validated on a live
 * OpenClaw host, not from a bare worktree — the issue's Phase 2 spike. The
 * code is type-checked against the installed SDK; the host run confirms the
 * wire (`anthropic-messages`) + tool-name-space assumptions.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  coerceAgentAnswer,
  runAutomationFire,
  startPersistentMockSession,
  type AgentDriver,
  type AutomationAgentCall,
  type AutomationDispatchContext,
  type AutomationDispatchSurface,
  type AutomationHandlerOutcome,
  type OpenAutomationDispatch,
  type OpenAutomationDispatchArgs,
} from '@centraid/automation-engine';
import {
  type AnalyticsStore,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
} from '@centraid/app-engine';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { runEmbeddedTurn, payloadText, type EmbeddedConfig } from './openclaw-agent-turn.js';

/** The `centraid-mock` provider the embedded agent is pointed at for tools. */
const MOCK_PROVIDER = 'centraid-mock';
const MOCK_MODEL = 'centraid-mock-run-automation';
const FIRE_TIMEOUT_MS = 5 * 60 * 1000;

export interface OpenclawFireOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /**
   * Directory holding the gateway's per-app DATA folders
   * (`<appsDir>/<id>/runtime.sqlite` + `data.sqlite`). Stable across version
   * swaps — this is NOT where code lives (issue #137).
   */
  appsDir: string;
  /**
   * Directory holding the live app CODE on git-store `main`. Resolved per fire
   * from the store's active-main link so a publish/rollback is picked up.
   */
  codeAppsDir: string;
  /** Central analytics store for run-summary write-through (issue #98). */
  analytics?: AnalyticsStore;
  triggerKind: AutomationTriggerKind;
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  triggerOrigin?: AutomationTriggerOrigin;
  /** Optional input payload (e.g. webhook body). */
  input?: unknown;
}

type FireLog = { info(m: string): void; warn(m: string): void; error(m: string): void };

/**
 * Patch the base OpenClaw config with a localhost `centraid-mock` provider so
 * the embedded agent's model calls hit the mock (token-free) on the
 * `anthropic-messages` wire the mock serves at `<baseUrl>/messages`.
 */
function withMockProvider(base: EmbeddedConfig, baseUrl: string, apiKey: string): EmbeddedConfig {
  const models = (base.models ?? {}) as NonNullable<EmbeddedConfig['models']>;
  const providers = { ...models.providers };
  providers[MOCK_PROVIDER] = {
    baseUrl,
    apiKey,
    auth: 'api-key',
    api: 'anthropic-messages',
    models: [
      {
        id: MOCK_MODEL,
        name: 'Centraid Automation Mock',
        api: 'anthropic-messages',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  };
  return { ...base, models: { ...models, mode: 'merge', providers } };
}

/**
 * Build the OpenClaw dispatch surface: the mock-puppeted tool session +
 * `modelRun` agent, both via `runEmbeddedAgent`. Captures `api` so no global
 * config handle is needed.
 */
function makeOpenClawDispatch(api: OpenClawPluginApi): OpenAutomationDispatch {
  const baseCfg = (api as unknown as { config?: EmbeddedConfig }).config;
  return async (args: OpenAutomationDispatchArgs): Promise<AutomationDispatchSurface> => {
    if (!baseCfg) {
      throw new Error('centraid automation fire: OpenClaw api.config is unavailable');
    }
    const scratchDir = path.join(args.workdir, '.automation-scratch', args.runId);
    await fs.mkdir(scratchDir, { recursive: true });

    // The OpenClaw host adapter: drive ONE embedded-agent session against the
    // localhost mock for the lifetime of the fire (the mock dictates turns; the
    // agent executes staged tools through its native loop). Resolves on exit.
    const driveAgent: AgentDriver = async (input) => {
      const sessionFile = path.join(scratchDir, 'tool-session.json');
      try {
        await runEmbeddedTurn(api, {
          sessionId: `centraid-automation:${args.automationRef}`,
          sessionKey: `centraid-automation:${args.automationRef}`,
          sessionFile,
          workspaceDir: args.workdir,
          provider: MOCK_PROVIDER,
          model: MOCK_MODEL,
          config: withMockProvider(baseCfg, input.mockBaseUrl, input.mockBearerToken),
          prompt: input.prompt,
          trigger: 'manual',
          timeoutMs: FIRE_TIMEOUT_MS,
          runId: `${args.runId}:tools`,
          abortSignal: input.abortSignal,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    const session = await startPersistentMockSession({
      workdir: args.workdir,
      automationId: args.automationRef,
      driveAgent,
      onLog: args.onLog,
    });

    // ctx.agent → a bounded one-shot model probe (no tools) against the user's
    // REAL provider, at the manifest's declared tier. The only billed path.
    const agentDispatcher = async (
      call: AutomationAgentCall,
      ctx: AutomationDispatchContext,
    ): Promise<unknown> => {
      const sessionFile = path.join(scratchDir, `agent-${randomUUID().slice(0, 8)}.json`);
      const result = await runEmbeddedTurn(api, {
        sessionId: `centraid-automation-agent:${ctx.automationId}`,
        sessionKey: `centraid-automation-agent:${ctx.automationId}`,
        sessionFile,
        workspaceDir: args.workdir,
        modelRun: true,
        disableTools: true,
        ...(args.model ? { model: args.model } : {}),
        prompt: call.prompt,
        trigger: 'manual',
        timeoutMs: FIRE_TIMEOUT_MS,
        runId: `${args.runId}:agent:${randomUUID().slice(0, 6)}`,
        abortSignal: ctx.abortSignal,
      });
      return coerceAgentAnswer(payloadText(result), call.json);
    };

    return {
      toolDispatcher: session.toolDispatcher,
      agentDispatcher,
      async close() {
        await session.close().catch(() => undefined);
        await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  };
}

/** One automation fire on the OpenClaw host. Returns the handler outcome plus
 *  the run id (preserved for the webhook route + callers). */
export async function runOpenclawFire(
  opts: OpenclawFireOptions,
  log: FireLog,
  api: OpenClawPluginApi,
): Promise<AutomationHandlerOutcome & { runId: string }> {
  const { outcome, record } = await runAutomationFire(
    {
      automationRef: opts.automationRef,
      appsDir: opts.appsDir,
      codeAppsDir: opts.codeAppsDir,
      ...(opts.analytics ? { analytics: opts.analytics } : {}),
      onLog: (level, msg) => log[level](msg),
      triggerKind: opts.triggerKind,
      ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    },
    { openDispatch: makeOpenClawDispatch(api) },
  );
  return { ...outcome, runId: record.runId };
}
