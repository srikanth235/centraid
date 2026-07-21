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
 *     shell tools (workspace-write against cwd) PLUS the vault register
 *     (`vault_sql` / `vault_invoke`) threaded via `toolContext`, so the
 *     same turn can author code and look at the real data it projects;
 *   - the unified system prompt: the data/schema preamble the chat route
 *     builds (`input.extraSystemPrompt`) followed by the builder authoring
 *     prompt + UI grounding (composed by `src/skills/`).
 *
 * Code edits STAGE in the draft worktree; ext-table schema changes are
 * DECLARED there (`app.json#ext.tables`) and mirrored into the vault's
 * draft band each turn, so preview data ops stay scratch (issue #286
 * phase 2). The user clicks Publish to flip the live version + apply the
 * declared DDL diff to the live band — explicit-publish holds. Webhook
 * secrets are minted as a post-turn step (the agent can't generate
 * crypto-random credentials) and surfaced once via a `webhooks` stream
 * event.
 *
 * Since issue #147 (Concern 1) this is a thin config over
 * `makeConversationRunnerCore` (`@centraid/app-engine`): the shared per-turn
 * spine lives there; this file supplies only the builder seams — draft-worktree cwd,
 * the authoring prompt (delegated to `src/skills/`), and post-turn
 * webhook minting.
 *
 * Replaces the data-only `makeConversationRunner` injection in `serve.ts` whenever a
 * git store is active (the local embedded gateway and the standalone daemon
 * both have one). Without a store there's no draft worktree to edit, so the
 * host falls back to the data-only `makeConversationRunner`.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { defaultCentraidCliDir, runTurn } from '@centraid/agent-runtime';
import {
  makeConversationRunnerCore,
  type ConversationRunner,
  type TurnStreamEvent,
  type Dispatcher,
  type ModelSubsystem,
  type RunnerPrefs,
  type RunTurnFn,
  type VaultInvokeRunner,
  type VaultContentRunner,
  type VaultSqlRunner,
} from '@centraid/app-engine';
import { provisionAppPendingWebhooks, WEBHOOK_ROUTE_PREFIX } from '@centraid/automation';
import { buildAuthoringExtraPrompt } from '../skills/index.js';
import { WorktreeStore } from '../worktree-store/index.js';
import { ensureSession } from '../lifecycle/lifecycle-shared.js';
import { ensureDraftBand, type ExtBandOps } from '../lifecycle/ext-band.js';

export type { RunTurnFn };

export interface UnifiedConversationRunnerOptions {
  /** Git store backing app code; the draft worktree lives in its sessions. */
  store: WorktreeStore;
  /** Per-turn runner prefs (kind + provider). Loaded fresh so settings
   *  changes apply without a restart — mirrors `makeConversationRunner`.
   *  Receives `subsystem` so a host that pins a runner per subsystem
   *  answers with THIS register's kind. */
  prefsLoader: (subsystem?: ModelSubsystem) => Promise<RunnerPrefs | undefined>;
  /** Which subsystem's runner/model prefs builder turns ride. The gateway
   *  passes `'builder'`; unset → the host's default agent. */
  subsystem?: ModelSubsystem;
  /** Resolve the shared app-engine dispatcher for the `centraid_*` tools.
   *  Called per turn so the host can cycle-break on first use. */
  getDispatcher: () => Dispatcher;
  /** Resolve the public base URL (`http://host:port`) used to build webhook
   *  URLs after minting. A thunk because the ephemeral port is only known
   *  after the server starts — and a turn only ever runs post-start. */
  publicBaseUrl: () => string;
  /** The vault plane's ext-band operations (issue #286 phase 2). When set,
   *  each turn keeps the app's DRAFT ext band in step with the draft
   *  manifest (first access seeds it from live rows) so the agent's
   *  preview operates on prod-shaped data without touching live. */
  ext?: ExtBandOps;
  /** The builder's vault read tool (issue #286 phase 2): the same
   *  owner-side `vault_sql` runner the assistant uses — looking at real
   *  data while building IS the owner asking their own vault. */
  vaultSql?: () => VaultSqlRunner;
  /** The builder's typed-write tool — rides the `_assistant` agent, so
   *  high-risk commands park exactly like assistant/ask turns. */
  vaultInvoke?: () => VaultInvokeRunner;
  /** Document-text access (issue #299) — same owner-side runner as the assistant. */
  vaultContent?: () => VaultContentRunner;
  /** Session id for an app's shared draft worktree. Defaults to a
   *  host-neutral `chat-<appId>` scheme. Hosts that share the draft with
   *  another editing surface inject their own scheme — the desktop passes
   *  `desktop-<appId>` so the renderer Code tab, the local builder, and
   *  gateway chat all edit ONE draft. Also overridable for tests. */
  sessionIdFor?: (appId: string) => string;
  /** Turn driver — defaults to `runTurn`; injected in tests. */
  runTurn?: RunTurnFn;
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
  onEvent: (event: TurnStreamEvent) => void,
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

export function makeUnifiedConversationRunner(
  opts: UnifiedConversationRunnerOptions,
): ConversationRunner {
  const sessionIdFor = opts.sessionIdFor ?? defaultSessionIdFor;
  const extraPath = defaultCentraidCliDir();

  // Builder chat is the data-chat spine plus three seams: cwd = the app's
  // shared draft worktree, the unified authoring prompt (grounding owned by
  // `src/skills/`), and post-turn webhook minting.
  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: opts.getDispatcher,
    ...(extraPath ? { extraPath } : {}),

    // This IS the builder surface — its turns author code in the draft
    // worktree, so they persist as `kind: 'build'` in the run ledger. The
    // data-only `makeConversationRunner` leaves this unset (records as `'chat'`).
    runKind: 'build',
    // The model turn driver — the local codex/claude `runTurn` unless a
    // test injects a stub.
    runTurn: opts.runTurn ?? runTurn,

    // cwd IS the draft session worktree (issue #144's draft-code framing
    // survives; the branched data.sqlite did not — #286 phase 2).
    cwdIsDraftWorktree: true,

    // The builder's data tools are the vault register — the same
    // vault_sql/vault_invoke surface the assistant and ask turns ride.
    ...(opts.vaultSql ? { vaultSql: opts.vaultSql } : {}),
    ...(opts.vaultInvoke ? { vaultInvoke: opts.vaultInvoke } : {}),
    ...(opts.vaultContent ? { vaultContent: opts.vaultContent } : {}),

    // Open (or reuse) the app's shared draft worktree so native file edits
    // stage in the draft, and run the turn from its app dir. Keep the
    // vault's DRAFT ext band in step with the draft manifest (first access
    // seeds from live rows) so preview writes stay scratch.
    resolveCwd: async (input) => {
      const sessionId = input.draftSessionId ?? sessionIdFor(input.appId);
      await ensureSession(opts.store, sessionId);
      const worktreeAppDir = await opts.store.snapshotSessionAppDir(sessionId, input.appId);
      if (opts.ext) await ensureDraftBand(opts.ext, input.appId, worktreeAppDir);
      return worktreeAppDir;
    },

    // Unified prompt: the route's data/schema preamble + the builder
    // authoring grounding for the app kind.
    buildExtraSystemPrompt: async ({ input, cwd }) =>
      buildAuthoringExtraPrompt({
        baseExtra: input.extraSystemPrompt,
        appKind: await readAppKind(cwd),
      }),

    onTurnComplete: ({ input, cwd }) => mintPendingWebhooks(cwd, opts.publicBaseUrl, input.onEvent),
  });
}
