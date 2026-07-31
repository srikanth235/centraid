import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { relativeTime } from "../format.js";
import { gatewayStatusCopy, railStatus } from "../shell/gatewayRegistry.js";
import type { GatewayRow } from "../shell/gatewayRegistry.js";
import { cx } from "../ui/cx.js";
import { Icon } from "../ui/index.js";
import type {
  BackgroundPauseDTO,
  PowerContextState,
  ResourceProfileDTO,
} from "./resource-summary.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./SettingsDiagnosticsScreen.module.css";

// Gateway → Components: the owner surface over the gateway's
// component-level health (`GET /centraid/_gateway/health`). Uptime says
// the process answers; this says which subsystem stopped working — vaults,
// schedulers, outbox, connections — with each component's last error and
// the gateway's recent structured warn/error tail. Prop-driven like
// SettingsProvidersScreen: this file owns the view + load/refresh state,
// the gateway I/O lives in `routes/settingsDiagnosticsData.ts`. Mounted from
// the Gateway page's Components tab (GatewayScreen.tsx), not Settings.

export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthComponentDTO {
  component: string;
  status: HealthStatus;
  detail?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  errorCount: number;
}

export interface HealthEventDTO {
  at: string;
  component: string;
  level: "warn" | "error";
  message: string;
}

/** Coarse numeric signals from the gateway health snapshot (issue #521). */
export interface HealthMetricsDTO {
  rssBytes: number;
  outboxPending: number;
  sseClients?: number;
  eventLoopLagP50Ms?: number;
  eventLoopLagP99Ms?: number;
  eventLoopLagMaxMs?: number;
  eventLoopLagPeakP99Ms?: number;
  eventLoopLagSamples?: number;
  storageFsyncMs?: number;
  hardwareProfileClass?: string;
  resourceMode?: string;
  /**
   * Structured resource contract (issue #528 Phase A) — host facts, class,
   * mode, and the resolved knobs the profile derived. Present on modern
   * gateways only; the Resource card's L1/L2 disclosure gates on it.
   */
  resourceProfile?: ResourceProfileDTO;
  /**
   * Background-work pause state (issue #528 Phase B). Present on modern
   * gateways only; absent hides the Resource card's pause control.
   */
  backgroundPause?: BackgroundPauseDTO;
  /**
   * Power-context posture (issue #528 Phase D) — the gateway host's battery /
   * mains / server situation. Present on modern gateways only; drives the
   * Resource card's posture note (battery/thermal chrome or a server fact).
   */
  powerContext?: PowerContextState;
  uptimeMs: number;
}

export interface GatewayHealthDTO {
  status: HealthStatus;
  startedAt: string;
  uptimeMs: number;
  components: HealthComponentDTO[];
  recentEvents: HealthEventDTO[];
  /** Present on modern gateways; optional for older heartbeats/tests. */
  metrics?: HealthMetricsDTO;
}

/**
 * Host plumbing, the one place it is allowed to be visible (issue #665).
 *
 * Everywhere else the owner manages vaults; here the machine serving them is
 * the subject, so "host" and "connection" are the right words and the three
 * rare, deliberate acts against one — prove it works, relabel it, stop talking
 * to it — belong together. Omitted by hosts that expose no registry (web,
 * stubbed test bridges): the whole section then simply isn't rendered.
 */
export interface DiagnosticsConnectionsProps {
  /** Refresh the registry: resolves with the cached rows to paint now and
   *  calls `onUpdate` again for each probe that lands. */
  loadConnections: (
    onUpdate: (rows: GatewayRow[]) => void
  ) => Promise<GatewayRow[]>;
  /** Bumped by the owner of the rename/remove modals once one commits, so the
   *  list re-reads instead of showing the label it had a moment ago. */
  refreshKey?: number;
  onTest: (gatewayId: string, label: string) => void;
  onRename: (gatewayId: string, label: string) => void;
  onRemove: (gatewayId: string, label: string) => void;
}

export interface SettingsDiagnosticsBridgeProps {
  loadHealth: () => Promise<GatewayHealthDTO>;
  /** Jump into the Logs tab, focused on this component's lines — omitted
   *  when the caller has nowhere to send the click (only wired from the
   *  Gateway page, where Logs is a sibling tab). */
  onJumpToLogs?: (component: string) => void;
  /** Host plumbing. Absent on hosts with no gateway registry. */
  connections?: DiagnosticsConnectionsProps;
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "All systems go",
  degraded: "Degraded",
  error: "Something is failing",
};

const COMPONENT_LABEL: Record<string, string> = {
  vaults: "Vaults",
  connections: "Connections",
  automations: "Automation scheduler",
  "automation-runs": "Automation runs",
  outbox: "Outbox",
  catalog: "Model catalog",
  tunnel: "Phone tunnel",
  "hardware-profile": "Hardware profile",
  "event-loop": "Responsiveness",
  "load-shed": "Background load",
  disk: "Disk space",
  "storage-latency": "Storage latency",
  // The health-component namespace is the GATEWAY's, not the shell's — this
  // stays `backups` even though the page that shows it is now called Storage.
  backups: "Backups",
  "storage-limit": "Disk budget",
  enrichment: "Media enrichment",
  "blob-sweep": "Blob sweep",
  scheduler: "Scheduler",
  broker: "Connections broker",
};

export function componentLabel(component: string): string {
  return (
    COMPONENT_LABEL[component] ??
    component.charAt(0).toUpperCase() + component.slice(1).replace(/-/gu, " ")
  );
}

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRss(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function resourceModeWord(mode: string | undefined): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "conserve":
      return "Conserve";
    case "balanced":
      return "Balanced";
    case "performance":
      return "Performance";
    case undefined:
      return "—";
    default:
      return mode;
  }
}

function hardwareClassWord(cls: string | undefined): string {
  if (cls === "constrained") return "Constrained";
  if (cls === "standard") return "Standard";
  return cls ?? "—";
}

function eventClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ComponentRow({
  row,
  onJumpToLogs,
}: {
  row: HealthComponentDTO;
  onJumpToLogs?: (component: string) => void;
}): JSX.Element {
  // The sub-line reads the most useful thing per state: a failing
  // component shows its LAST ERROR (the actionable bit); a healthy one
  // shows its probe detail ("2 vaults mounted") or last-ok recency.
  const sub =
    row.status === "ok"
      ? (row.detail ??
        (row.lastOkAt ? `last ok ${relativeTime(row.lastOkAt)}` : undefined))
      : (row.lastError ?? row.detail);
  return (
    <div className={styles.row} data-testid="diag-component">
      <span className={styles.dot} data-health={row.status} />
      <div className={styles.rowMeta}>
        <div className={styles.rowName}>{componentLabel(row.component)}</div>
        {sub ? (
          <div className={styles.rowSub} title={sub}>
            {sub}
          </div>
        ) : null}
      </div>
      {row.errorCount > 0 ? (
        <span className={styles.errCount} title="Errors since gateway start">
          {row.errorCount} err{row.errorCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {row.status !== "ok" && onJumpToLogs ? (
        <button
          type="button"
          className={styles.jumpToLogs}
          onClick={() => onJumpToLogs(row.component)}
        >
          View in logs
        </button>
      ) : null}
      <span className={styles.healthLabel} data-health={row.status}>
        {row.status === "ok"
          ? "Healthy"
          : row.status === "degraded"
            ? "Degraded"
            : "Failing"}
      </span>
    </div>
  );
}

function MetricsPanel({ metrics }: { metrics: HealthMetricsDTO }): JSX.Element {
  const lag =
    metrics.eventLoopLagP99Ms === undefined
      ? "—"
      : `p99 ${metrics.eventLoopLagP99Ms.toFixed(1)} ms`;
  const fsync =
    metrics.storageFsyncMs === undefined
      ? "—"
      : `${metrics.storageFsyncMs.toFixed(1)} ms`;
  return (
    <div className={styles.metrics} data-testid="diag-metrics">
      <div className={styles.metric}>
        <div className={styles.metricLabel}>Memory</div>
        <div className={styles.metricValue}>{formatRss(metrics.rssBytes)}</div>
      </div>
      <div className={styles.metric}>
        <div className={styles.metricLabel}>Event-loop lag</div>
        <div className={styles.metricValue}>{lag}</div>
      </div>
      <div className={styles.metric}>
        <div className={styles.metricLabel}>Storage fsync</div>
        <div className={styles.metricValue}>{fsync}</div>
      </div>
      <div className={styles.metric}>
        <div className={styles.metricLabel}>Resource mode</div>
        <div className={styles.metricValue}>
          {resourceModeWord(metrics.resourceMode)}
        </div>
        <div className={styles.metricSub}>
          {hardwareClassWord(metrics.hardwareProfileClass)}
        </div>
      </div>
    </div>
  );
}

/** Reachability in the health dot's vocabulary — a still-probing host has no
 *  verdict yet, so it gets the dot's neutral default rather than a colour. */
function connectionHealth(row: GatewayRow): HealthStatus | undefined {
  const rail = railStatus(row);
  if (rail === "ready") return "ok";
  if (rail === "error") return "error";
  return undefined;
}

/** What one host is currently serving, in the fewest words that still say it. */
function connectionSummary(row: GatewayRow): string {
  if (row.status !== "ready") return gatewayStatusCopy(row);
  const names = (row.vaults ?? []).map((vault) => vault.name);
  if (names.length === 0) return "No vaults";
  const count = `${names.length} ${names.length === 1 ? "vault" : "vaults"}`;
  return `${count} · ${names.join(", ")}`;
}

function ConnectionsPanel({
  loadConnections,
  refreshKey,
  onTest,
  onRename,
  onRemove,
}: DiagnosticsConnectionsProps): JSX.Element {
  const [rows, setRows] = useState<GatewayRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (next: GatewayRow[]): void => {
      if (alive) setRows(next);
    };
    void loadConnections(apply)
      .then(apply)
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [loadConnections, refreshKey]);

  return (
    <>
      <div className={styles.eventsHead}>Connections</div>
      <div className={styles.panel} data-testid="diag-connections">
        {rows === null ? (
          <div className={styles.empty}>Checking connections…</div>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>
            No hosts are registered on this device.
          </div>
        ) : (
          rows.map((row) => (
            <div
              className={styles.connRow}
              key={row.gatewayId}
              data-testid="diag-connection"
              data-gateway-id={row.gatewayId}
            >
              <span
                className={styles.dot}
                data-health={connectionHealth(row)}
              />
              <div className={styles.rowMeta}>
                <div className={styles.rowName}>
                  {row.gatewayLabel}
                  <span className={styles.connBadge}>{row.transportBadge}</span>
                  {row.isActive ? (
                    <span className={styles.connBadge}>Active</span>
                  ) : null}
                </div>
                <div className={styles.rowSub}>{connectionSummary(row)}</div>
              </div>
              <div className={styles.connActions}>
                <button
                  type="button"
                  className={controlsCss.chip}
                  onClick={() => onTest(row.gatewayId, row.gatewayLabel)}
                >
                  <Icon name="Wifi" size={12} />
                  Test connection
                </button>
                <button
                  type="button"
                  className={controlsCss.chip}
                  onClick={() => onRename(row.gatewayId, row.gatewayLabel)}
                >
                  <Icon name="Pencil" size={12} />
                  Rename
                </button>
                {row.canRemove ? (
                  <button
                    type="button"
                    className={cx(controlsCss.chip, controlsCss.chipDanger)}
                    onClick={() => onRemove(row.gatewayId, row.gatewayLabel)}
                  >
                    <Icon name="Trash" size={12} />
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

export default function SettingsDiagnosticsScreen({
  loadHealth,
  onJumpToLogs,
  connections,
}: SettingsDiagnosticsBridgeProps): JSX.Element {
  const [health, setHealth] = useState<GatewayHealthDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The mount read is already in flight when the first render happens, so the
  // busy flag starts true rather than being flipped from inside the effect.
  const [busy, setBusy] = useState(true);

  const load = useCallback((): void => {
    loadHealth()
      .then((snap) => {
        setHealth(snap);
        setError(null);
      })
      .catch((caughtError: unknown) =>
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        )
      )
      .finally(() => setBusy(false));
  }, [loadHealth]);

  /** The "Check again" button — the only path that re-arms the busy flag. */
  const refresh = useCallback((): void => {
    setBusy(true);
    load();
  }, [load]);

  useEffect(() => load(), [load]);

  if (error !== null) {
    return (
      <div className={styles.loadError}>
        Couldn’t reach the gateway: {error}
      </div>
    );
  }
  if (!health) {
    return <div className={styles.loading}>Checking gateway health…</div>;
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.overall} data-health={health.status}>
        <span className={styles.dot} data-health={health.status} />
        <div className={styles.overallMeta}>
          <div className={styles.overallTitle}>
            {STATUS_LABEL[health.status]}
          </div>
          <div className={styles.overallSub}>
            Gateway up {formatUptime(health.uptimeMs)} · since{" "}
            {new Date(health.startedAt).toLocaleString()}
          </div>
        </div>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
          disabled={busy}
          onClick={refresh}
        >
          <Icon name="Refresh" size={13} />
          <span>{busy ? "Checking…" : "Refresh"}</span>
        </button>
      </div>

      {health.metrics ? <MetricsPanel metrics={health.metrics} /> : null}

      <div className={styles.panel}>
        {health.components.length === 0 ? (
          <div className={styles.empty}>No components have reported yet.</div>
        ) : (
          health.components.map((row) => (
            <ComponentRow
              key={row.component}
              row={row}
              onJumpToLogs={onJumpToLogs}
            />
          ))
        )}
      </div>

      {connections ? <ConnectionsPanel {...connections} /> : null}

      <div className={styles.eventsHead}>Recent warnings &amp; errors</div>
      <div className={styles.panel}>
        {health.recentEvents.length === 0 ? (
          <div className={styles.empty}>
            Nothing logged since the gateway started.
          </div>
        ) : (
          health.recentEvents.map((ev, i) => (
            <div
              className={styles.eventRow}
              key={`${ev.at}-${i}`}
              data-testid="diag-event"
            >
              <span className={styles.eventTime}>{eventClock(ev.at)}</span>
              <span className={styles.eventLevel} data-level={ev.level}>
                {ev.level}
              </span>
              <span className={styles.eventComponent}>
                {componentLabel(ev.component)}
              </span>
              <span className={styles.eventMessage}>{ev.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
