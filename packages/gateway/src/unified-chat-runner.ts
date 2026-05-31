/*
 * Unified chat runner (issue #141, Phase 3 — "the big one").
 *
 * One chat surface, both jobs. "Builder chat" (tweak the app's code) and
 * "app chat" (operate its data) used to be two call sites on the same
 * engine; this runner merges them. A turn now runs with:
 *
 *   - cwd = the app's OPEN draft session worktree (`worktrees/sessions/
 *     desktop-<appId>/apps/<appId>/`), so the agent's native file edits
 *     stage in the draft — the same worktree the renderer's Code tab and
 *     the (retiring) local builder agent share, keyed `desktop-<appId>`;
 *   - the UNION of tools: the codex/claude adapter's native file-edit +
 *     shell tools (workspace-write against cwd) PLUS the `centraid_*`
 *     dispatcher threaded via `toolContext`, so the same turn can author a
 *     migration and answer a data question;
 *   - the unified system prompt: the data/schema preamble the chat route
 *     builds (`input.extraSystemPrompt`) followed by the builder authoring
 *     prompt + UI/tools grounding (folded in here).
 *
 * Code edits STAGE in the draft (the preview iframe reflects the draft);
 * data tools hit the LIVE `data.sqlite` (registry-resolved, independent of
 * cwd). The user clicks Publish to flip the live version — explicit-publish
 * holds. Webhook secrets are minted as a post-turn step (the agent can't
 * generate crypto-random credentials) and surfaced once via a `webhooks`
 * stream event.
 *
 * Replaces `@centraid/agent-runtime`'s `makeChatRunner` injection in
 * `serve.ts` whenever a git store is active (the local embedded gateway and
 * the standalone daemon both have one). Without a store there's no draft
 * worktree to edit, so the host falls back to the data-only `makeChatRunner`.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  runAgentTurn,
  enumerateHostTools,
  defaultCentraidCliDir,
  type AgentTurnInput,
  type RunnerPrefs,
  type ToolContext,
  type HostTool,
} from '@centraid/agent-runtime';
import {
  type ChatRunInput,
  type ChatRunResult,
  type ChatRunner,
  type Dispatcher,
  provisionAppPendingWebhooks,
  WEBHOOK_ROUTE_PREFIX,
} from '@centraid/app-engine';
import { composeSkills, buildUiGroundingBlocks, buildToolsGroundingBlock } from '@centraid/skills';
import { AppsStore } from '@centraid/code-store';
import { ensureSession } from './lifecycle-shared.js';

/** The thin turn-driver the runner depends on — `runAgentTurn` by default. */
export type RunTurnFn = typeof runAgentTurn;

export interface UnifiedChatRunnerOptions {
  /** Git store backing app code; the draft worktree lives in its sessions. */
  store: AppsStore;
  /** Per-turn runner prefs (kind + provider). Loaded fresh so settings
   *  changes apply without a restart — mirrors `makeChatRunner`. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /** Resolve the shared app-engine dispatcher for the `centraid_*` tools.
   *  Called per turn so the host can cycle-break on first use. */
  getDispatcher: () => Dispatcher;
  /** Parent dir for scoped `CODEX_HOME`s when a custom provider is set. */
  codexHomeBaseDir?: string;
  /** Resolve the public base URL (`http://host:port`) used to build webhook
   *  URLs after minting. A thunk because the ephemeral port is only known
   *  after the server starts — and a turn only ever runs post-start. */
  publicBaseUrl: () => string;
  /** Session id for an app's shared draft worktree. Defaults to the
   *  `desktop-<appId>` scheme the renderer + builder already use, so all
   *  three edit ONE draft. Overridable for tests. */
  sessionIdFor?: (appId: string) => string;
  /** Turn driver — defaults to `runAgentTurn`; injected in tests. */
  runTurn?: RunTurnFn;
  /** Host-tool enumerator for the grounding block — defaults to
   *  `enumerateHostTools`; injected in tests to stay hermetic. */
  enumerateTools?: typeof enumerateHostTools;
}

function defaultSessionIdFor(appId: string): string {
  return `desktop-${appId}`;
}

/**
 * Read the app's `kind` from the worktree `app.json` so the runner picks
 * the right authoring prompt (an automation has no front end → skip UI
 * grounding). Defaults to `'app'` when the file is missing/unreadable.
 */
async function readAppKind(appDir: string): Promise<'app' | 'automation'> {
  try {
    const raw = await fs.readFile(path.join(appDir, 'app.json'), 'utf8');
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return parsed.kind === 'automation' ? 'automation' : 'app';
  } catch {
    return 'app';
  }
}

// `enumerateHostTools` spawns the configured CLI to list its tools — too
// costly to repeat every turn, and stable for a given runner kind within a
// process. Cache the resolved tool list per kind (best-effort; a failure
// caches nothing so the next turn retries).
const toolsByKind = new Map<RunnerPrefs['kind'], readonly HostTool[]>();

async function groundingToolsFor(
  enumerate: typeof enumerateHostTools,
  prefs: RunnerPrefs,
  cwd: string,
): Promise<readonly HostTool[]> {
  const cached = toolsByKind.get(prefs.kind);
  if (cached) return cached;
  try {
    const tools = await enumerate(prefs.kind, {
      cwd,
      ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
    });
    toolsByKind.set(prefs.kind, tools);
    return tools;
  } catch {
    return [];
  }
}

/**
 * Compose the unified system prompt: the chat route's data/schema preamble
 * (`baseExtra`) first, then the builder authoring blocks. Mirrors the old
 * agent-harness `buildExtraSystemPrompt`, minus the live-schema block —
 * `baseExtra` already carries the live schema for this app.
 */
async function buildUnifiedExtraPrompt(
  enumerate: typeof enumerateHostTools,
  baseExtra: string,
  appKind: 'app' | 'automation',
  prefs: RunnerPrefs,
  cwd: string,
): Promise<string> {
  const blocks: string[] = baseExtra ? [baseExtra] : [];
  if (appKind === 'automation') {
    blocks.push(composeSkills(['automation-authoring']));
  } else {
    blocks.push(composeSkills(['authoring-centraid-apps']), ...buildUiGroundingBlocks());
  }
  const toolsBlock = buildToolsGroundingBlock(await groundingToolsFor(enumerate, prefs, cwd));
  if (toolsBlock) blocks.push(toolsBlock);
  return blocks.join('\n\n');
}

export function makeUnifiedChatRunner(opts: UnifiedChatRunnerOptions): ChatRunner {
  const sessionIdFor = opts.sessionIdFor ?? defaultSessionIdFor;
  const runTurn = opts.runTurn ?? runAgentTurn;
  const enumerate = opts.enumerateTools ?? enumerateHostTools;
  const extraPath = defaultCentraidCliDir();

  return {
    async run(input: ChatRunInput): Promise<ChatRunResult> {
      const prefs = await opts.prefsLoader();
      if (!prefs) {
        input.onEvent({
          type: 'error',
          message:
            'No coding agent configured. Open Settings → AI providers and pick Codex or Claude Code.',
        });
        throw new Error('no coding agent configured');
      }

      // Open (or reuse) the app's shared draft worktree, then run the turn
      // there so native file edits stage in the draft.
      const sessionId = sessionIdFor(input.appId);
      await ensureSession(opts.store, sessionId);
      const cwd = await opts.store.snapshotSessionAppDir(sessionId, input.appId);

      const appKind = await readAppKind(cwd);
      const extraSystemPrompt = await buildUnifiedExtraPrompt(
        enumerate,
        input.extraSystemPrompt,
        appKind,
        prefs,
        cwd,
      );

      // Union of tools: the adapter's native file/shell tools (workspace-write
      // against `cwd`) plus the `centraid_*` dispatcher.
      const toolContext: ToolContext = {
        appId: input.appId,
        dispatcher: opts.getDispatcher(),
        agentTurnId: randomUUID(),
      };

      // Resume only when the prior turn used the same runner kind.
      const resumeId =
        input.prevAdapterKind === prefs.kind ? input.prevAdapterSessionId : undefined;

      const turnInput: AgentTurnInput = {
        cwd,
        message: input.message,
        extraSystemPrompt,
        toolContext,
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
        ...(extraPath ? { extraPath } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(resumeId ? { prevSessionId: resumeId } : {}),
      };

      const result = await runTurn(turnInput, {
        prefs,
        ...(opts.codexHomeBaseDir ? { codexHomeBaseDir: opts.codexHomeBaseDir } : {}),
      });

      // Post-turn webhook minting: if the agent authored an automation with
      // a pending webhook trigger, mint the route id + secret now and surface
      // it once. Best-effort — a minting hiccup never fails the turn.
      try {
        const minted = await provisionAppPendingWebhooks(cwd);
        if (minted.length > 0) {
          const base = opts.publicBaseUrl();
          input.onEvent({
            type: 'webhooks',
            minted: minted.map((w) => ({
              automationId: w.automationId,
              ownerApp: w.ownerApp,
              webhookId: w.webhookId,
              url: `${base}${WEBHOOK_ROUTE_PREFIX}/${w.webhookId}`,
              secret: w.secret,
            })),
          });
        }
      } catch {
        /* minting is best-effort — the staged manifest can be re-provisioned */
      }

      return {
        adapterKind: result.adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
