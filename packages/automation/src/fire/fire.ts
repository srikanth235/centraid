// governance: allow-repo-hygiene file-size-limit the fire spine is one per-fire orchestration — liveness, secret preflight (#293), broker preflight (#304) and the onFailure cascade share the run bracket
/**
 * Automation fire spine — the per-fire orchestration, owned here in
 * app-engine (issue #147, Concern 2).
 *
 * Resolving an automation, opening its run ledger, running the generated
 * `handler.js`, and cascading `onFailure` only ever touch app-engine
 * primitives (`parseRef`, `AgentRunsStore`,
 * `runHandler`). That spine used to live in
 * `agent-runtime/run-automation.ts`; the only thing it genuinely needed from
 * agent-runtime was the `ctx.agent` dispatch surface (a bounded model turn
 * through the runner registry). So the spine moves down and the dispatch
 * surface is injected via `openDispatch` — the same dependency inversion the
 * `Host` / `ConversationRunner` seams already use.
 *
 * agent-runtime's `runAutomation` is now a thin wrapper that builds the
 * `openDispatch` closure (capturing the runner kind) and calls `runFire`. A
 * future host can inject its own dispatch surface instead of reimplementing
 * the spine. A fire whose handler never calls `ctx.agent` starts zero child
 * processes and zero HTTP servers.
 */

import { randomUUID } from 'node:crypto';
import {
  ConversationStore,
  makeJournalDbProvider,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type RunStreamEvent,
  type VaultBridge,
} from '@centraid/app-engine';
import { parseRef } from '../manifest/ref.js';
import { handlerPath, readAppOwned } from '../scaffold/app.js';
import { runHandler } from '../handler/runner.js';
import type { AgentDispatcher, ConnectionAuth, HandlerOutcome } from '../handler/runner.js';

/**
 * The gateway broker's per-fire seam (issue #304). Resolves the connector's
 * connection to an injectable credential: `undefined` = harness-ambient lane
 * (no broker credential configured), `ConnectionAuth` = inject away, and
 * `{ refused }` = the credential exists but cannot serve this fire (dead
 * refresh token, mid-ceremony) — the run skips, the broker has already
 * flipped the connection's health state.
 */
export type ResolveConnection = (connector: {
  kind: string;
  label: string;
  /** Preferred when set — durable vault connection id. */
  connectionId?: string;
}) => Promise<ConnectionAuth | { refused: string } | undefined>;

/**
 * The live dispatch surface a fire runs against. Provided by the host
 * (agent-runtime stands up a mock-LLM server + CLI spawn). `close()` tears
 * down whatever the host allocated and is always called once, even on throw.
 */
export interface DispatchSurface {
  agentDispatcher: AgentDispatcher;
  close(): Promise<void>;
}

/** Args app-engine hands the host when it needs a dispatch surface for a fire. */
export interface OpenDispatchArgs {
  /** The automation app directory — the host's agent cwd. */
  workdir: string;
  /** `<appId>/<automationId>` handle being fired. */
  automationRef: string;
  runId: string;
  /**
   * Manifest `requires.model` — the capability tier `ctx.agent` should route
   * to (issue #166). The host's `agentDispatcher` picks the matching provider
   * tier; undefined means "the host's default automation model".
   */
  model?: string;
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** The injected seam: open a live dispatch surface for one fire. */
export type OpenDispatch = (args: OpenDispatchArgs) => Promise<DispatchSurface>;

export interface RunFireOptions {
  /** `<appId>/<automationId>` handle of the automation to fire. */
  automationRef: string;
  /**
   * Caller-supplied run id. Lets the caller open the run viewer before the
   * fire completes. Defaults to `<ref>:<ts>:<uuid8>`.
   */
  runId?: string;
  /**
   * Directory holding the per-app *state* folders (logs, settings.json).
   * Survives version swaps (it is never inside a git worktree). Per-vault
   * since #280.
   */
  appsDir: string;
  /**
   * The vault's `journal.db` file — the run ledger every fire writes
   * (issue #280: one per-vault ledger; the per-app `runtime.sqlite` is gone).
   */
  journalDbFile: string;
  /**
   * Directory holding the per-app *code* folders — automation manifests +
   * handlers resolve from `<codeAppsDir>/<appId>/automations/<id>/` (issue
   * #137: the gateway's git-store materialized `main`). Defaults to `appsDir`
   * when omitted, for the legacy/flat layout where code and data share a tree.
   */
  codeAppsDir?: string;
  /**
   * Host-injected `ctx.vault` executor factory, keyed by the automation's
   * app id: each fire gets a bridge bound to *that* app's enrolled
   * `agent.agent` credential (duaility §12), so a cross-app `onFailure`
   * cascade acts as its own agent, never the parent's. The package stays
   * vault-free — the gateway builds this off its vault plane. Absent (or
   * returning undefined) → `ctx.vault` fails closed with `VAULT_UNAVAILABLE`.
   */
  vaultFor?: (appId: string) => VaultBridge | undefined;
  /** Hard timeout. Defaults to the handler runner's default. */
  timeoutMs?: number;
  /** Optional logger. */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Live run-stream sink (issue #158) for THIS fire's run. Not propagated
   * into `onFailure` cascades — those are separate runs with their own ids
   * and ledgers, so streaming them onto this run's channel would mislabel
   * their events. A late viewer can open the child run by its own id.
   */
  onRunEvent?: (ev: RunStreamEvent) => void;
  /**
   * Trigger that caused this fire. Defaults to `'scheduled'`. The onFailure
   * dispatch loop uses `'on_failure'`.
   */
  triggerKind?: AutomationTriggerKind;
  /**
   * Source that fired this run (`cron` / `webhook` / `manual`). Defaults to
   * `'cron'` — the scheduler is the usual local caller.
   */
  triggerOrigin?: AutomationTriggerOrigin;
  /** Optional input payload (e.g. for on_failure dispatch). */
  input?: unknown;
  /** Optional parent run id for the onFailure sub-run DAG link. */
  parentRunId?: string;
  /**
   * Recursion guard for `onFailure` cascades. Defaults to 0 — the runtime
   * refuses to push the chain past depth 3.
   */
  failureDepth?: number;
  /**
   * Gateway broker seam (issue #304): resolve the connector's connection to
   * an injectable credential before the handler runs. Absent → every
   * connection is treated as harness-ambient (pre-#304 behavior).
   */
  resolveConnection?: ResolveConnection;
  /** Injected-fetch transient backoff schedule (ms) — tests shrink it. */
  fetchRetryDelaysMs?: readonly number[];
}

export interface RunRecord {
  /** `<appId>/<automationId>` handle of the fired automation. */
  automationRef: string;
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
 * Single automation fire. Resolves the automation, opens its ledger, runs the
 * handler against the host-supplied dispatch surface, cascades `onFailure`,
 * and returns the run record + handler outcome. A missing automation app
 * throws; a handler failure surfaces in `outcome.ok === false`.
 */
export async function runFire(
  opts: RunFireOptions,
  deps: { openDispatch: OpenDispatch },
): Promise<{ outcome: HandlerOutcome; record: RunRecord }> {
  const onLog = opts.onLog ?? (() => undefined);

  // Code (manifest + handler) resolves from `codeAppsDir`; data
  // (runtime.sqlite) from `appsDir`. They diverge under the git-store backend
  // (issue #137) and coincide in the flat/legacy layout.
  const codeAppsDir = opts.codeAppsDir ?? opts.appsDir;

  const parsed = parseRef(opts.automationRef);
  if (!parsed) {
    throw new Error(`automation "${opts.automationRef}": not a valid <appId>/<id> handle`);
  }
  const row = await readAppOwned(codeAppsDir, parsed.appId, parsed.automationId);
  if (!row) {
    throw new Error(`automation ${opts.automationRef}: not found under ${codeAppsDir}`);
  }

  // The automation's run ledger is its vault's `journal.db` (#280); the
  // `run_summary` view derives from it, so a finished run needs no write-through.
  const runsStore = new ConversationStore(makeJournalDbProvider(opts.journalDbFile));
  const runId = opts.runId ?? `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const failureDepth = opts.failureDepth ?? 0;
  const vaultBridge = opts.vaultFor?.(parsed.appId);

  const dispatch = await deps.openDispatch({
    workdir: row.dir,
    automationRef: opts.automationRef,
    runId,
    ...(row.manifest.requires.model ? { model: row.manifest.requires.model } : {}),
    onLog,
  });

  const skipRun = (error: string): { outcome: HandlerOutcome; record: RunRecord } => {
    const endedAt = Date.now();
    const outcomeSkipped: HandlerOutcome = {
      ok: false,
      error,
      logs: [],
      toolBatches: 0,
      agentCalls: 0,
    };
    return {
      outcome: outcomeSkipped,
      record: {
        automationRef: opts.automationRef,
        automationName: row.name,
        runId,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        ok: false,
        error,
        toolBatches: 0,
        agentCalls: 0,
      },
    };
  };

  // Honest liveness (issue #290 phase 4): a paused or needs-auth connection
  // never fires its connector — the skip is logged, and since connectors are
  // cursor-based, the next healthy run catches up over the accumulated gap
  // in one fire. Best-effort: an unreadable status (no grant yet) lets the
  // run proceed to sync.begin_run's hard gate rather than dying silently.
  if (row.manifest.connector && vaultBridge) {
    const status = await connectionStatus(vaultBridge, row.manifest.connector).catch(
      () => undefined,
    );
    if (status === 'paused' || status === 'needs-auth') {
      onLog(
        'warn',
        `connector ${opts.automationRef} skipped: connection "${row.manifest.connector.label}" is ${status}`,
      );
      await dispatch.close().catch(() => undefined);
      return skipRun(`connection is ${status}`);
    }
  }

  // Secrets preflight (issue #293 decision 8): every declared secret must
  // reveal BEFORE the handler runs — one reveal per ref, receipted by the
  // vault. A trashed/missing item flips the connection to needs-auth (the
  // same honest-liveness state a wrong login shows) and the run skips.
  const secretRefs = row.manifest.requires.secrets ?? [];
  const secretCache = new Map<string, string>();
  if (row.manifest.connector && secretRefs.length > 0) {
    if (!vaultBridge) {
      await dispatch.close().catch(() => undefined);
      return skipRun('connector declares requires.secrets but no vault bridge is mounted');
    }
    for (const ref of secretRefs) {
      const value = await revealSecret(vaultBridge, ref).catch((err: unknown) => {
        onLog(
          'warn',
          `connector ${opts.automationRef}: secret "${ref}" did not resolve — ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      });
      if (value === undefined) {
        await flipNeedsAuth(vaultBridge, row.manifest.connector).catch(() => undefined);
        await dispatch.close().catch(() => undefined);
        return skipRun(`secret "${ref}" is unavailable — connection flipped to needs-auth`);
      }
      secretCache.set(ref, value);
    }
  }

  // Broker credential preflight (issue #304): a connection carrying an
  // oauth2/api_key credential resolves it NOW — token refreshed under the
  // broker's per-connection mutex, values ready for transport injection. A
  // refusal skips the fire exactly like honest-liveness above (the broker
  // has already flipped the health state); a transient resolver failure
  // skips too, without flipping — the next fire retries.
  let connectionAuth: ConnectionAuth | undefined;
  if (row.manifest.connector && opts.resolveConnection) {
    let resolved: Awaited<ReturnType<ResolveConnection>>;
    try {
      resolved = await opts.resolveConnection({
        kind: row.manifest.connector.kind,
        label: row.manifest.connector.label,
        ...(row.manifest.connector.connectionId
          ? { connectionId: row.manifest.connector.connectionId }
          : {}),
      });
    } catch (err) {
      await dispatch.close().catch(() => undefined);
      return skipRun(
        `connection credential did not resolve: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (resolved && 'refused' in resolved) {
      onLog(
        'warn',
        `connector ${opts.automationRef} skipped: connection "${row.manifest.connector.label}" refused — ${resolved.refused}`,
      );
      await dispatch.close().catch(() => undefined);
      return skipRun(resolved.refused);
    }
    connectionAuth = resolved;
  }

  let outcome: HandlerOutcome;
  try {
    outcome = await runHandler({
      automationId: opts.automationRef,
      automationName: row.name,
      automationDir: row.dir,
      handlerFile: handlerPath(row.dir),
      runId,
      now: new Date(startedAt).toISOString(),
      agentDispatcher: dispatch.agentDispatcher,
      runsStore,
      ...(vaultBridge ? { vault: vaultBridge } : {}),
      ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}),
      triggerKind: opts.triggerKind ?? 'scheduled',
      triggerOrigin: opts.triggerOrigin ?? 'cron',
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(row.manifest.outputSchema ? { outputSchema: row.manifest.outputSchema } : {}),
      history: row.manifest.history,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(row.manifest.connector
        ? {
            connector: {
              kind: row.manifest.connector.kind,
              label: row.manifest.connector.label,
              ...(secretRefs.length > 0 ? { secrets: secretRefs } : {}),
              ...(row.manifest.connector.connectionId
                ? { connectionId: row.manifest.connector.connectionId }
                : {}),
            },
          }
        : {}),
      ...(secretCache.size > 0
        ? {
            resolveSecret: (ref: string): Promise<string> => {
              const value = secretCache.get(ref);
              return value === undefined
                ? Promise.reject(new Error(`secret "${ref}" was not preflighted`))
                : Promise.resolve(value);
            },
          }
        : {}),
      ...(connectionAuth ? { connectionAuth } : {}),
      ...(opts.fetchRetryDelaysMs ? { fetchRetryDelaysMs: opts.fetchRetryDelaysMs } : {}),
    });
  } finally {
    await dispatch.close().catch(() => undefined);
  }

  // onFailure cascade: when the handler fails and the manifest names a
  // follow-up automation, fire it with the failed run as input. The handle
  // resolves a bare id within the same app. Capped at depth 3.
  if (!outcome.ok && row.manifest.onFailure) {
    if (failureDepth >= 3) {
      onLog('warn', `onFailure cascade for ${row.name} aborted at depth ${failureDepth} (cap=3)`);
    } else {
      const failTarget = parseRef(row.manifest.onFailure, parsed.appId);
      const next = failTarget
        ? await readAppOwned(codeAppsDir, failTarget.appId, failTarget.automationId)
        : undefined;
      if (!next) {
        onLog('warn', `onFailure target "${row.manifest.onFailure}" not found for ${row.name}`);
      } else {
        try {
          await runFire(
            {
              automationRef: next.ref,
              appsDir: opts.appsDir,
              journalDbFile: opts.journalDbFile,
              ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
              ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
              ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
              onLog,
              triggerKind: 'on_failure',
              ...(opts.triggerOrigin ? { triggerOrigin: opts.triggerOrigin } : {}),
              input: { runId, automationName: row.name, error: outcome.error ?? 'unknown error' },
              parentRunId: runId,
              failureDepth: failureDepth + 1,
            },
            deps,
          );
        } catch (err) {
          onLog(
            'error',
            `onFailure dispatch ${row.manifest.onFailure} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const endedAt = Date.now();
  const record: RunRecord = {
    automationRef: opts.automationRef,
    automationName: row.name,
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

/**
 * Reveal one declared secret ref through the automation's consented bridge —
 * rides the agent's `reveal` grant, receipted per item (issue #293). Two
 * ref forms: `locker:<item_id>:<column>` (the raw UUID) and, for stable
 * bindings that survive delete+recreate, `locker:@<alias>:<column>` (issue
 * #298 item 4) — the vault resolves the alias to the live item under the
 * same grant.
 */
async function revealSecret(vault: VaultBridge, ref: string): Promise<string> {
  const [scheme, selector, column] = ref.split(':');
  if (scheme !== 'locker' || !selector || !column) {
    throw new Error(
      `malformed secret ref "${ref}" — expected locker:<item_id>:<column> or locker:@<alias>:<column>`,
    );
  }
  const target = selector.startsWith('@') ? { alias: selector.slice(1) } : { entityId: selector };
  const reply = await vault({
    op: 'reveal',
    payload: {
      entity: 'locker.item',
      ...target,
      columns: [column],
      purpose: 'dpv:ServiceProvision',
    },
  });
  if (!reply.ok) throw new Error(reply.error ?? 'reveal failed');
  const value = (reply.result as { values?: Record<string, string | null> })?.values?.[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`locker item ${selector} holds no ${column}`);
  }
  return value;
}

/** Flip the connector's connection to needs-auth (issue #293): a missing or
 *  trashed secret item is the same honest-liveness state a wrong login is. */
async function flipNeedsAuth(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string },
): Promise<void> {
  const connectionId = await connectionIdOf(vault, connector);
  if (!connectionId) return; // no connection yet — nothing to flip
  await vault({
    op: 'invoke',
    payload: {
      command: 'sync.set_connection_status',
      input: { connection_id: connectionId, status: 'needs-auth' },
      purpose: 'dpv:ServiceProvision',
    },
  });
}

async function connectionIdOf(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string },
): Promise<string | undefined> {
  if (connector.connectionId) return connector.connectionId;
  const reply = await vault({
    op: 'read',
    payload: {
      entity: 'sync.connection',
      where: [
        { column: 'kind', op: 'eq', value: connector.kind },
        { column: 'label', op: 'eq', value: connector.label },
      ],
      limit: 1,
      purpose: 'dpv:ServiceProvision',
    },
  });
  if (!reply.ok) return undefined;
  const rows = (reply.result as { rows?: { connection_id?: unknown }[] })?.rows ?? [];
  return typeof rows[0]?.connection_id === 'string' ? rows[0].connection_id : undefined;
}

/** Read one connection's status through the automation's consented bridge. */
async function connectionStatus(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string },
): Promise<string | undefined> {
  if (connector.connectionId) {
    const byId = await vault({
      op: 'read',
      payload: {
        entity: 'sync.connection',
        where: [{ column: 'connection_id', op: 'eq', value: connector.connectionId }],
        limit: 1,
        purpose: 'dpv:ServiceProvision',
      },
    });
    if (!byId.ok) return undefined;
    const rows = (byId.result as { rows?: { status?: unknown }[] })?.rows ?? [];
    return typeof rows[0]?.status === 'string' ? rows[0].status : undefined;
  }
  const reply = await vault({
    op: 'read',
    payload: {
      entity: 'sync.connection',
      where: [
        { column: 'kind', op: 'eq', value: connector.kind },
        { column: 'label', op: 'eq', value: connector.label },
      ],
      limit: 1,
      purpose: 'dpv:ServiceProvision',
    },
  });
  if (!reply.ok) return undefined;
  const rows = (reply.result as { rows?: { status?: unknown }[] })?.rows ?? [];
  return typeof rows[0]?.status === 'string' ? (rows[0].status as string) : undefined;
}
