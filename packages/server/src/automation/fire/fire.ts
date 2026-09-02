// governance: allow-repo-hygiene file-size-limit the fire spine is one per-fire orchestration — liveness, secret preflight (#293), broker preflight (#304) and the onFailure cascade share the run bracket
// Automation fire spine (#147). The one thing it needs from agent-runtime is
// the `ctx.delegate` dispatch surface, injected via `openDispatch`.

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  ConversationStore,
  makeLedgerDbProvider,
} from "@centraid/server/engine";
import type {
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  AutomationTurnStreamEvent,
  VaultBridge,
} from "@centraid/server/engine";
import type { EnrichEgressClass } from "@centraid/vault";
import { BUILT_IN_PROFILE } from "@centraid/vault";

import { runHandler } from "../handler/runner.js";
import type {
  DelegateDispatcher,
  ConnectionAuth,
  HandlerOutcome,
} from "../handler/runner.js";
import { parseRef } from "../manifest/ref.js";
import { handlerPath, readAppOwned } from "../scaffold/app.js";
import {
  automationScopeChain,
  decideEnrichmentGate,
  resolveEnrichmentPolicy,
  sealedModelTurnReason,
} from "./enrich-gate.js";
import type {
  EnrichDomain,
  EnrichEgressConsentLookup,
  EnrichTier,
  ResolveEnrichPolicy,
  ResolvedEngineBinding,
  ResolvedEnrichPolicy,
} from "./enrich-gate.js";

/** `undefined` = harness-ambient lane, `{ refused }` = the run skips with the
 *  health state already flipped (#304). */
export type ResolveConnection = (connector: {
  kind: string;
  label: string;
  connectionId?: string;
}) => Promise<ConnectionAuth | { refused: string } | undefined>;

export interface DispatchSurface {
  delegateDispatcher: DelegateDispatcher;
  finalizeTurn?: (
    store: ConversationStore,
    conversationId: string,
    turnId: string,
    ok: boolean
  ) => void;
  close: () => Promise<void>;
}

export interface OpenDispatchArgs {
  workdir: string;
  automationRef: string;
  runId: string;
  harnessKind?: string;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  onLog: (level: "info" | "warn" | "error", msg: string) => void;
}

export type OpenDispatch = (args: OpenDispatchArgs) => Promise<DispatchSurface>;

export interface NestedAutomationRuntime {
  harnessKind?: string;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
}

export interface RunFireOptions {
  automationRef: string;
  runId?: string;
  appsDir: string;
  ledgerDbFile: string;
  /** Per-app CODE folders (#137); defaults to `appsDir` in the flat layout. */
  codeAppsDir?: string;
  /** Bound to THAT app's enrolled agent credential, so a cross-app cascade acts
   *  as its own agent. Absent → `ctx.vault` fails closed. */
  vaultFor?: (
    appId: string,
    automationRef: string
  ) => VaultBridge | undefined | Promise<VaultBridge | undefined>;
  timeoutMs?: number;
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
  harnessKind?: string;
  model?: string;
  /** False for a failover rung: manifest provider pins belong to the primary
   *  harness and must not cross the fire boundary. */
  allowManifestProviderPins?: boolean;
  configPins?: Readonly<Record<string, string>>;
  resolveNestedRuntime?: (
    automationRef: string
  ) => Promise<NestedAutomationRuntime>;
  onRunEvent?: (ev: AutomationTurnStreamEvent) => void;
  triggerKind?: AutomationTriggerKind;
  triggerOrigin?: AutomationTriggerOrigin;
  note?: string;
  failoverNotice?: string;
  input?: unknown;
  parentRunId?: string;
  failureDepth?: number;
  /** Only while advancing a pre-consented harness ladder. */
  deferOnFailure?: boolean | ((outcome: HandlerOutcome) => boolean);
  resolveConnection?: ResolveConnection;
  /** The privacy seam, off the gateway's OWNER plane and never the fired
   *  automation's own bridge: a guard must not depend on the grants of the party
   *  it guards. Absent or throwing REFUSES every `manifest.enrich`. */
  resolveEnrichPolicy?: ResolveEnrichPolicy;
  fetchRetryDelaysMs?: readonly number[];
  /** The callback must ENQUEUE a fresh fire, never recurse on this stack, so
   *  each pass gets its own run id, policy check and batch bound. */
  rearm?: (input: {
    automationRef: string;
    completedRunId: string;
  }) => void | Promise<void>;
}

export interface RunRecord {
  automationRef: string;
  automationName: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  toolBatches: number;
  delegateCalls: number;
}

/** An absent block is read as the strict `automation-handler` floor, never "no
 *  sandbox" (#846). A sandboxed handler has no `process.env`, so the runtime-dir
 *  override must be planted here. */
function sandboxRequest(
  sandbox: { lane: "model-runtime" | "media-transcode" } | undefined,
  automationDir: string
): {
  sandboxLane?: "model-runtime" | "media-transcode";
  sandboxReadRoots?: string[];
  sandboxRuntimeDir?: string;
} {
  if (!sandbox) return {};
  const override = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR;
  const runtimeDir = override
    ? path.resolve(override)
    : path.join(path.resolve(automationDir, ".."), "runtime");
  return {
    sandboxLane: sandbox.lane,
    sandboxReadRoots: [
      path.resolve(automationDir, ".."),
      ...(override ? [path.resolve(override)] : []),
    ],
    sandboxRuntimeDir: runtimeDir,
  };
}

export async function runFire(
  opts: RunFireOptions,
  deps: { openDispatch: OpenDispatch }
): Promise<{ outcome: HandlerOutcome; record: RunRecord }> {
  const onLog = opts.onLog ?? (() => undefined);

  // Code from `codeAppsDir`, data from `appsDir`: they diverge under the
  // git-store backend (#137).
  const codeAppsDir = opts.codeAppsDir ?? opts.appsDir;

  const parsed = parseRef(opts.automationRef);
  if (!parsed) {
    throw new Error(
      `automation "${opts.automationRef}": not a valid <appId>/<id> handle`
    );
  }
  const row = await readAppOwned(
    codeAppsDir,
    parsed.appId,
    parsed.automationId
  );
  if (!row) {
    throw new Error(
      `automation ${opts.automationRef}: not found under ${codeAppsDir}`
    );
  }

  const runsStore = new ConversationStore(
    makeLedgerDbProvider(opts.ledgerDbFile)
  );
  const runId =
    opts.runId ??
    `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const failureDepth = opts.failureDepth ?? 0;
  const vaultBridge = await opts.vaultFor?.(parsed.appId, opts.automationRef);
  runsStore.ensureAutomationConversation(
    opts.automationRef,
    parsed.appId,
    row.name,
    opts.harnessKind
  );

  const skipRun = (
    error: string,
    /** Only for the enrichment-tier refusal — the one skip the host must
     *  surface. */
    enrichRefusal?: HandlerOutcome["enrichRefusal"]
  ): { outcome: HandlerOutcome; record: RunRecord } => {
    const endedAt = Date.now();
    const outcomeSkipped: HandlerOutcome = {
      ...(enrichRefusal ? { enrichRefusal } : {}),
      ok: false,
      skipped: true,
      error,
      logs: [],
      toolBatches: 0,
      delegateCalls: 0,
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
        delegateCalls: 0,
      },
    };
  };

  // ENRICHMENT TIER GATE — the privacy choke point. The ONE place the tier is
  // enforced, BEFORE `openDispatch`, so a refused run starts no harness process.
  // Fail-closed three ways: absent seam, throwing seam, unreadable tier.
  const enrich = row.manifest.enrich;
  /** Set under the `device` tier: the domain that seals `ctx.delegate`. */
  let sealedDomain: EnrichDomain | undefined;
  let selectedProfileId: string | undefined;
  let selectedEngine: ResolvedEngineBinding | undefined;
  if (enrich) {
    let tier: EnrichTier | undefined;
    let policy: ResolvedEnrichPolicy | undefined;
    let profileEgress: EnrichEgressClass | undefined;
    let egressConsent: EnrichEgressConsentLookup | undefined;
    let engineForProfile:
      | ((profileId: string) => ResolvedEngineBinding | undefined)
      | undefined;
    try {
      const answer = await opts.resolveEnrichPolicy?.({
        domain: enrich.domain,
        capability: enrich.capability,
        lane: enrich.lane,
        scopeChain: automationScopeChain(enrich.domain),
      });
      if (answer === undefined || typeof answer === "string") {
        tier = answer;
      } else {
        tier = answer.tier;
        policy = resolveEnrichmentPolicy(
          answer.rules ?? [],
          answer.tier,
          enrich.capability
        );
        if (policy) profileEgress = answer.egressForProfile?.(policy.profileId);
        egressConsent = answer.egressConsent;
        engineForProfile = answer.engineForProfile;
      }
    } catch (error) {
      onLog(
        "warn",
        `${opts.automationRef}: enrichment policy read failed — ${error instanceof Error ? error.message : String(error)}`
      );
      tier = undefined;
      policy = undefined;
      egressConsent = undefined;
      engineForProfile = undefined;
    }
    const decision = decideEnrichmentGate({
      automationRef: opts.automationRef,
      domain: enrich.domain,
      capability: enrich.capability,
      lane: enrich.lane,
      tier,
      ...(policy ? { policy, profileEgress } : {}),
      ...(egressConsent ? { egressConsent } : {}),
    });
    if (!decision.allowed) {
      onLog("warn", decision.reason);
      return skipRun(decision.reason, {
        capability: enrich.capability,
        domain: enrich.domain,
        ...(tier === undefined ? {} : { tier }),
      });
    }
    if (decision.sealModelTurns) sealedDomain = enrich.domain;
    // ONLY on the allowed path: the engine must never decide whether it runs.
    if (policy) {
      selectedProfileId = policy.profileId;
      selectedEngine = engineForProfile?.(policy.profileId);
    }
  }

  // WHICH ENGINE RUNS (#807), from policy rather than a manifest pin:
  // `delegateStep` DECLARES a variant exists, the resolved profile is the
  // CHOICE. A handler with no delegate variant is INERT under a delegate
  // profile, and selection is policy state, never a fire option.
  const declaredDelegateStep = row.manifest.enrich?.delegateStep;
  const profileDelegate =
    selectedEngine?.kind === "delegate" ? selectedEngine : undefined;
  if (profileDelegate && !declaredDelegateStep) {
    onLog(
      "info",
      `${opts.automationRef}: engine profile "${selectedProfileId}" selects a delegate engine, but this enricher ` +
        `declares no delegate variant — the built-in engine ran.`
    );
  }
  const selectedVariant = declaredDelegateStep
    ? profileDelegate !== undefined ||
      declaredDelegateStep.selected === "delegate"
      ? "delegate"
      : "deterministic"
    : undefined;
  const delegateModel = profileDelegate
    ? (profileDelegate.model ?? row.manifest.requires.model)
    : row.manifest.requires.model;
  if (selectedVariant === "delegate" && !delegateModel) {
    return skipRun(
      `${opts.automationRef}: delegate step requires an explicit pinned model and provider-egress consent`
    );
  }
  const handlerInput = declaredDelegateStep
    ? {
        ...(opts.input !== null &&
        typeof opts.input === "object" &&
        !Array.isArray(opts.input)
          ? (opts.input as Record<string, unknown>)
          : {}),
        variant: selectedVariant,
        profileId: selectedProfileId ?? BUILT_IN_PROFILE,
        ...(selectedVariant === "delegate" && delegateModel
          ? { delegateModel }
          : {}),
        ...(selectedVariant === "delegate" && profileDelegate?.harness
          ? { delegateHarness: profileDelegate.harness }
          : {}),
        ...(selectedVariant === "delegate" && profileDelegate?.configPins
          ? { delegateConfigPins: profileDelegate.configPins }
          : {}),
        ...(selectedVariant === "delegate" && profileDelegate?.promptRev
          ? { promptRev: profileDelegate.promptRev }
          : {}),
      }
    : opts.input;

  // A profile's model is the MEMBER's configuration, so it outranks a manifest
  // pin. The harness rung is NOT switched here (TODO #807).
  const boundDelegate =
    selectedVariant === "delegate" ? profileDelegate : undefined;
  const effectiveModel =
    boundDelegate?.model ??
    (opts.allowManifestProviderPins === false
      ? opts.model
      : (row.manifest.requires.model ?? opts.model));
  const effectiveConfigPins = boundDelegate?.configPins ?? opts.configPins;
  const dispatch = await deps.openDispatch({
    workdir: row.dir,
    automationRef: opts.automationRef,
    runId,
    ...(opts.harnessKind ? { harnessKind: opts.harnessKind } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effectiveConfigPins ? { configPins: effectiveConfigPins } : {}),
    onLog,
  });

  // The `device` tier's backstop: sealed shut, never left to good manners.
  const sealed = sealedDomain;
  const delegateDispatcher: DelegateDispatcher = sealed
    ? () => {
        const reason = sealedModelTurnReason(opts.automationRef, sealed);
        onLog("warn", reason);
        return Promise.reject(new Error(reason));
      }
    : dispatch.delegateDispatcher;

  // Honest liveness (#290): a paused connection never fires and catches up on
  // the next healthy run. An unreadable status defers to sync.begin_run.
  if (row.manifest.connector && vaultBridge) {
    const status = await connectionStatus(
      vaultBridge,
      row.manifest.connector
    ).catch(() => undefined);
    if (status === "paused" || status === "needs-auth") {
      onLog(
        "warn",
        `connector ${opts.automationRef} skipped: connection "${row.manifest.connector.label}" is ${status}`
      );
      await dispatch.close().catch(() => undefined);
      return skipRun(`connection is ${status}`);
    }
  }

  // Every declared secret reveals BEFORE the handler runs (#293).
  const secretRefs = row.manifest.requires.secrets ?? [];
  const secretCache = new Map<string, string>();
  if (row.manifest.connector && secretRefs.length > 0) {
    if (!vaultBridge) {
      await dispatch.close().catch(() => undefined);
      return skipRun(
        "connector declares requires.secrets but no vault bridge is mounted"
      );
    }
    const revealNext = async (index: number): Promise<string | undefined> => {
      const ref = secretRefs[index];
      if (ref === undefined) return;
      const value = await revealSecret(vaultBridge, ref).catch(
        (error: unknown) => {
          onLog(
            "warn",
            `connector ${opts.automationRef}: secret "${ref}" did not resolve — ${error instanceof Error ? error.message : String(error)}`
          );
          return undefined;
        }
      );
      if (value === undefined) return ref;
      secretCache.set(ref, value);
      return revealNext(index + 1);
    };
    const unavailableRef = await revealNext(0);
    if (unavailableRef !== undefined) {
      await flipNeedsAuth(vaultBridge, row.manifest.connector).catch(
        () => undefined
      );
      await dispatch.close().catch(() => undefined);
      return skipRun(
        `secret "${unavailableRef}" is unavailable — connection flipped to needs-auth`
      );
    }
  }

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
    } catch (error) {
      await dispatch.close().catch(() => undefined);
      return skipRun(
        `connection credential did not resolve: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (resolved && "refused" in resolved) {
      onLog(
        "warn",
        `connector ${opts.automationRef} skipped: connection "${row.manifest.connector.label}" refused — ${resolved.refused}`
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
      ...sandboxRequest(row.manifest.sandbox, row.dir),
      runId,
      now: new Date(startedAt).toISOString(),
      delegateDispatcher,
      runsStore,
      ...(dispatch.finalizeTurn ? { finalizeTurn: dispatch.finalizeTurn } : {}),
      ...(opts.harnessKind ? { harnessKind: opts.harnessKind } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(vaultBridge ? { vault: vaultBridge } : {}),
      ...(opts.onRunEvent ? { onRunEvent: opts.onRunEvent } : {}),
      triggerKind: opts.triggerKind ?? "scheduled",
      triggerOrigin: opts.triggerOrigin ?? "cron",
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.failoverNotice ? { failoverNotice: opts.failoverNotice } : {}),
      ...(handlerInput === undefined ? {} : { input: handlerInput }),
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(row.manifest.outputSchema
        ? { outputSchema: row.manifest.outputSchema }
        : {}),
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
                ? Promise.reject(
                    new Error(`secret "${ref}" was not preflighted`)
                  )
                : Promise.resolve(value);
            },
          }
        : {}),
      ...(connectionAuth ? { connectionAuth } : {}),
      ...(opts.fetchRetryDelaysMs
        ? { fetchRetryDelaysMs: opts.fetchRetryDelaysMs }
        : {}),
    });
  } finally {
    await dispatch.close().catch(() => undefined);
  }

  const deferOnFailure =
    typeof opts.deferOnFailure === "function"
      ? opts.deferOnFailure(outcome)
      : (opts.deferOnFailure ?? false);
  if (!outcome.ok && row.manifest.onFailure && !deferOnFailure) {
    if (failureDepth >= 3) {
      onLog(
        "warn",
        `onFailure cascade for ${row.name} aborted at depth ${failureDepth} (cap=3)`
      );
    } else {
      const failTarget = parseRef(row.manifest.onFailure, parsed.appId);
      const next = failTarget
        ? await readAppOwned(
            codeAppsDir,
            failTarget.appId,
            failTarget.automationId
          )
        : undefined;
      if (next) {
        try {
          const nestedRuntime = await opts.resolveNestedRuntime?.(next.ref);
          await runFire(
            {
              automationRef: next.ref,
              appsDir: opts.appsDir,
              ledgerDbFile: opts.ledgerDbFile,
              ...(opts.codeAppsDir ? { codeAppsDir: opts.codeAppsDir } : {}),
              ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
              ...((nestedRuntime?.harnessKind ?? opts.harnessKind)
                ? {
                    harnessKind: nestedRuntime?.harnessKind ?? opts.harnessKind,
                  }
                : {}),
              ...((nestedRuntime?.model ?? opts.model)
                ? { model: nestedRuntime?.model ?? opts.model }
                : {}),
              ...((nestedRuntime?.configPins ?? opts.configPins)
                ? { configPins: nestedRuntime?.configPins ?? opts.configPins }
                : {}),
              ...(opts.resolveEnrichPolicy
                ? { resolveEnrichPolicy: opts.resolveEnrichPolicy }
                : {}),
              ...(opts.resolveNestedRuntime
                ? { resolveNestedRuntime: opts.resolveNestedRuntime }
                : {}),
              ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
              onLog,
              triggerKind: "on_failure",
              ...(opts.triggerOrigin
                ? { triggerOrigin: opts.triggerOrigin }
                : {}),
              input: {
                runId,
                automationName: row.name,
                error: outcome.error ?? "unknown error",
              },
              parentRunId: runId,
              failureDepth: failureDepth + 1,
            },
            deps
          );
        } catch (error) {
          onLog(
            "error",
            `onFailure dispatch ${row.manifest.onFailure} threw: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        onLog(
          "warn",
          `onFailure target "${row.manifest.onFailure}" not found for ${row.name}`
        );
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
    delegateCalls: outcome.delegateCalls,
  };
  const output =
    outcome.output !== null &&
    typeof outcome.output === "object" &&
    !Array.isArray(outcome.output)
      ? (outcome.output as Record<string, unknown>)
      : undefined;
  if (outcome.ok && output?.rearm === true && opts.rearm) {
    try {
      await opts.rearm({
        automationRef: opts.automationRef,
        completedRunId: runId,
      });
    } catch (error) {
      onLog(
        "error",
        `${opts.automationRef}: could not re-arm bounded backlog after ${runId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { outcome, record };
}

/** Two ref forms: `locker:<item_id>:<column>`, and `locker:@<alias>:<column>`
 *  for bindings that survive delete+recreate (#293). */
async function revealSecret(vault: VaultBridge, ref: string): Promise<string> {
  const [scheme, selector, column] = ref.split(":");
  if (scheme !== "locker" || !selector || !column) {
    throw new Error(
      `malformed secret ref "${ref}" — expected locker:<item_id>:<column> or locker:@<alias>:<column>`
    );
  }
  const target = selector.startsWith("@")
    ? { alias: selector.slice(1) }
    : { entityId: selector };
  const reply = await vault({
    op: "reveal",
    payload: {
      entity: "locker.item",
      ...target,
      columns: [column],
      purpose: "dpv:ServiceProvision",
    },
  });
  if (!reply.ok) throw new Error(reply.error ?? "reveal failed");
  const value = (reply.result as { values?: Record<string, string | null> })
    ?.values?.[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`locker item ${selector} holds no ${column}`);
  }
  return value;
}

/** A missing secret item is the same honest-liveness state a wrong login is. */
async function flipNeedsAuth(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string }
): Promise<void> {
  const connectionId = await connectionIdOf(vault, connector);
  if (!connectionId) return;
  await vault({
    op: "invoke",
    payload: {
      command: "sync.set_connection_status",
      input: { connection_id: connectionId, status: "needs-auth" },
      purpose: "dpv:ServiceProvision",
    },
  });
}

async function connectionIdOf(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string }
): Promise<string | undefined> {
  if (connector.connectionId) return connector.connectionId;
  const reply = await vault({
    op: "read",
    payload: {
      entity: "sync.connection",
      where: [
        { column: "kind", op: "eq", value: connector.kind },
        { column: "label", op: "eq", value: connector.label },
      ],
      limit: 1,
      purpose: "dpv:ServiceProvision",
    },
  });
  if (!reply.ok) return undefined;
  const rows =
    (reply.result as { rows?: { connection_id?: unknown }[] })?.rows ?? [];
  return typeof rows[0]?.connection_id === "string"
    ? rows[0].connection_id
    : undefined;
}

async function connectionStatus(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string }
): Promise<string | undefined> {
  if (connector.connectionId) {
    const byId = await vault({
      op: "read",
      payload: {
        entity: "sync.connection",
        where: [
          { column: "connection_id", op: "eq", value: connector.connectionId },
        ],
        limit: 1,
        purpose: "dpv:ServiceProvision",
      },
    });
    if (!byId.ok) return undefined;
    const rows = (byId.result as { rows?: { status?: unknown }[] })?.rows ?? [];
    return typeof rows[0]?.status === "string" ? rows[0].status : undefined;
  }
  const reply = await vault({
    op: "read",
    payload: {
      entity: "sync.connection",
      where: [
        { column: "kind", op: "eq", value: connector.kind },
        { column: "label", op: "eq", value: connector.label },
      ],
      limit: 1,
      purpose: "dpv:ServiceProvision",
    },
  });
  if (!reply.ok) return undefined;
  const rows = (reply.result as { rows?: { status?: unknown }[] })?.rows ?? [];
  return typeof rows[0]?.status === "string"
    ? (rows[0].status as string)
    : undefined;
}
