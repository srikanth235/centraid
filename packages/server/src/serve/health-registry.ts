// governance: allow-repo-hygiene file-size-limit (#679) component state, registry enumeration, failure induction, and snapshot aggregation form one health contract whose completeness is audited together

import type { RuntimeLogger } from "@centraid/server/engine";

import type { StructuredResourceProfile } from "./hardware-profile.js";
import type { PowerContextState } from "./power-context.js";
import type { ResourceUsageActuals } from "./resource-accounting.js";
import {
  formatBackgroundPausedDetail,
  formatBackgroundResumedDetail,
  formatLoadShedClearedDetail,
  formatLoadShedDeferringDetail,
  formatLoadShedForcedPassDetail,
} from "./resource-mode.js";
import type { RouteLatencySummary } from "./route-latency.js";

export interface BackgroundPauseState {
  paused: boolean;
  until: string | null;
}

export const MAX_BACKGROUND_PAUSE_MS = 86_400_000;

const BACKGROUND_PAUSE_COMPONENT = "background-pause";

export interface ExpectedHealthComponent {
  readonly component: string;
  readonly owner: string;
  readonly induction: "probe" | "report-error" | "logger";
  readonly waiver?: string;
}

function defineExpectedHealthGroup(
  owner: string,
  induction: ExpectedHealthComponent["induction"],
  components: readonly string[]
): readonly ExpectedHealthComponent[] {
  return components.map((component) => ({ component, owner, induction }));
}

export const EXPECTED_HEALTH_COMPONENTS: readonly ExpectedHealthComponent[] = [
  ...defineExpectedHealthGroup("build-gateway", "report-error", [
    "harness-failover",
    "automation-runs",
    "automations",
    "filesystem",
    "hardware-profile",
    "instance",
    "power-posture",
    "storage-latency",
  ]),
  ...defineExpectedHealthGroup("backup-service", "probe", ["backups"]),
  ...defineExpectedHealthGroup("vault-plane", "report-error", ["blob-sweep"]),
  ...defineExpectedHealthGroup("build-gateway", "probe", [
    "broker",
    "connections",
    "disk",
    "enrichment",
    "event-loop",
    "scheduler",
    "storage-limit",
    "storage-quota",
    "vault-integrity",
    "vaults",
  ]),
  ...defineExpectedHealthGroup("build-gateway", "logger", [
    "catalog",
    "outbox",
    "pricing",
  ]),
  ...defineExpectedHealthGroup("health-registry", "report-error", [
    "load-shed",
  ]),
].toSorted((left, right) => left.component.localeCompare(right.component));

export type ComponentStatus = "ok" | "degraded" | "error";

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  detail?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  errorCount: number;
}

export interface HealthEvent {
  at: string;
  component: string;
  level: "warn" | "error";
  message: string;
}

export interface HealthMetrics {
  rssBytes: number;
  outboxPending: number;
  sseClients?: number;
  mountedVaults?: number;
  eventLoopLagP50Ms?: number;
  eventLoopLagP99Ms?: number;
  eventLoopLagMaxMs?: number;
  eventLoopLagPeakP99Ms?: number;
  eventLoopLagSamples?: number;
  storageFsyncMs?: number;
  routeLatency?: RouteLatencySummary[];
  hardwareProfileClass?: string;
  resourceMode?: string;
  resourceProfile?: StructuredResourceProfile;
  resourceUsage?: ResourceUsageActuals;
  powerContext?: PowerContextState;
  backgroundPause: BackgroundPauseState;
  uptimeMs: number;
}

export type MetricsSourceResult = Partial<
  Pick<
    HealthMetrics,
    | "outboxPending"
    | "sseClients"
    | "mountedVaults"
    | "hardwareProfileClass"
    | "resourceMode"
    | "resourceProfile"
    | "resourceUsage"
    | "powerContext"
  >
>;
export type MetricsSource = () => MetricsSourceResult;

export type PerformanceMetricsSourceResult = Partial<
  Pick<
    HealthMetrics,
    | "eventLoopLagP50Ms"
    | "eventLoopLagP99Ms"
    | "eventLoopLagMaxMs"
    | "eventLoopLagPeakP99Ms"
    | "eventLoopLagSamples"
    | "storageFsyncMs"
    | "routeLatency"
  >
>;
export type PerformanceMetricsSource = () => PerformanceMetricsSourceResult;

export interface HealthSnapshot {
  status: ComponentStatus;
  startedAt: string;
  uptimeMs: number;
  components: ComponentHealth[];
  recentEvents: HealthEvent[];
  metrics: HealthMetrics;
}

export type HealthProbe = () => Promise<{
  status: ComponentStatus;
  detail?: string;
}>;

const SEVERITY: Record<ComponentStatus, number> = {
  ok: 0,
  degraded: 1,
  error: 2,
};

const worseOf = (a: ComponentStatus, b: ComponentStatus): ComponentStatus =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

export interface HealthRegistryOptions {
  maxEvents?: number;
  now?: () => number;
  maxLoadShedMs?: number;
}

interface ComponentState {
  status: ComponentStatus;
  detail?: string;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  errorCount: number;
}

const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_MAX_LOAD_SHED_MS = 5 * 60 * 1_000;

export class HealthRegistry {
  private readonly components = new Map<string, ComponentState>();
  private readonly probes = new Map<string, HealthProbe>();
  private readonly registrations = new Map<
    string,
    Set<ExpectedHealthComponent["induction"]>
  >();
  private readonly events: HealthEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly maxLoadShedMs: number;
  private loadShedSinceMs?: number;
  private metricsSource?: MetricsSource;
  private performanceMetricsSource?: PerformanceMetricsSource;
  private resetPerformanceMetricsSource?: () => void;
  private backgroundPaused = false;
  private backgroundPauseUntilMs?: number;

  constructor(options: HealthRegistryOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.maxLoadShedMs = options.maxLoadShedMs ?? DEFAULT_MAX_LOAD_SHED_MS;
  }

  setMetricsSource(source: MetricsSource): void {
    this.metricsSource = source;
  }

  setPerformanceMetricsSource(
    source: PerformanceMetricsSource,
    reset?: () => void
  ): void {
    this.performanceMetricsSource = source;
    this.resetPerformanceMetricsSource = reset;
  }

  resetPerformanceMetrics(): void {
    this.resetPerformanceMetricsSource?.();
  }

  shouldDeferBackgroundWork(maxP99Ms = 50): boolean {
    const p99 = this.performanceMetricsSource?.().eventLoopLagP99Ms;
    const now = this.now();
    if (p99 === undefined || p99 < maxP99Ms) {
      if (this.loadShedSinceMs !== undefined) {
        this.loadShedSinceMs = undefined;
        this.reportOk("load-shed", formatLoadShedClearedDetail());
      }
      return false;
    }

    this.loadShedSinceMs ??= now;
    const deferredMs = now - this.loadShedSinceMs;
    if (deferredMs < this.maxLoadShedMs) {
      this.reportDegraded("load-shed", formatLoadShedDeferringDetail(p99));
      return true;
    }

    this.reportDegraded(
      "load-shed",
      formatLoadShedForcedPassDetail(p99, deferredMs)
    );
    this.loadShedSinceMs = now;
    return false;
  }

  pauseBackgroundWork(durationMs?: number): BackgroundPauseState {
    this.backgroundPaused = true;
    this.backgroundPauseUntilMs =
      durationMs === undefined ? undefined : this.now() + durationMs;
    const state = this.readBackgroundPause();
    const detail = formatBackgroundPausedDetail(state.until);
    this.reportDegraded(BACKGROUND_PAUSE_COMPONENT, detail);
    this.pushEvent(BACKGROUND_PAUSE_COMPONENT, "warn", detail);
    return state;
  }

  resumeBackgroundWork(): BackgroundPauseState {
    if (this.backgroundPaused) this.clearBackgroundPause();
    return this.readBackgroundPause();
  }

  backgroundPauseState(): BackgroundPauseState {
    return this.readBackgroundPause();
  }

  shouldPauseBackgroundWork(): boolean {
    return this.readBackgroundPause().paused;
  }

  private readBackgroundPause(): BackgroundPauseState {
    if (
      this.backgroundPaused &&
      this.backgroundPauseUntilMs !== undefined &&
      this.now() >= this.backgroundPauseUntilMs
    ) {
      this.clearBackgroundPause();
    }
    return {
      paused: this.backgroundPaused,
      until:
        this.backgroundPauseUntilMs === undefined
          ? null
          : new Date(this.backgroundPauseUntilMs).toISOString(),
    };
  }

  private clearBackgroundPause(): void {
    this.backgroundPaused = false;
    this.backgroundPauseUntilMs = undefined;
    const detail = formatBackgroundResumedDetail();
    this.reportOk(BACKGROUND_PAUSE_COMPONENT, detail);
    this.pushEvent(BACKGROUND_PAUSE_COMPONENT, "warn", detail);
  }

  reportOk(component: string, detail?: string): void {
    this.noteRegistration(component, "report-error");
    const state = this.stateFor(component);
    state.status = "ok";
    state.lastOkAt = this.now();
    if (detail !== undefined) state.detail = detail;
  }

  registerPush(component: string): void {
    this.noteRegistration(component, "report-error");
    this.stateFor(component);
  }

  registerExpectedPushComponents(): void {
    for (const expected of EXPECTED_HEALTH_COMPONENTS)
      if (expected.induction === "report-error")
        this.registerPush(expected.component);
  }

  reportDegraded(component: string, detail: string): void {
    this.noteRegistration(component, "report-error");
    const state = this.stateFor(component);
    state.status = "degraded";
    state.detail = detail;
  }

  reportError(component: string, message: string): void {
    this.noteRegistration(component, "report-error");
    const state = this.stateFor(component);
    state.status = "error";
    state.lastErrorAt = this.now();
    state.lastError = message;
    state.errorCount += 1;
    this.pushEvent(component, "error", message);
  }

  loggerFor(component: string, base: RuntimeLogger): RuntimeLogger {
    this.noteRegistration(component, "logger");
    return {
      info: (m) => base.info(m),
      warn: (m) => {
        this.stateFor(component);
        this.pushEvent(component, "warn", m);
        base.warn(m);
      },
      error: (m) => {
        this.reportError(component, m);
        base.error(m);
      },
    };
  }

  registerProbe(component: string, probe: HealthProbe): void {
    this.noteRegistration(component, "probe");
    this.stateFor(component);
    this.probes.set(component, probe);
  }

  expectedRegistrationGaps(): ExpectedHealthComponent[] {
    return EXPECTED_HEALTH_COMPONENTS.filter(
      ({ component, induction }) =>
        !this.registrations.get(component)?.has(induction)
    );
  }

  induceExpectedFailureForTest(component: string): () => void {
    if (process.env.NODE_ENV !== "test")
      throw new Error("health failure induction is test-only");
    const expected = EXPECTED_HEALTH_COMPONENTS.find(
      (entry) => entry.component === component
    );
    if (!expected) throw new Error(`unexpected health component: ${component}`);
    if (!this.registrations.get(component)?.has(expected.induction))
      throw new Error(
        `health component ${component} is not registered through ${expected.induction}`
      );
    const currentState = this.components.get(component);
    const priorState = currentState ? { ...currentState } : undefined;
    const priorProbe = this.probes.get(component);
    if (expected.induction === "probe" || priorProbe) {
      if (!priorProbe)
        throw new Error(
          `health component ${component} has no production probe`
        );
      this.probes.set(component, async () => ({
        status: "error",
        detail: "seeded production-probe failure",
      }));
    } else {
      this.reportError(component, "seeded production failure");
    }
    return () => {
      if (priorProbe) this.probes.set(component, priorProbe);
      else this.probes.delete(component);
      if (priorState) this.components.set(component, { ...priorState });
      else this.components.delete(component);
    };
  }

  private noteRegistration(
    component: string,
    kind: ExpectedHealthComponent["induction"]
  ): void {
    const current = this.registrations.get(component) ?? new Set();
    current.add(kind);
    this.registrations.set(component, current);
  }

  async snapshot(): Promise<HealthSnapshot> {
    await Promise.all(
      [...this.probes].map(async ([component, probe]) => {
        const state = this.stateFor(component);
        try {
          const result = await probe();
          state.status = result.status;
          if (result.detail !== undefined) state.detail = result.detail;
          if (result.status === "ok") state.lastOkAt = this.now();
        } catch (error) {
          this.reportError(
            component,
            error instanceof Error ? error.message : String(error)
          );
        }
      })
    );

    const components: ComponentHealth[] = [...this.components.entries()]
      .map(([component, s]) => ({
        component,
        status: s.status,
        ...(s.detail === undefined ? {} : { detail: s.detail }),
        ...(s.lastOkAt === undefined
          ? {}
          : { lastOkAt: new Date(s.lastOkAt).toISOString() }),
        ...(s.lastErrorAt === undefined
          ? {}
          : { lastErrorAt: new Date(s.lastErrorAt).toISOString() }),
        ...(s.lastError === undefined ? {} : { lastError: s.lastError }),
        errorCount: s.errorCount,
      }))
      .sort((a, b) => a.component.localeCompare(b.component));

    const nowMs = this.now();
    const uptimeMs = nowMs - this.startedAtMs;
    const sourced = this.metricsSource?.() ?? {};
    const performance = this.performanceMetricsSource?.() ?? {};
    return {
      status: components.reduce<ComponentStatus>(
        (acc, c) => worseOf(acc, c.status),
        "ok"
      ),
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs,
      components,
      recentEvents: this.events.toReversed(),
      metrics: {
        rssBytes: process.memoryUsage().rss,
        outboxPending: sourced.outboxPending ?? 0,
        ...(sourced.sseClients === undefined
          ? {}
          : { sseClients: sourced.sseClients }),
        ...(sourced.mountedVaults === undefined
          ? {}
          : { mountedVaults: sourced.mountedVaults }),
        ...(sourced.hardwareProfileClass === undefined
          ? {}
          : { hardwareProfileClass: sourced.hardwareProfileClass }),
        ...(sourced.resourceMode === undefined
          ? {}
          : { resourceMode: sourced.resourceMode }),
        ...(sourced.resourceProfile === undefined
          ? {}
          : { resourceProfile: sourced.resourceProfile }),
        ...(sourced.resourceUsage === undefined
          ? {}
          : { resourceUsage: sourced.resourceUsage }),
        ...(sourced.powerContext === undefined
          ? {}
          : { powerContext: sourced.powerContext }),
        backgroundPause: this.readBackgroundPause(),
        ...performance,
        uptimeMs,
      },
    };
  }

  private stateFor(component: string): ComponentState {
    let state = this.components.get(component);
    if (!state) {
      state = { status: "ok", errorCount: 0 };
      this.components.set(component, state);
    }
    return state;
  }

  private pushEvent(
    component: string,
    level: "warn" | "error",
    message: string
  ): void {
    this.events.push({
      at: new Date(this.now()).toISOString(),
      component,
      level,
      message,
    });
    if (this.events.length > this.maxEvents)
      this.events.splice(0, this.events.length - this.maxEvents);
  }
}
