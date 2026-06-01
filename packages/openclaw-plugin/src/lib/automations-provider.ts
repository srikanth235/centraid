/**
 * Centraid automation provider plugin for openclaw — the "centraid-mock"
 * registered provider whose StreamFn is the in-process equivalent of the
 * local-side mock-LLM + CLI subprocess flow.
 *
 * Shape (see issue #70 § Remote / openclaw runtime):
 *
 *   - `registerProvider({ id: "centraid-mock", auth: [], augmentModelCatalog,
 *     resolveDynamicModel, createStreamFn })`
 *   - Cron fires with `model: "centraid-mock/run-automation"`. Openclaw's
 *     cron service routes to our StreamFn.
 *   - StreamFn:
 *       1. Recovers the automation handle from the prompt sentinel
 *          `<<<centraid:<appId>/<automationId>>>>`.
 *       2. Loads the automation app (`automation.json` + `handler.js`)
 *          from the owning app's active version under `appsDir`.
 *       3. Runs the handler via `runAutomationHandler` from app-engine,
 *          wiring an `AgentRunsStore` over the activity DB
 *          for the run audit + `ctx.state`.
 *          - toolDispatcher routes through `callGatewayTool` (full
 *            harness MCP routing + audit + before-tool hooks for free).
 *          - agentDispatcher routes through
 *            `prepareSimpleCompletionModelForAgent` +
 *            `completeWithPreparedSimpleCompletionModel` against the
 *            user's REAL provider (the one declared in
 *            `manifest.requires.model`). NOT re-entrant into the
 *            centraid-mock StreamFn.
 *       4. Emits a final AssistantMessage with non-empty text content
 *          (required to avoid openclaw's "needs fallback" classifier —
 *          see issue #70 § What happens when cron fires) and
 *          stopReason "stop".
 *
 * The registration glue (registerProvider) is the plugin entry's job —
 * this module just exports the ProviderPlugin descriptor as a factory.
 */

import type { AnalyticsStore } from '@centraid/analytics';
import { runOpenclawFire } from './openclaw-fire.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
// pi-ai types — open-import (matches openclaw's own pattern) so this
// module's exported descriptor lines up with the StreamFn shape the
// openclaw runtime expects.
import type { AssistantMessage, AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';

// Re-exported so the plugin entry's `import { setOpenClawConfig }` stays
// pointed at this module after the per-fire logic moved to openclaw-fire.
export { setOpenClawConfig } from './openclaw-fire.js';

/**
 * Local structural type for the ProviderPlugin descriptor we register.
 * The full type lives in openclaw's `plugins/types.ts` but isn't
 * exposed via a stable public subpath — we declare the subset we
 * actually populate so this module compiles against the installed
 * openclaw without reaching into a private path.
 */
interface ProviderPluginShape {
  id: string;
  label: string;
  auth: readonly unknown[];
  augmentModelCatalog?: (ctx: unknown) => unknown;
  resolveDynamicModel?: (ctx: { modelId: string }) => unknown;
  createStreamFn?: (ctx: unknown) => unknown;
}

export interface AutomationsProviderOptions {
  /** Directory holding the gateway's per-app DATA folders (`runtime.sqlite`). */
  appsDir: string;
  /**
   * Resolves the live app CODE dir on git-store `main`
   * (`<worktree>/apps`). A thunk because the active-main link rotates on
   * each publish/rollback — call it per fire to pick up the current code.
   */
  codeAppsDir: () => string;
  /**
   * Central analytics store — a finished automation run write-throughs
   * its summary here (issue #98). The run ledger itself is the per-app
   * `runtime.sqlite`, resolved per fire from `appsDir`.
   */
  analytics?: AnalyticsStore;
  /** Optional logger. */
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export const CENTRAID_MOCK_PROVIDER_ID = 'centraid-mock';
export const CENTRAID_MOCK_MODEL_ID = 'run-automation';

/**
 * Build the ProviderPlugin descriptor centraid registers under
 * `api.registerProvider(...)`. The plugin entry calls this with a
 * resolver closure so the StreamFn can find each app's disk dir.
 */
export function makeAutomationsProvider(opts: AutomationsProviderOptions): ProviderPluginShape {
  const log = opts.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  return {
    id: CENTRAID_MOCK_PROVIDER_ID,
    label: 'Centraid Automation Runner',
    auth: [],
    augmentModelCatalog: () => [
      {
        provider: CENTRAID_MOCK_PROVIDER_ID,
        id: CENTRAID_MOCK_MODEL_ID,
        // Catalog entries pass openclaw's `agents.defaults.models`
        // allowlist check (see isolated-agent-SKs97XgD.js:82-95 in
        // openclaw). The fields beyond {provider, id} are
        // implementation-detail of model-catalog.types.ts; openclaw
        // tolerates a minimal entry.
      } as never,
    ],
    resolveDynamicModel: ({ modelId }) => {
      if (modelId !== CENTRAID_MOCK_MODEL_ID) return undefined;
      // Stub runtime model — openclaw consults this when resolving a
      // model reference into a Model<Api>. The values are placeholders
      // because we override the StreamFn entirely; the agent loop
      // never invokes pi-ai's actual transport for our provider.
      return {
        provider: CENTRAID_MOCK_PROVIDER_ID,
        api: 'centraid-mock' as never,
        id: CENTRAID_MOCK_MODEL_ID,
      } as never;
    },
    createStreamFn: (_ctx: unknown) => makeAutomationStreamFn(opts, log),
  };
}

/**
 * The StreamFn body. Signature mirrors `streamSimple` from
 * `@mariozechner/pi-ai`: takes (model, context, options?) and returns
 * an AssistantMessageEventStream that the openclaw agent loop awaits.
 *
 * We don't actually stream — automations are deterministic — but we
 * emit a single AssistantMessage event into the stream so openclaw
 * sees a well-formed turn.
 */
function makeAutomationStreamFn(
  opts: AutomationsProviderOptions,
  log: { info(m: string): void; warn(m: string): void; error(m: string): void },
) {
  return (..._args: unknown[]): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void executeAutomation(opts, log, _args).then(
      (msg) => {
        // Emit a single assistant event and end the stream with the
        // final AssistantMessage. The `done` event carries the
        // message; openclaw's classifier sees non-empty text content
        // and stopReason "stop", so the cron run is logged successful.
        stream.push({ type: 'assistantMessageEnd', message: msg } as never);
        stream.end(msg);
      },
      (err: unknown) => {
        // On unhandled failure inside the StreamFn, return a
        // synthetic AssistantMessage with stopReason "error" — that's
        // openclaw's contract for surfacing fatal errors.
        const msg = errorMessage(err instanceof Error ? err.message : String(err));
        stream.push({ type: 'assistantMessageEnd', message: msg } as never);
        stream.end(msg);
      },
    );
    return stream;
  };
}

const PROMPT_SENTINEL = /<<<centraid:([^>]+)>>>/;

interface ParsedDispatch {
  automationRef: string;
}

function parsePromptSentinel(prompt: string): ParsedDispatch | undefined {
  const match = PROMPT_SENTINEL.exec(prompt);
  if (!match) return undefined;
  return { automationRef: match[1]! };
}

/**
 * Find the dispatch sentinel anywhere in the context's user messages.
 * Openclaw's cron preparation appends "delivery instructions" after
 * the original message, so the sentinel won't always be at position 0
 * of any single string.
 */
function recoverDispatch(args: unknown[]): ParsedDispatch | undefined {
  // The pi-ai streamSimple signature is (model, context, options?).
  // `context` is the second arg; `.messages` is an array of messages
  // whose `content` is a string or content-block array.
  if (args.length < 2 || typeof args[1] !== 'object' || args[1] === null) return undefined;
  const ctx = args[1] as { messages?: unknown };
  const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === 'string') {
      const found = parsePromptSentinel(content);
      if (found) return found;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string') {
            const found = parsePromptSentinel(text);
            if (found) return found;
          }
        }
      }
    }
  }
  return undefined;
}

async function executeAutomation(
  opts: AutomationsProviderOptions,
  log: { info(m: string): void; warn(m: string): void; error(m: string): void },
  streamFnArgs: unknown[],
): Promise<AssistantMessage> {
  const dispatch = recoverDispatch(streamFnArgs);
  if (!dispatch) {
    return errorMessage(
      'centraid-mock StreamFn invoked without the <<<centraid:<appId>/<id>>>> sentinel in the prompt — this provider should only be triggered by centraid-registered cron jobs',
    );
  }
  const outcome = await runOpenclawFire(
    {
      automationRef: dispatch.automationRef,
      appsDir: opts.appsDir,
      codeAppsDir: opts.codeAppsDir(),
      ...(opts.analytics ? { analytics: opts.analytics } : {}),
      triggerKind: 'scheduled',
      triggerOrigin: 'cron',
    },
    log,
  );
  if (!outcome.ok) {
    log.error(`automation ${dispatch.automationRef} failed: ${outcome.error}`);
    return errorMessage(`automation failed: ${outcome.error ?? 'unknown error'}`);
  }
  return successMessage(outcome.summary ?? 'ok');
}

function successMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'centraid-mock' as never,
    provider: CENTRAID_MOCK_PROVIDER_ID as never,
    model: CENTRAID_MOCK_MODEL_ID,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
    stopReason: 'stop' as never,
    timestamp: Date.now(),
  };
}

function errorMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'centraid-mock' as never,
    provider: CENTRAID_MOCK_PROVIDER_ID as never,
    model: CENTRAID_MOCK_MODEL_ID,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
    stopReason: 'error' as never,
    errorMessage: text,
    timestamp: Date.now(),
  };
}

/**
 * Convenience verb the plugin entry calls during `register()`.
 * Wires the provider into openclaw + binds the config ref. Returns
 * the registered ProviderPlugin so callers can stash a reference if
 * they need it later (e.g. for tests).
 */
export function registerAutomationsProvider(
  api: OpenClawPluginApi,
  opts: AutomationsProviderOptions,
): ProviderPluginShape {
  const provider = makeAutomationsProvider(opts);
  // openclaw exposes `api.config` lazily via `gateway_start`; the
  // plugin entry calls setOpenClawConfig() there.
  api.registerProvider(provider as never);
  return provider;
}
