/*
 * Component-level health for a self-hosted gateway. Uptime says "the
 * process answers"; this says WHICH subsystem stopped working and what
 * its last error was — the difference between "it broke" and a bug
 * report a self-hoster can act on.
 *
 * Two feeds converge here:
 *   - PUSH: subsystems mark themselves ok/degraded/error at their own
 *     success/failure points (outbox drain, scheduler reconcile, fires),
 *     and `loggerFor(component)` wraps a `RuntimeLogger` so existing
 *     `warn`/`error` calls land in the ring buffer as structured,
 *     component-tagged events without touching call sites.
 *   - PULL: `registerProbe` adds a check run at snapshot time for state
 *     nobody pushes (e.g. "are the vault planes mounted").
 *
 * Semantics chosen for v0:
 *   - a logged `warn` records an event but does NOT flip component
 *     status (transient warns must not leave a component sticky-red);
 *     a logged `error` flips it to error until the next explicit ok.
 *   - probe status wins for probed components — it reflects "now".
 *   - overall = worst component (error > degraded > ok).
 */

import type { RuntimeLogger } from '@centraid/app-engine';

export type ComponentStatus = 'ok' | 'degraded' | 'error';

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  /** Human-oriented "what this looks like right now" (counts, mode). */
  detail?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  /** Errors since gateway start (events + explicit reportError). */
  errorCount: number;
}

export interface HealthEvent {
  at: string;
  component: string;
  level: 'warn' | 'error';
  message: string;
}

/**
 * Coarse numeric signals (issue #351 tier 3) — deliberately separate from
 * `ComponentHealth.detail`, which stays a plain human-readable string (an
 * existing contract kept as-is). Everything here is a raw number a
 * self-hoster's own monitoring can graph without parsing prose.
 */
export interface HealthMetrics {
  /** `process.memoryUsage().rss` at snapshot time. */
  rssBytes: number;
  /** Outbox items awaiting drain, summed across mounted vaults. */
  outboxPending: number;
  /**
   * Live SSE subscriber count across every open run stream. Optional and
   * commonly absent: it needs a global counter on `RunEventBus`, which a
   * sibling change (the SSE subscriber cap) is adding — wire this up once
   * that lands (see `build-gateway.ts`'s `setMetricsSource` call).
   */
  sseClients?: number;
  /** Rolling event-loop delay window from `perf_hooks.monitorEventLoopDelay`. */
  eventLoopLagP50Ms?: number;
  eventLoopLagP99Ms?: number;
  eventLoopLagMaxMs?: number;
  /** Highest rolling-window p99 observed since process start. */
  eventLoopLagPeakP99Ms?: number;
  eventLoopLagSamples?: number;
  /** Boot-time durability-barrier latency for one 4 KiB write. */
  storageFsyncMs?: number;
  uptimeMs: number;
}

/** What a host-injected metrics source contributes — `rssBytes`/`uptimeMs` are computed here. */
export type MetricsSourceResult = Partial<Pick<HealthMetrics, 'outboxPending' | 'sseClients'>>;
export type MetricsSource = () => MetricsSourceResult;

export type PerformanceMetricsSourceResult = Partial<
  Pick<
    HealthMetrics,
    | 'eventLoopLagP50Ms'
    | 'eventLoopLagP99Ms'
    | 'eventLoopLagMaxMs'
    | 'eventLoopLagPeakP99Ms'
    | 'eventLoopLagSamples'
    | 'storageFsyncMs'
  >
>;
export type PerformanceMetricsSource = () => PerformanceMetricsSourceResult;

export interface HealthSnapshot {
  /** Worst component status — `ok` when every component is ok. */
  status: ComponentStatus;
  startedAt: string;
  uptimeMs: number;
  components: ComponentHealth[];
  /** Newest-first structured log tail (warns + errors), bounded. */
  recentEvents: HealthEvent[];
  /**
   * Coarse numeric signals — see `HealthMetrics`. Always present:
   * `rssBytes`/`uptimeMs` need no host wiring; `outboxPending` defaults to 0
   * until a host calls `setMetricsSource`; `sseClients` stays absent until
   * one is supplied.
   */
  metrics: HealthMetrics;
}

/** A snapshot-time check for state no subsystem pushes. */
export type HealthProbe = () => Promise<{ status: ComponentStatus; detail?: string }>;

const SEVERITY: Record<ComponentStatus, number> = { ok: 0, degraded: 1, error: 2 };

const worseOf = (a: ComponentStatus, b: ComponentStatus): ComponentStatus =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

export interface HealthRegistryOptions {
  /** Ring-buffer bound for `recentEvents`. */
  maxEvents?: number;
  /** Clock override (tests). */
  now?: () => number;
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

export class HealthRegistry {
  private readonly components = new Map<string, ComponentState>();
  private readonly probes = new Map<string, HealthProbe>();
  private readonly events: HealthEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private metricsSource?: MetricsSource;
  private performanceMetricsSource?: PerformanceMetricsSource;
  private resetPerformanceMetricsSource?: () => void;

  constructor(options: HealthRegistryOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /**
   * Register the host's numeric-metrics source (issue #351 tier 3) — called
   * once at `buildGateway()` time. Only `outboxPending`/`sseClients` come
   * from here; `rssBytes`/`uptimeMs` are computed inside `snapshot()`
   * itself, needing no host wiring at all.
   */
  setMetricsSource(source: MetricsSource): void {
    this.metricsSource = source;
  }

  setPerformanceMetricsSource(source: PerformanceMetricsSource, reset?: () => void): void {
    this.performanceMetricsSource = source;
    this.resetPerformanceMetricsSource = reset;
  }

  /** Start a fresh metrics epoch; used by the in-process benchmark after warmup. */
  resetPerformanceMetrics(): void {
    this.resetPerformanceMetricsSource?.();
  }

  /** Runtime backpressure signal shared by every background subsystem (issue #456 A6). */
  shouldDeferBackgroundWork(maxP99Ms = 50): boolean {
    const p99 = this.performanceMetricsSource?.().eventLoopLagP99Ms;
    return p99 !== undefined && p99 >= maxP99Ms;
  }

  reportOk(component: string, detail?: string): void {
    const state = this.stateFor(component);
    state.status = 'ok';
    state.lastOkAt = this.now();
    if (detail !== undefined) state.detail = detail;
  }

  reportDegraded(component: string, detail: string): void {
    const state = this.stateFor(component);
    state.status = 'degraded';
    state.detail = detail;
  }

  reportError(component: string, message: string): void {
    const state = this.stateFor(component);
    state.status = 'error';
    state.lastErrorAt = this.now();
    state.lastError = message;
    state.errorCount += 1;
    this.pushEvent(component, 'error', message);
  }

  /**
   * Wrap a `RuntimeLogger` so a component's existing log calls feed the
   * registry: `warn` → event only, `error` → event + error status.
   */
  loggerFor(component: string, base: RuntimeLogger): RuntimeLogger {
    return {
      info: (m) => base.info(m),
      warn: (m) => {
        this.stateFor(component);
        this.pushEvent(component, 'warn', m);
        base.warn(m);
      },
      error: (m) => {
        this.reportError(component, m);
        base.error(m);
      },
    };
  }

  /** Snapshot-time check; its result wins the component's status. */
  registerProbe(component: string, probe: HealthProbe): void {
    this.stateFor(component);
    this.probes.set(component, probe);
  }

  async snapshot(): Promise<HealthSnapshot> {
    for (const [component, probe] of this.probes) {
      const state = this.stateFor(component);
      try {
        const result = await probe();
        state.status = result.status;
        if (result.detail !== undefined) state.detail = result.detail;
        if (result.status === 'ok') state.lastOkAt = this.now();
      } catch (err) {
        this.reportError(component, err instanceof Error ? err.message : String(err));
      }
    }

    const components: ComponentHealth[] = [...this.components.entries()]
      .map(([component, s]) => ({
        component,
        status: s.status,
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
        ...(s.lastOkAt !== undefined ? { lastOkAt: new Date(s.lastOkAt).toISOString() } : {}),
        ...(s.lastErrorAt !== undefined
          ? { lastErrorAt: new Date(s.lastErrorAt).toISOString() }
          : {}),
        ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
        errorCount: s.errorCount,
      }))
      .sort((a, b) => a.component.localeCompare(b.component));

    const nowMs = this.now();
    const uptimeMs = nowMs - this.startedAtMs;
    const sourced = this.metricsSource?.() ?? {};
    const performance = this.performanceMetricsSource?.() ?? {};
    return {
      status: components.reduce<ComponentStatus>((acc, c) => worseOf(acc, c.status), 'ok'),
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs,
      components,
      recentEvents: this.events.toReversed(),
      metrics: {
        rssBytes: process.memoryUsage().rss,
        outboxPending: sourced.outboxPending ?? 0,
        ...(sourced.sseClients !== undefined ? { sseClients: sourced.sseClients } : {}),
        ...performance,
        uptimeMs,
      },
    };
  }

  private stateFor(component: string): ComponentState {
    let state = this.components.get(component);
    if (!state) {
      state = { status: 'ok', errorCount: 0 };
      this.components.set(component, state);
    }
    return state;
  }

  private pushEvent(component: string, level: 'warn' | 'error', message: string): void {
    this.events.push({ at: new Date(this.now()).toISOString(), component, level, message });
    if (this.events.length > this.maxEvents)
      this.events.splice(0, this.events.length - this.maxEvents);
  }
}
