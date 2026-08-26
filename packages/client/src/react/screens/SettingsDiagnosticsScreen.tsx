import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { relativeTime } from "../format.js";
import { gatewayStatusCopy, railStatus } from "../shell/gatewayRegistry.js";
import type { GatewayRow } from "../shell/gatewayRegistry.js";
import { cx } from "../ui/cx.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import { Icon } from "../ui/index.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import type {
  BackgroundPauseDTO,
  PowerContextState,
  ResourceProfileDTO,
} from "./resource-summary.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./SettingsDiagnosticsScreen.module.css";

// Gateway → Components: which subsystem stopped working, with its last error
// and the gateway's warn/error tail. Prop-driven — the view and refresh state
// live here, the gateway I/O in `routes/settingsDiagnosticsData.ts`.
//
// BUILT FROM THE BLOCK KIT, never its own furniture: status is a row's lower-case
// meta plus `net`, so no badge or colour dot may say it a second time.

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
  /** Modern gateways only; the Resource card's disclosure gates on it (#528). */
  resourceProfile?: ResourceProfileDTO;
  /** Absent hides the Resource card's pause control (#528). */
  backgroundPause?: BackgroundPauseDTO;
  /** Drives the Resource card's posture note; modern gateways only (#528). */
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

/** The one place host plumbing may be visible (#665); omitted drops the section. */
export interface DiagnosticsConnectionsProps {
  /** Resolves with cached rows to paint now, then calls `onUpdate` per probe. */
  loadConnections: (
    onUpdate: (rows: GatewayRow[]) => void
  ) => Promise<GatewayRow[]>;
  /** Bumped on a committed rename/remove so the list re-reads. */
  refreshKey?: number;
  onTest?: (gatewayId: string, label: string) => void;
  onRename?: (gatewayId: string, label: string) => void;
  onRemove?: (gatewayId: string, label: string) => void;
}

export interface SettingsDiagnosticsBridgeProps {
  loadHealth: () => Promise<GatewayHealthDTO>;
  /** Omitted when the caller has nowhere to send the click. */
  onJumpToLogs?: (component: string) => void;
  onOpenAlerts?: () => void;
  connections?: DiagnosticsConnectionsProps;
}

/** Lower case, like every meta in the kit — a fact, not a badge. */
const STATUS_WORD: Record<HealthStatus, string> = {
  ok: "healthy",
  degraded: "degraded",
  error: "failing",
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
  // The component namespace is the GATEWAY's: stays `backups`, not `storage`.
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

/** The sub-line carries the actionable thing: last error, else probe detail. */
function componentRow(
  row: HealthComponentDTO,
  onJumpToLogs?: (component: string) => void
): RowDef {
  const detail =
    row.status === "ok"
      ? (row.detail ??
        (row.lastOkAt ? `last ok ${relativeTime(row.lastOkAt)}` : undefined))
      : (row.lastError ?? row.detail);
  // The tally belongs in the sentence, never in a cell of its own.
  const tally =
    row.errorCount > 0
      ? `${row.errorCount} error${row.errorCount === 1 ? "" : "s"} since the gateway started`
      : undefined;
  const sub = [detail, tally].filter(Boolean).join(" · ");
  return {
    id: `component-${row.component}`,
    meta: STATUS_WORD[row.status],
    title: componentLabel(row.component),
    ...(sub ? { sub } : {}),
    ...(row.status === "ok" ? {} : { net: true }),
    ...(row.status !== "ok" && onJumpToLogs
      ? {
          action: {
            hint: "The stream, filtered to this component",
            label: "Logs",
            onClick: () => onJumpToLogs(row.component),
          },
        }
      : {}),
  };
}

function metricFacts(metrics: HealthMetricsDTO): PanelFact[] {
  return [
    { key: "up for", mono: true, value: formatUptime(metrics.uptimeMs) },
    { key: "memory", mono: true, value: formatRss(metrics.rssBytes) },
    {
      key: "event-loop lag",
      mono: true,
      value:
        metrics.eventLoopLagP99Ms === undefined
          ? "——"
          : `p99 ${metrics.eventLoopLagP99Ms.toFixed(1)} ms`,
    },
    {
      key: "storage fsync",
      mono: true,
      value:
        metrics.storageFsyncMs === undefined
          ? "——"
          : `${metrics.storageFsyncMs.toFixed(1)} ms`,
    },
    {
      key: "resource mode",
      mono: true,
      value: `${resourceModeWord(metrics.resourceMode)} · ${hardwareClassWord(
        metrics.hardwareProfileClass
      ).toLowerCase()}`,
    },
  ];
}

/** A still-probing host must not borrow a healthy verdict. */
function connectionWord(row: GatewayRow): string {
  const rail = railStatus(row);
  if (rail === "ready") return "reachable";
  if (rail === "error") return "unreachable";
  return "checking";
}

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

  // Three acts, each about this host in particular: they go under the row and
  // none can be promoted to a section verb without losing its subject.
  const rowsFor = (list: GatewayRow[]): RowDef[] =>
    list.map((row) => ({
      id: row.gatewayId,
      meta: connectionWord(row),
      sub: connectionSummary(row),
      title: `${row.gatewayLabel} · ${row.transportBadge}${row.isActive ? " · active" : ""}`,
      ...(railStatus(row) === "error" ? { net: true } : {}),
      ...(onTest || onRename || onRemove
        ? {
            children: (
              <div className={styles.connActions}>
                {onTest ? (
                  <button
                    type="button"
                    className={controlsCss.chip}
                    onClick={() => onTest(row.gatewayId, row.gatewayLabel)}
                  >
                    <Icon name="Wifi" size={12} />
                    Test connection
                  </button>
                ) : null}
                {onRename ? (
                  <button
                    type="button"
                    className={controlsCss.chip}
                    onClick={() => onRename(row.gatewayId, row.gatewayLabel)}
                  >
                    <Icon name="Pencil" size={12} />
                    Rename
                  </button>
                ) : null}
                {row.canRemove && onRemove ? (
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
            ),
          }
        : {}),
    }));

  return (
    <>
      <SectionBlock
        label="Connections"
        meta={
          rows === null
            ? "checking"
            : `${rows.length} host${rows.length === 1 ? "" : "s"}`
        }
      />
      {rows === null ? (
        <EmptyBlock
          routine
          title="Checking connections…"
          body="Asking each registered host whether it answers."
        />
      ) : rows.length === 0 ? (
        <EmptyBlock
          routine
          title="No hosts are registered on this device."
          body="A host is added when you pair with one; this device has paired with none."
        />
      ) : (
        <div data-testid="diag-connections">
          <RowsBlock ariaLabel="Connections" rows={rowsFor(rows)} />
        </div>
      )}
    </>
  );
}

export default function SettingsDiagnosticsScreen({
  loadHealth,
  onJumpToLogs,
  onOpenAlerts,
  connections,
}: SettingsDiagnosticsBridgeProps): JSX.Element {
  const [health, setHealth] = useState<GatewayHealthDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The mount read is already in flight at first render, so busy starts true.
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

  const troubled = health.components.filter((row) => row.status !== "ok");
  const componentsMeta =
    health.components.length === 0
      ? "none reporting"
      : troubled.length === 0
        ? `${health.components.length} · all answering`
        : `${health.components.length} · ${troubled.length} in trouble`;

  // The Logs row names the component it focuses on: a bare "Logs" landing on
  // an unfiltered stream takes the reader nowhere.
  const firstTroubled = troubled[0];
  const foot: RowDef[] = [];
  if (onJumpToLogs)
    foot.push({
      action: {
        label: "Open",
        onClick: () => onJumpToLogs(firstTroubled?.component ?? ""),
      },
      id: "foot-logs",
      sub: firstTroubled
        ? `the stream, filtered to ${componentLabel(firstTroubled.component)}`
        : "the stream, with a focus query",
      title: firstTroubled
        ? `Logs for ${componentLabel(firstTroubled.component)}`
        : "Logs",
    });
  if (onOpenAlerts)
    foot.push({
      action: { label: "Open", onClick: onOpenAlerts },
      id: "foot-alerts",
      sub: "every alert this gateway has raised, and what cleared it",
      title: "Alert history",
    });

  return (
    <div className={styles.wrap}>
      <SectionBlock
        action={{
          hint: "Ask every component again",
          label: busy ? "Checking…" : "Refresh",
          onClick: refresh,
          ...(busy ? { off: true } : {}),
        }}
        label="Components"
        meta={componentsMeta}
      />

      {health.metrics ? (
        <div data-testid="diag-metrics">
          <PanelBlock
            eyebrow="This gateway"
            facts={metricFacts(health.metrics)}
            wide
          />
        </div>
      ) : null}

      {health.components.length === 0 ? (
        <EmptyBlock
          routine
          title="No components have reported yet."
          body="The health probe has answered, but no subsystem has said anything about itself."
        />
      ) : (
        <div data-testid="diag-components">
          <RowsBlock
            ariaLabel="Components"
            rows={health.components.map((row) =>
              componentRow(row, onJumpToLogs)
            )}
          />
        </div>
      )}

      <NoteBlock>
        A component is a subsystem of the gateway, not an app. Nothing on this
        page can touch your records — the worst it can do is ask a subsystem to
        start again.
      </NoteBlock>

      {connections ? <ConnectionsPanel {...connections} /> : null}

      <SectionBlock
        label="Recent warnings"
        meta={
          health.recentEvents.length === 0
            ? "nothing logged"
            : `${health.recentEvents.length} since the gateway started`
        }
      />
      {health.recentEvents.length === 0 ? (
        <EmptyBlock
          routine
          title="Nothing logged since the gateway started."
          body="Warnings and errors land here as they happen; an empty list is the good outcome."
        />
      ) : (
        <RowsBlock
          ariaLabel="Recent warnings"
          rows={health.recentEvents.map((ev, i) => ({
            id: `event-${ev.at}-${i}`,
            meta: ev.level,
            sub: ev.message,
            title: `${eventClock(ev.at)} · ${componentLabel(ev.component)}`,
            ...(ev.level === "error" ? { net: true } : {}),
          }))}
        />
      )}

      {foot.length > 0 ? (
        <RowsBlock ariaLabel="Look closer" rows={foot} />
      ) : null}
    </div>
  );
}
