import {
  ensureModelAssets as realEnsureModelAssets,
  FACES_MODEL_ID,
  OCR_MODEL_ID,
  readModelLock as realReadModelLock,
  verifyModelAssets as realVerifyModelAssets,
} from "@centraid/model-runtime";
import type {
  EnsureModelAssetsOptions,
  EnsureModelAssetsResult,
  ModelLock,
} from "@centraid/model-runtime";

import { SYSTEM_AUTOMATION_IDS } from "./system-recognition.js";

/**
 * Weights for the SYSTEM tier, provisioned at boot (#1011).
 *
 * A system automation is on because the release shipped it, so "the weights
 * are not on this disk yet" cannot mean "off" — it means **preparing**. This
 * module is the whole of that state: it fetches the pinned assets in the
 * background after the scheduler has reconciled, reports each system
 * automation as `preparing` until its capability's every pinned file is
 * present and digest-verified, and retries on a backoff when an upstream is
 * unreachable. Boot never waits for it, and a scheduled fire of a preparing
 * automation is SKIPPED with a stated reason rather than left to fail inside
 * the handler every five minutes.
 *
 * Once a capability is `ready` the next tick simply proceeds: every handler
 * walks its own cursor, so the backlog catches up on its own and there is
 * nothing to re-arm.
 */

/**
 * Which model each system automation declares — READ FROM THE HANDLER'S OWN
 * constant, never restated. `doc-text-extractor` is deliberately absent: it
 * ships no bundled deterministic engine (it declares `lane: "gateway"`), so
 * it carries no weights and is never `preparing`.
 *
 * The capabilities to provision are then derived from `models.lock.json`,
 * whose entries carry the `capabilities` each pinned file serves — so there is
 * exactly one capability list in the repository and it is the manifest's.
 */
const SYSTEM_AUTOMATION_MODEL_IDS: ReadonlyMap<string, string> = new Map([
  ["faces", FACES_MODEL_ID as string],
  ["photo-ocr", OCR_MODEL_ID as string],
]);

// A system automation that is neither mapped above nor knowingly weightless
// would silently never be provisioned. Fail at load instead.
const WEIGHTLESS_SYSTEM_AUTOMATION_IDS = new Set(["doc-text-extractor"]);
for (const id of SYSTEM_AUTOMATION_IDS) {
  if (
    !SYSTEM_AUTOMATION_MODEL_IDS.has(id) &&
    !WEIGHTLESS_SYSTEM_AUTOMATION_IDS.has(id)
  ) {
    throw new Error(
      `system automation "${id}" declares no model id and is not listed as weightless — ` +
        "add its handler's model constant to SYSTEM_AUTOMATION_MODEL_IDS (enrich/system-model-assets.ts)"
    );
  }
}

/**
 * The capabilities a system automation's declared model is pinned under, in
 * manifest order. Empty for an automation with no bundled model.
 */
export function systemAutomationCapabilities(
  lock: ModelLock,
  automationId: string
): string[] {
  const modelId = SYSTEM_AUTOMATION_MODEL_IDS.get(automationId);
  if (modelId === undefined) return [];
  const capabilities: string[] = [];
  for (const file of lock.files) {
    if (file.model !== modelId) continue;
    for (const capability of file.capabilities) {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    }
  }
  return capabilities;
}

/** `ready` once every pinned file is present; `preparing` until then. */
export type SystemModelState = "ready" | "preparing";

export interface SystemModelReadiness {
  readonly state: SystemModelState;
  /** Owner-facing sentence: why it is preparing, or what it is ready with. */
  readonly detail: string;
}

/**
 * The fields a status surface renders for a system automation, beside the
 * row's own `enabled` and the connector's `paused`. Empty for anything with
 * no readiness — which is everything that is not a system automation.
 */
export function modelReadinessFields(
  readiness: SystemModelReadiness | undefined
): { modelState?: SystemModelState; modelDetail?: string } {
  return readiness
    ? { modelState: readiness.state, modelDetail: readiness.detail }
    : {};
}

/**
 * Who is allowed to reach the network for weights (#1011).
 *
 * `"fetch"` downloads what the manifest pins; `"verify-only"` reports what is
 * already on disk and never opens a connection or arms a retry. This is a
 * HOST decision, not a gateway one (docs/config-ownership.md): the gateway
 * core has no business deciding that a boot may pull 277 MB, so the DEFAULT is
 * `"verify-only"` and every production entry point says `"fetch"` out loud.
 */
export type SystemModelProvision = "fetch" | "verify-only";

/** The sentence an owner reads on a host that provisions nothing. */
export const NOT_PROVISIONED_DETAIL =
  "model assets are not provisioned on this host";

export interface SystemModelAssetsOptions {
  /** Required: a host that does not say is not given the network. */
  provision: SystemModelProvision;
  /**
   * Where THIS automation's handler will look for its weights. Resolved by
   * the caller from `CENTRAID_AUTOMATION_RUNTIME_DIR` or the automation's own
   * sibling `runtime/`, exactly as `automation/fire/fire.ts` resolves it for
   * the sandbox — provisioning any other directory would fill a disk the
   * handler never reads.
   */
  runtimeDirFor: (automationId: string) => string;
  /** Reported like any other component; `paused` is reported the same way. */
  report: (status: "ok" | "degraded", detail: string) => void;
  log: (level: "info" | "warn", message: string) => void;
  /**
   * Called once per automation the moment it turns ready. The assets landing
   * is the thing the recipe was waiting for, so this is where the host nudges
   * the schedulers: without it the skipped fires simply wait for the next
   * tick, which is correct but needlessly slow on a first boot where the
   * member has just added a photograph.
   */
  onReady?: (automationId: string) => void;
  /**
   * Injected in tests, and the seam the provision mode picks in production:
   * `ensureModelAssets` for `"fetch"`, `verifyModelAssets` for `"verify-only"`.
   */
  ensure?: (
    options: EnsureModelAssetsOptions
  ) => Promise<EnsureModelAssetsResult>;
  readLock?: () => Promise<ModelLock>;
  /** Injected in tests; returns a canceller. Never a tight loop. */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

/** First retry a half-minute out, doubling to a half-hour ceiling. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 30 * 60_000;

const HEALTH_COMPONENT = "recognition-models";

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class SystemModelAssets {
  readonly #options: SystemModelAssetsOptions;
  readonly #states = new Map<string, SystemModelReadiness>();
  readonly #ensure: (
    options: EnsureModelAssetsOptions
  ) => Promise<EnsureModelAssetsResult>;
  readonly #readLock: () => Promise<ModelLock>;
  readonly #schedule: (fn: () => void, delayMs: number) => () => void;
  readonly #provision: SystemModelProvision;
  #attempt = 0;
  #started = false;
  #inFlight?: Promise<void>;
  #cancelRetry?: () => void;
  #stopped = false;

  constructor(options: SystemModelAssetsOptions) {
    this.#options = options;
    this.#provision = options.provision;
    this.#ensure =
      options.ensure ??
      (options.provision === "fetch"
        ? realEnsureModelAssets
        : realVerifyModelAssets);
    this.#readLock = options.readLock ?? realReadModelLock;
    this.#schedule = options.schedule ?? defaultSchedule;
    for (const id of SYSTEM_AUTOMATION_IDS) {
      this.#states.set(
        id,
        SYSTEM_AUTOMATION_MODEL_IDS.has(id)
          ? {
              state: "preparing",
              detail: "model assets have not been checked yet",
            }
          : { state: "ready", detail: "carries no bundled model weights" }
      );
    }
  }

  /** `undefined` for anything that is not a system automation. */
  readiness(automationId: string): SystemModelReadiness | undefined {
    return this.#states.get(automationId);
  }

  /** Every system automation's state, for a status surface. */
  snapshot(): Record<string, SystemModelReadiness> {
    return Object.fromEntries(this.#states);
  }

  /** True when a scheduled fire must be skipped, and why. */
  skipReason(automationId: string): string | undefined {
    const readiness = this.#states.get(automationId);
    if (!readiness || readiness.state === "ready") return undefined;
    return `${automationId} is preparing — ${readiness.detail}`;
  }

  /**
   * Kick the provisioning off. Returns immediately: boot must never wait on
   * a download, and a failure here is a retry, not a boot failure.
   */
  start(): void {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    void this.runOnce().catch(() => undefined);
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
  }

  /** One pass over every system automation that declares a model. Awaitable. */
  runOnce(): Promise<void> {
    this.#inFlight ??= this.#run().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #run(): Promise<void> {
    let lock: ModelLock;
    try {
      lock = await this.#readLock();
    } catch (error) {
      this.#allPreparing(`model manifest unreadable: ${message(error)}`);
      this.#scheduleRetry();
      return;
    }

    let outstanding = 0;
    for (const [automationId] of SYSTEM_AUTOMATION_MODEL_IDS) {
      const capabilities = systemAutomationCapabilities(lock, automationId);
      if (capabilities.length === 0) {
        this.#set(automationId, {
          state: "preparing",
          detail: `no pinned assets in models.lock.json for ${SYSTEM_AUTOMATION_MODEL_IDS.get(automationId)}`,
        });
        outstanding += 1;
        continue;
      }
      let result: EnsureModelAssetsResult;
      try {
        // Sequential on purpose: these are hundreds of megabytes and a first
        // boot is already competing with the rest of startup.
        // oxlint-disable-next-line no-await-in-loop -- see comment above
        result = await this.#ensure({
          runtimeDir: this.#options.runtimeDirFor(automationId),
          capabilities,
          lock,
        });
      } catch (error) {
        this.#set(automationId, {
          state: "preparing",
          detail:
            this.#provision === "fetch"
              ? `fetching model assets failed: ${message(error)}`
              : `${NOT_PROVISIONED_DETAIL}: ${message(error)}`,
        });
        outstanding += 1;
        continue;
      }
      if (result.fetched.length > 0) {
        this.#options.log(
          "info",
          `${automationId}: fetched ${result.fetched.length} model file(s) — ${result.fetched.join(", ")}`
        );
      }
      if (result.failed.length === 0) {
        this.#set(automationId, {
          state: "ready",
          detail: `${SYSTEM_AUTOMATION_MODEL_IDS.get(automationId)} weights present and verified`,
        });
        continue;
      }
      outstanding += 1;
      const failure = result.failed
        .map((entry) => `${entry.capability}: ${entry.error}`)
        .join("; ");
      this.#set(automationId, {
        state: "preparing",
        detail:
          this.#provision === "fetch"
            ? failure
            : `${NOT_PROVISIONED_DETAIL} — ${failure}`,
      });
    }

    if (outstanding === 0) {
      this.#attempt = 0;
      // Everything landed: an armed retry from an earlier pass has nothing
      // left to do, and leaving it would re-hash every weight for no reason.
      this.#cancelRetry?.();
      this.#cancelRetry = undefined;
      this.#options.report(
        "ok",
        "system recognition model assets present and verified"
      );
      return;
    }
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    const preparing = [...this.#states]
      .filter(([, readiness]) => readiness.state === "preparing")
      .map(([id, readiness]) => `${id} (${readiness.detail})`);
    // A verify-only host has nothing to wait for: nothing on this box is
    // going to make the weights appear, so re-hashing on a timer would burn
    // I/O to reach the same answer. Report it once and stop.
    if (this.#stopped || this.#provision === "verify-only") {
      this.#options.report(
        "degraded",
        `system recognition models preparing: ${preparing.join("; ")}`
      );
      return;
    }
    const delayMs = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.min(this.#attempt, 16)
    );
    this.#attempt += 1;
    const detail =
      `system recognition models preparing: ${preparing.join("; ")} — ` +
      `retrying in ${Math.round(delayMs / 1000)}s`;
    this.#options.report("degraded", detail);
    this.#options.log("warn", detail);
    this.#cancelRetry?.();
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = undefined;
      void this.runOnce().catch(() => undefined);
    }, delayMs);
  }

  #allPreparing(detail: string): void {
    for (const [automationId] of SYSTEM_AUTOMATION_MODEL_IDS) {
      this.#set(automationId, { state: "preparing", detail });
    }
  }

  #set(automationId: string, readiness: SystemModelReadiness): void {
    const prior = this.#states.get(automationId);
    this.#states.set(automationId, readiness);
    if (prior?.state === readiness.state) return;
    if (readiness.state === "ready") this.#options.onReady?.(automationId);
    this.#options.log(
      readiness.state === "ready" ? "info" : "warn",
      `${automationId}: model assets ${readiness.state} — ${readiness.detail}`
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { HEALTH_COMPONENT as SYSTEM_MODEL_HEALTH_COMPONENT };
