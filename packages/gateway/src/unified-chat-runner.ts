/*
 * Unified chat runner (issue #141, Phase 3 — "the big one").
 *
 * One chat surface, both jobs. "Builder chat" (tweak the app's code) and
 * "app chat" (operate its data) used to be two call sites on the same
 * engine; this runner merges them. A turn now runs with:
 *
 *   - cwd = the app's OPEN draft session worktree (`worktrees/sessions/
 *     <sessionId>/apps/<appId>/`), so the agent's native file edits stage in
 *     the draft. `<sessionId>` is host-provided via `sessionIdFor` (the
 *     desktop injects `desktop-<appId>` so this is the same worktree the
 *     renderer's Code tab and the local builder agent share); the core
 *     defaults to a host-neutral `chat-<appId>`;
 *   - the UNION of tools: the codex/claude adapter's native file-edit +
 *     shell tools (workspace-write against cwd) PLUS the `centraid_*`
 *     dispatcher threaded via `toolContext`, so the same turn can author a
 *     migration and answer a data question;
 *   - the unified system prompt: the data/schema preamble the chat route
 *     builds (`input.extraSystemPrompt`) followed by the builder authoring
 *     prompt + UI/tools grounding (composed by `@centraid/skills`).
 *
 * Both code edits AND data ops STAGE in the draft (issue #144): native file
 * edits land in the worktree, and the `centraid_*` tools dispatch with
 * `overrideCodeDir = cwd`, so they hit the draft's branched `data.sqlite`
 * (data dir = code dir in draft mode) — the agent can author a migration and
 * exercise it against prod-seeded draft data without touching live rows. The
 * user clicks Publish to flip the live version + apply the migration to live
 * data — explicit-publish holds. Webhook secrets are minted as a post-turn
 * step (the agent can't generate crypto-random credentials) and surfaced once
 * via a `webhooks` stream event.
 *
 * Since issue #147 (Concern 1) this is a thin config over
 * `makeChatRunnerCore` (`@centraid/conversation-engine`): the shared per-turn
 * spine lives there; this file supplies only the builder seams — draft-worktree cwd,
 * the authoring prompt (delegated to `@centraid/skills`), and post-turn
 * webhook minting.
 *
 * Replaces the data-only `makeChatRunner` injection in `serve.ts` whenever a
 * git store is active (the local embedded gateway and the standalone daemon
 * both have one). Without a store there's no draft worktree to edit, so the
 * host falls back to the data-only `makeChatRunner`.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { enumerateHostTools, defaultCentraidCliDir, runAgentTurn } from '@centraid/agent-runtime';
import {
  type ChatRunner,
  type ChatStreamEvent,
  type Dispatcher,
  type RunnerPrefs,
  type RunTurnFn,
} from '@centraid/app-engine';
import {
  makeChatRunnerCore,
  provisionAppPendingWebhooks,
  WEBHOOK_ROUTE_PREFIX,
} from '@centraid/conversation-engine';
import { buildAuthoringExtraPrompt } from '@centraid/skills';
import { WorktreeStore } from './worktree-store/index.js';
import { ensureSession } from './lifecycle-shared.js';
import { seedDraftData } from './draft-data.js';

export type { RunTurnFn };

export interface UnifiedChatRunnerOptions {
  /** Git store backing app code; the draft worktree lives in its sessions. */
  store: WorktreeStore;
  /** Per-turn runner prefs (kind + provider). Loaded fresh so settings
   *  changes apply without a restart — mirrors `makeChatRunner`. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /** Resolve the shared app-engine dispatcher for the `centraid_*` tools.
   *  Called per turn so the host can cycle-break on first use. */
  getDispatcher: () => Dispatcher;
  /** Resolve the public base URL (`http://host:port`) used to build webhook
   *  URLs after minting. A thunk because the ephemeral port is only known
   *  after the server starts — and a turn only ever runs post-start. */
  publicBaseUrl: () => string;
  /** Resolve an app's live `data.sqlite` path. When set, the turn's draft
   *  worktree is seeded from it on first access (issue #144) so the agent
   *  operates on prod-shaped data while testing. */
  liveDataFile?: (appId: string) => string;
  /** Session id for an app's shared draft worktree. Defaults to a
   *  host-neutral `chat-<appId>` scheme. Hosts that share the draft with
   *  another editing surface inject their own scheme — the desktop passes
   *  `desktop-<appId>` so the renderer Code tab, the local builder, and
   *  gateway chat all edit ONE draft. Also overridable for tests. */
  sessionIdFor?: (appId: string) => string;
  /** Turn driver — defaults to `runAgentTurn`; injected in tests. */
  runTurn?: RunTurnFn;
  /** Host-tool enumerator for the grounding block — defaults to
   *  `enumerateHostTools`; injected in tests to stay hermetic. */
  enumerateTools?: typeof enumerateHostTools;
}

function defaultSessionIdFor(appId: string): string {
  // Host-neutral default — the `buildGateway()` core must not bake the
  // desktop renderer's scheme in. Hosts that share the draft with another
  // editing surface inject `sessionIdFor` (the desktop passes
  // `desktop-<appId>`); the standalone daemon, with no second editor, is
  // happy with this self-consistent scheme.
  return `chat-${appId}`;
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

/**
 * Mint any webhook secrets the turn left pending and surface them once via a
 * `webhooks` stream event. The agent can't generate crypto-random
 * credentials, so an authored webhook trigger is staged `pending: true` and
 * minted here. Best-effort — a minting hiccup never fails the turn (handled
 * by the core's `onTurnComplete` try/catch).
 */
async function mintPendingWebhooks(
  cwd: string,
  publicBaseUrl: () => string,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const minted = await provisionAppPendingWebhooks(cwd);
  if (minted.length === 0) return;
  const base = publicBaseUrl();
  onEvent({
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

export function makeUnifiedChatRunner(opts: UnifiedChatRunnerOptions): ChatRunner {
  const sessionIdFor = opts.sessionIdFor ?? defaultSessionIdFor;
  const enumerate = opts.enumerateTools ?? enumerateHostTools;
  const extraPath = defaultCentraidCliDir();

  // Builder chat is the data-chat spine plus three seams: cwd = the app's
  // shared draft worktree, the unified authoring prompt (grounding owned by
  // `@centraid/skills`), and post-turn webhook minting.
  return makeChatRunnerCore({
    prefsLoader: opts.prefsLoader,
    getDispatcher: opts.getDispatcher,
    ...(extraPath ? { extraPath } : {}),

    // This IS the builder surface — its turns author code in the draft
    // worktree, so they persist as `kind: 'build'` in the run ledger. The
    // data-only `makeChatRunner` leaves this unset (records as `'chat'`).
    runKind: 'build',
    // The model turn driver — the local codex/claude `runAgentTurn` unless a
    // test injects a stub.
    runTurn: opts.runTurn ?? runAgentTurn,

    // cwd IS the draft session worktree, so the agent's centraid_* tools
    // operate the draft's branched data.sqlite, not live (issue #144).
    cwdIsDraftWorktree: true,

    // Open (or reuse) the app's shared draft worktree so native file edits
    // stage in the draft, and run the turn from its app dir. Seed the draft's
    // branched data.sqlite from live on first access (#144) so the agent's
    // data tools operate prod-shaped data.
    resolveCwd: async (input) => {
      const sessionId = sessionIdFor(input.appId);
      await ensureSession(opts.store, sessionId);
      const worktreeAppDir = await opts.store.snapshotSessionAppDir(sessionId, input.appId);
      if (opts.liveDataFile) {
        await seedDraftData({ liveDataFile: opts.liveDataFile(input.appId), worktreeAppDir });
      }
      return worktreeAppDir;
    },

    // Unified prompt: the route's data/schema preamble + the builder
    // authoring grounding for the app kind.
    buildExtraSystemPrompt: async ({ input, prefs, cwd }) =>
      buildAuthoringExtraPrompt({
        baseExtra: input.extraSystemPrompt,
        appKind: await readAppKind(cwd),
        prefs,
        cwd,
        enumerate,
      }),

    onTurnComplete: ({ input, cwd }) => mintPendingWebhooks(cwd, opts.publicBaseUrl, input.onEvent),
  });
}
