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

// Gateway → Components: the owner surface over the gateway's
// component-level health (`GET /centraid/_gateway/health`). Uptime says
// the process answers; this says which subsystem stopped working — vaults,
// schedulers, outbox, connections — with each component's last error and
// the gateway's recent structured warn/error tail. Prop-driven like
// SettingsHarnessesScreen: this file owns the view + load/refresh state,
// the gateway I/O lives in `routes/settingsDiagnosticsData.ts`. Mounted from
// the Gateway page's Components drill-in (GatewayScreen.tsx), not Settings.
//
// BUILT FROM THE BLOCK KIT (binding layer v11) — NOT a page of its own
// furniture: a status bar with an inline Refresh, four uppercase metric tiles,
// one bespoke row per component carrying a coloured dot AND an uppercase
// HEALTHY/DEGRADED badge, two uppercase `<div>` sub-heads over two more bespoke
// panels. That way six components read as six shouted words, with the actual
// sentence — WHAT stopped, and WHEN — set smaller than the badge.
//
// In v11 the page is the same four statements said in the shared vocabulary:
// the count and the Refresh verb are the SECTION HEAD, the gateway's coarse
// figures are a fact panel, every component is a row whose meta is its status
// in lower case, and the two sub-lists get real heads. The dot is gone — a
// row that says "degraded" in its meta and carries `net` does not also need a
// colour swatch to say it a third time.
//
// The drill-ins repeat at the foot, as the prototype has them: a member who
// got here from an alert should not have to go back to the overview to read
// the lines that alert came from.

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

/** Coarse numeric signals from the gateway health snapshot (#521). */
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
   * Structured resource contract (#528) — host facts, class,
   * mode, and the resolved knobs the profile derived. Present on modern
   * gateways only; the Resource card's L1/L2 disclosure gates on it.
   */
  resourceProfile?: ResourceProfileDTO;
  /**
   * Background-work pause state (#528). Present on modern
   * gateways only; absent hides the Resource card's pause control.
   */
  backgroundPause?: BackgroundPauseDTO;
  /**
   * Power-context posture (#528) — the gateway host's battery /
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
 * Host plumbing, the one place it is allowed to be visible (#665).
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
  onTest?: (gatewayId: string, label: string) => void;
  onRename?: (gatewayId: string, label: string) => void;
  onRemove?: (gatewayId: string, label: string) => void;
}

export interface SettingsDiagnosticsBridgeProps {
  loadHealth: () => Promise<GatewayHealthDTO>;
  /** Jump into the Logs drill-in, focused on this component's lines — omitted
   *  when the caller has nowhere to send the click (only wired from the
   *  Gateway page, where Logs is a sibling drill-in). */
  onJumpToLogs?: (component: string) => void;
  /** Open the Alert history drill-in — the second half of the foot rows. */
  onOpenAlerts?: () => void;
  /** Host plumbing. Absent on hosts with no gateway registry. */
  connections?: DiagnosticsConnectionsProps;
}

/** The row's own meta word. LOWER CASE, like every other meta in the kit: the
 *  status is a fact about the row, not a badge shouting over its name. */
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

/** One component as a row. The sub-line reads the most useful thing per state:
 *  a failing component shows its LAST ERROR (the actionable bit); a healthy one
 *  shows its probe detail ("2 vaults mounted") or last-ok recency. */
function componentRow(
  row: HealthComponentDTO,
  onJumpToLogs?: (component: string) => void
): RowDef {
  const detail =
    row.status === "ok"
      ? (row.detail ??
        (row.lastOkAt ? `last ok ${relativeTime(row.lastOkAt)}` : undefined))
      : (row.lastError ?? row.detail);
  // The error tally belongs in the sentence, not in a cell of its own: "12
  // errors since it last answered" is a reading; "12 errs" beside a badge is a
  // number the reader has to assemble a meaning for.
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

/** The gateway's coarse figures, as facts rather than as a tile grid. */
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

/** Reachability as the row's own word — a still-probing host has no verdict
 *  yet, so it says so rather than borrowing a healthy one. */
function connectionWord(row: GatewayRow): string {
  const rail = railStatus(row);
  if (rail === "ready") return "reachable";
  if (rail === "error") return "unreachable";
  return "checking";
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

  // THREE ACTS, so they go UNDER the row rather than into its one trailing
  // slot (`RowDef.children`). Prove it works, relabel it, stop talking to it —
  // rare and deliberate, and each one is about this host in particular, so
  // none of them can be promoted to a section verb without losing its subject.
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

  const troubled = health.components.filter((row) => row.status !== "ok");
  // The head answers the page's own question before a single row is read.
  const componentsMeta =
    health.components.length === 0
      ? "none reporting"
      : troubled.length === 0
        ? `${health.components.length} · all answering`
        : `${health.components.length} · ${troubled.length} in trouble`;

  // The two drill-ins repeat at the foot, as the prototype has them. The Logs
  // row names the component it will focus on, because a link that says "Logs"
  // and lands on an unfiltered stream has not taken the reader anywhere.
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
