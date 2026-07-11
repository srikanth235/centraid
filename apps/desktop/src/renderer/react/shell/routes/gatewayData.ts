// Pure data helpers for the Gateway runtime page — snapshot → screen DTOs,
// duration/clock formatting, and the alert-threshold preset ladder. Kept
// separate from the route (approvalsData.ts pattern) so it unit-tests
// without a live shell or IPC bridge.

/** The wire snapshot the main-process monitor pushes (gateway-monitor.ts). */
export type GatewayRuntimeSnapshot = Awaited<
  ReturnType<typeof window.CentraidApi.getGatewayRuntime>
>;

export interface OutageRowDTO {
  id: string;
  startedLabel: string;
  durationLabel: string;
  ongoing: boolean;
  /** The OS down-alert fired for this outage. */
  alerted: boolean;
}

/** Compact human duration — `47s`, `3m 20s`, `2h 05m`, `1d 4h`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Ticking uptime figure — always carries seconds below a day so the counter
 *  visibly runs (`2h 14m 05s`), collapsing to `3d 02h` beyond. */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  if (d > 0) return `${d}d ${String(Math.floor((s % 86_400) / 3600)).padStart(2, '0')}h`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Wall-clock label for an epoch-ms instant — `Jul 11, 14:32:05`. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${mon} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `now`-relative label — `just now`, `3s ago`, `2m ago`. */
export function formatAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Session availability as a percentage of heartbeats answered, or
 *  `undefined` before the first probe lands. */
export function availabilityPct(snapshot: {
  checksTotal: number;
  checksFailed: number;
}): number | undefined {
  if (snapshot.checksTotal === 0) return undefined;
  return ((snapshot.checksTotal - snapshot.checksFailed) / snapshot.checksTotal) * 100;
}

/** Outage log rows, newest first. Ongoing outages tick against `now`. */
export function buildOutageRows(snapshot: GatewayRuntimeSnapshot, now: number): OutageRowDTO[] {
  return snapshot.outages.toReversed().map((o): OutageRowDTO => {
    const ongoing = o.endedAt === undefined;
    return {
      id: `outage-${o.startedAt}`,
      startedLabel: formatClock(o.startedAt),
      durationLabel: formatDuration((ongoing ? now : o.endedAt ?? now) - o.startedAt),
      ongoing,
      alerted: o.alertedAt !== undefined,
    };
  });
}

/** The threshold ladder the alert card renders. 120s is the shipped default. */
export const ALERT_PRESETS: readonly { seconds: number; label: string }[] = [
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
  { seconds: 120, label: '2m' },
  { seconds: 300, label: '5m' },
  { seconds: 900, label: '15m' },
  { seconds: 1800, label: '30m' },
];

/** Short chip label for a threshold that isn't on the preset ladder. */
export function thresholdLabel(seconds: number): string {
  const preset = ALERT_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}
