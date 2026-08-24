// governance: allow-repo-hygiene file-size-limit the fire spine is one per-fire orchestration — liveness, secret preflight (#293), broker preflight (#304) and the onFailure cascade share the run bracket
/**
 * Automation fire spine — the per-fire orchestration, owned here in
 * app-engine (#147, Concern 2).
 *
 * Resolving an automation, opening its run ledger, running the generated
 * `handler.js`, and cascading `onFailure` only ever touch app-engine
 * primitives (`parseRef`, `AutomationRunsStore`,
 * `runHandler`). The only thing the spine needs from agent-runtime is the
 * `ctx.delegate` dispatch surface (a bounded model turn through the harness
 * registry), and that is injected via `openDispatch` — the same dependency
 * inversion the `Host` / `ConversationRunner` seams already use.
 *
 * agent-runtime's `runAutomation` is a thin wrapper that builds the
 * `openDispatch` closure (capturing the harness kind) and calls `runFire`. A
 * future host can inject its own dispatch surface instead of reimplementing
 * the spine. A fire whose handler never calls `ctx.delegate` starts zero child
 * processes and zero HTTP servers.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  ConversationStore,
  makeJournalDbProvider,
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

/**
 * The gateway broker's per-fire seam (#304). Resolves the connector's
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
 * The live dispatch surface a fire runs against. Provided by the host.
 * `close()` tears down whatever the host allocated and is always called once,
 * even on throw.
 */
export interface DispatchSurface {
  delegateDispatcher: DelegateDispatcher;
  /**
   * Optional host-owned binding/watermark finalizer. `runHandler` invokes it
   * inside the same SQLite transaction that settles the turn.
   */
  finalizeTurn?: (
    store: ConversationStore,
    conversationId: string,
    turnId: string,
    ok: boolean
  ) => void;
  close: () => Promise<void>;
}

/** Args app-engine hands the host when it needs a dispatch surface for a fire. */
export interface OpenDispatchArgs {
  /** The automation app directory — the host's harness cwd. */
  workdir: string;
  /** `<appId>/<automationId>` handle being fired. */
  automationRef: string;
  runId: string;
  /** Harness fixed to this automation conversation. */
  harnessKind?: string;
  /**
   * Manifest `requires.model` — the capability tier `ctx.delegate` should route
   * to (#166). The host's `delegateDispatcher` picks the matching provider
   * tier; undefined means "the host's default automation model".
   */
  model?: string;
  /** Semantic ACP configuration pins, keyed by capability category. */
  configPins?: Readonly<Record<string, string>>;
  onLog: (level: "info" | "warn" | "error", msg: string) => void;
}

/** The injected seam: open a live dispatch surface for one fire. */
export type OpenDispatch = (args: OpenDispatchArgs) => Promise<DispatchSurface>;

export interface NestedAutomationRuntime {
  harnessKind?: string;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
}

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
   * (#280: one per-vault ledger; the per-app `runtime.sqlite` is gone).
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
   * `consent.agent` credential (duaility §12), so a cross-app `onFailure`
   * cascade acts as its own agent, never the parent's. The package stays
   * vault-free — the gateway builds this off its vault plane. Absent (or
   * returning undefined) → `ctx.vault` fails closed with `VAULT_UNAVAILABLE`.
   */
  vaultFor?: (
    appId: string,
    automationRef: string
  ) => VaultBridge | undefined | Promise<VaultBridge | undefined>;
  /** Hard timeout. Defaults to the handler runner's default. */
  timeoutMs?: number;
  /** Optional logger. */
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Harness that owns the durable automation conversation. */
  harnessKind?: string;
  /** Host-resolved model fallback used for dispatch and honest cost estimation. */
  model?: string;
  /**
   * False for a failover rung: provider-specific manifest pins belong only
   * to the primary harness and must not cross the fire boundary.
   */
  allowManifestProviderPins?: boolean;
  /** Host-resolved semantic ACP configuration pins. */
  configPins?: Readonly<Record<string, string>>;
  /** Resolve an onFailure target's own harness/model instead of inheriting its parent. */
  resolveNestedRuntime?: (
    automationRef: string
  ) => Promise<NestedAutomationRuntime>;
  /**
   * Live run-stream sink (#158) for THIS fire's run. Not propagated
   * into `onFailure` cascades — those are separate runs with their own ids
   * and ledgers, so streaming them onto this run's channel would mislabel
   * their events. A late viewer can open the child run by its own id.
   */
  onRunEvent?: (ev: AutomationTurnStreamEvent) => void;
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
  /** Human-readable trigger-gap/cursor note stored on the turn. */
  note?: string;
  /** Durable reader-facing boundary notice when this is a failover attempt. */
  failoverNotice?: string;
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
   * Suppress this attempt's onFailure cascade. The harness runtime router uses
   * this only while advancing a pre-consented harness ladder at the next fire
   * boundary; the final attempt still owns the ordinary onFailure cascade.
   */
  deferOnFailure?: boolean | ((outcome: HandlerOutcome) => boolean);
  /**
   * Gateway broker seam (#304): resolve the connector's connection to
   * an injectable credential before the handler runs. Absent → every
   * connection is treated as harness-ambient (pre-#304 behavior).
   */
  resolveConnection?: ResolveConnection;
  /**
   * Enrichment-policy seam (privacy enforcement): resolve what this vault
   * allows for the capability about to run. The gateway supplies this off its
   * OWNER plane (`plane.db.vault`), never through the fired automation's own
   * consent-checked bridge — a guard must not depend on the grants of the
   * party it guards.
   *
   * Answer with a bare tier (the pre-#807 contract, unchanged) or with the
   * cascade material — tier, the scope chain's rules, and a profile→egress
   * lookup — which `decideEnrichmentGate` folds through its resolver.
   *
   * Absent, or throwing, or resolving `undefined` → every automation
   * declaring `manifest.enrich` is REFUSED. Fail-closed is the whole point:
   * a host that has not wired the policy in cannot be allowed to run
   * enrichment as though the owner had consented to it.
   */
  resolveEnrichPolicy?: ResolveEnrichPolicy;
  /** Injected-fetch transient backoff schedule (ms) — tests shrink it. */
  fetchRetryDelaysMs?: readonly number[];
  /**
   * Host-owned next-tick queue for bounded handlers that report remaining
   * backlog. The callback must enqueue a fresh ordinary fire; it must not
   * recurse on this stack. Each pass therefore gets its own run id, policy
   * check, ledger turn, and batch bound.
   */
  rearm?: (input: {
    automationRef: string;
    completedRunId: string;
  }) => void | Promise<void>;
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
  delegateCalls: number;
}

/**
 * Manifest lane → the worker's sandbox request (#846).
 *
 * An absent block is an absent request, which the worker reads as the strict
 * `automation-handler` floor — never as "no sandbox".
 *
 * `sandboxRuntimeDir` is the load-bearing half. A sandboxed handler has no
 * `process.env` (every lane replaces it with a frozen empty object), so the
 * `CENTRAID_AUTOMATION_RUNTIME_DIR` override the docs describe would be
 * silently dead inside one — and the five recognition bundles would fall back
 * to a `runtime/` directory that only exists in the source tree. The parent
 * resolves it here and the worker plants it before the handler's graph loads.
 */
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
  // What the bundled handler resolves for itself when nothing is planted:
  // `<handler dir>/../runtime`. Reproduced rather than imported so
  // `packages/server` gains no dependency on the recognition package.
  const runtimeDir = override
    ? path.resolve(override)
    : path.join(path.resolve(automationDir, ".."), "runtime");
  return {
    sandboxLane: sandbox.lane,
    sandboxReadRoots: [
      // The app's `automations/` directory: the handler's own bundle and its
      // sibling `runtime/`. Wider than the single automation's folder because
      // the weights are a per-app asset shared by every recognition handler
      // in it, and narrower than anything above it.
      path.resolve(automationDir, ".."),
      // An override points outside that tree, so it is its own root.
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

  // Code (manifest + handler) resolves from `codeAppsDir`; data
  // (runtime.sqlite) from `appsDir`. They diverge under the git-store backend
  // (#137) and coincide in the flat/legacy layout.
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

  // The automation's run ledger is its vault's `journal.db` (#280); the
  // `run_summary` view derives from it, so a finished run needs no write-through.
  const runsStore = new ConversationStore(
    makeJournalDbProvider(opts.journalDbFile)
  );
  const runId =
    opts.runId ??
    `${opts.automationRef}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const failureDepth = opts.failureDepth ?? 0;
  const vaultBridge = await opts.vaultFor?.(parsed.appId, opts.automationRef);
  // Establish the final phase-3 identity before the host acquires the durable
  // turn lock: one automation conversation, regardless of harness rung.
  runsStore.ensureAutomationConversation(
    opts.automationRef,
    parsed.appId,
    row.name,
    opts.harnessKind
  );

  const skipRun = (
    error: string,
    /**
     * Present only for the enrichment-tier refusal — the one skip class the
     * host must surface to the member, because the state that blocked it is
     * a setting they may not know exists. See `HandlerOutcome.enrichRefusal`.
     */
    enrichRefusal?: HandlerOutcome["enrichRefusal"]
  ): { outcome: HandlerOutcome; record: RunRecord } => {
    const endedAt = Date.now();
    const outcomeSkipped: HandlerOutcome = {
      ...(enrichRefusal ? { enrichRefusal } : {}),
      ok: false,
      // A skip is distinguishable from a run that failed: the handler never
      // executed, and the state that blocked it is already the owner's to
      // see (paused/needs-auth connection, missing secret, enrichment tier).
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

  // ENRICHMENT TIER GATE — the privacy choke point.
  //
  // An automation that declares `manifest.enrich` is subject to the owner's
  // per-domain tier in `enrich_policy`. This is the ONE place the tier is
  // enforced, and it sits before `openDispatch` so a refused run starts no
  // harness process and reaches no provider. The refusal is a stated, logged
  // skip carrying its reason into the run ledger — never a silent drop,
  // because a member turned this off and is owed the receipt.
  //
  // Fail-closed in three ways: an absent seam refuses, a throwing seam
  // refuses, and an unreadable/unknown tier refuses. See `enrich-gate.ts`
  // for what `device` means in this runtime and why.
  const enrich = row.manifest.enrich;
  /** Set under the `device` tier: the domain whose promise seals `ctx.delegate`. */
  let sealedDomain: EnrichDomain | undefined;
  /** The profile the cascade selected for this capability, once allowed. */
  let selectedProfileId: string | undefined;
  /** How that profile computes the capability — read only AFTER the gate. */
  let selectedEngine: ResolvedEngineBinding | undefined;
  if (enrich) {
    let tier: EnrichTier | undefined;
    let policy: ResolvedEnrichPolicy | undefined;
    let profileEgress: EnrichEgressClass | undefined;
    /** The vault's standing egress answer, when the host wired the lookup. */
    let egressConsent: EnrichEgressConsentLookup | undefined;
    /** The engine registry's answer for the selected profile (Wave 5). */
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
        // The egress-consent lookup rides the SAME host answer as the tier and
        // the rules (#807), so one seam still answers the whole
        // gate. A throwing lookup lands in the catch below with everything
        // else and refuses; an absent one fails closed inside the gate.
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
    // Read the engine ONLY on the allowed path: which engine computes a
    // capability must never be an input to whether it may run.
    if (policy) {
      selectedProfileId = policy.profileId;
      selectedEngine = engineForProfile?.(policy.profileId);
    }
  }

  // RECOGNITION SELECTION (#807) — WHICH ENGINE RUNS, resolved
  // from policy rather than pinned in the manifest.
  //
  // `manifest.enrich.delegateStep` is the capability's DECLARATION that a
  // delegate variant exists at all: the prompt revision the handler ships, the
  // honest latency, and the consequence of switching. It is not the choice.
  // The choice is the engine profile the cascade resolved
  // (`enrich-resolve.ts`) — so a member who binds `ocr` to a harness profile
  // gets the delegate variant everywhere that capability runs, instead of
  // hand-editing one recipe's manifest.
  //
  // Three laws hold across the move:
  //   1. A capability whose handler declares NO delegate variant is INERT
  //      under a delegate profile — the deterministic engine runs and the
  //      selection is logged, because a profile cannot conjure a code path the
  //      handler does not have. (The gate has already applied the profile's
  //      egress class, so this run is still bounded by consent.)
  //   2. The manifest's own `selected: "delegate"` stays honoured — that is
  //      the pre-Wave-5 per-recipe switch (`lifecycle-automation-routes.ts`),
  //      and a member's built-in profile must not silently revoke it.
  //   3. A delegate variant with no pinned model is refused, exactly as before:
  //      profile model first (the member's own binding), manifest pin second.
  // Selection is recipe/policy state, never a one-off fire option, so it is
  // injected into every invocation and a caller cannot smuggle the billed lane
  // through an arbitrary payload.
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
        // Which profile produced the values this run writes — the handler
        // stamps it on `enrich_derivation`, so two profiles' answers for the
        // same target stay separate rows rather than overwriting each other.
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
        // A profile MAY pin a prompt revision. The handler owns the prompt
        // text, so it refuses a pin it does not ship rather than stamping a
        // revision it did not send.
        ...(selectedVariant === "delegate" && profileDelegate?.promptRev
          ? { promptRev: profileDelegate.promptRev }
          : {}),
      }
    : opts.input;

  // The dispatch surface carries the profile's engine binding: a profile that
  // names a model is the MEMBER's own configuration (gateway prefs), not a
  // harness-writable manifest pin, so it outranks both. The harness rung is
  // not switched here — the automation's canonical conversation identity is
  // established before policy is read, and moving that is out of Wave 5's
  // scope (TODO #807): a profile that names a harness other than the fire's
  // still runs its model on the fire's harness, and the handler records the
  // ACP-confirmed identity of whatever answered.
  //
  // Bound only when a delegate variant ACTUALLY runs: a profile that selects
  // a delegate for a capability whose handler has no delegate code path must
  // change nothing at all, not even the ambient model of the deterministic
  // turn it never takes.
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

  // The `device` tier's backstop: the fire may run its deterministic /
  // device-lease work, but a model turn is provider egress, so `ctx.delegate` is
  // sealed shut rather than left to a handler's good manners. A handler that
  // reaches for one fails loudly with the reason instead of egressing.
  const sealed = sealedDomain;
  const delegateDispatcher: DelegateDispatcher = sealed
    ? () => {
        const reason = sealedModelTurnReason(opts.automationRef, sealed);
        onLog("warn", reason);
        return Promise.reject(new Error(reason));
      }
    : dispatch.delegateDispatcher;

  // Honest liveness (#290): a paused or needs-auth connection
  // never fires its connector — the skip is logged, and since connectors are
  // cursor-based, the next healthy run catches up over the accumulated gap
  // in one fire. Best-effort: an unreadable status (no grant yet) lets the
  // run proceed to sync.begin_run's hard gate rather than dying silently.
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

  // Secrets preflight (#293 decision 8): every declared secret must
  // reveal BEFORE the handler runs — one reveal per ref, receipted by the
  // vault. A trashed/missing item flips the connection to needs-auth (the
  // same honest-liveness state a wrong login shows) and the run skips.
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

  // Broker credential preflight (#304): a connection carrying an
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

  // onFailure cascade: when the handler fails and the manifest names a
  // follow-up automation, fire it with the failed run as input. The handle
  // resolves a bare id within the same app. Capped at depth 3.
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
              journalDbFile: opts.journalDbFile,
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
              // The cascade target is a fire like any other: if it declares
              // `enrich`, the same tier gate must apply to it.
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

/**
 * Reveal one declared secret ref through the automation's consented bridge —
 * rides the agent's `reveal` grant, receipted per item (#293). Two
 * ref forms: `locker:<item_id>:<column>` (the raw UUID) and, for stable
 * bindings that survive delete+recreate, `locker:@<alias>:<column>` (issue
 * #298 item 4) — the vault resolves the alias to the live item under the
 * same grant.
 */
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

/** Flip the connector's connection to needs-auth (#293): a missing or
 *  trashed secret item is the same honest-liveness state a wrong login is. */
async function flipNeedsAuth(
  vault: VaultBridge,
  connector: { kind: string; label: string; connectionId?: string }
): Promise<void> {
  const connectionId = await connectionIdOf(vault, connector);
  if (!connectionId) return; // no connection yet — nothing to flip
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

/** Read one connection's status through the automation's consented bridge. */
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
