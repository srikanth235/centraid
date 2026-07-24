// Mobile insights + gateway-metrics client. Two read-only surfaces the phone
// mirrors from the gateway, both over the same base (paired tunnel / manual dev
// URL) the rest of the app uses:
//
//   • gateway health — GET /centraid/_gateway/health → HealthSnapshot: per-
//     subsystem status, a warn/error tail, and coarse numeric metrics (rss,
//     outbox depth, event-loop lag, fsync). Gateway-WIDE, so it carries only the
//     host bearer (authHeader), never a vault header.
//   • usage insights — GET /centraid/_insights/summary?windowDays= →
//     InsightsSummary: token/cost KPIs, a daily series, per-model usage, and a
//     recent-activity tail. Vault-SCOPED, so it uses apiHeaders (auth + the
//     active vault) and follows the Spaces switcher's selection.
//
// Mobile doesn't depend on the gateway package, so the wire shapes are mirrored
// here as lean local interfaces (exactly as lib/gateway + lib/automations do).
// Source of truth: packages/gateway/src/serve/health-registry.ts (HealthSnapshot)
// and packages/client/src/react/screen-contracts.ts (InsightsSummary).

import { apiHeaders, authHeader, fetchJson, requireGatewayBase } from './gateway';

// --- Gateway health (mirrors HealthSnapshot / ComponentHealth / HealthMetrics) ---

export type ComponentStatus = 'ok' | 'degraded' | 'error';

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
  level: 'warn' | 'error';
  message: string;
}

export interface HealthMetrics {
  rssBytes: number;
  outboxPending: number;
  sseClients?: number;
  eventLoopLagP50Ms?: number;
  eventLoopLagP99Ms?: number;
  eventLoopLagMaxMs?: number;
  eventLoopLagPeakP99Ms?: number;
  storageFsyncMs?: number;
  uptimeMs: number;
}

export interface GatewayHealth {
  status: ComponentStatus;
  startedAt: string;
  uptimeMs: number;
  components: ComponentHealth[];
  recentEvents: HealthEvent[];
  metrics: HealthMetrics;
}

// --- Usage insights (mirrors InsightsSummary & friends) ---

export interface InsightsKpis {
  totalTokens: number;
  totalCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  appsTouched: number;
  quotaTokens: number;
  unpricedRuns: number;
}

export interface InsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface InsightsModelRow {
  model: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  byModel: InsightsModelRow[];
  recent: InsightsActivityRow[];
}

/** Gateway-wide component health + coarse metrics. Host-bearer only, no vault. */
export async function fetchGatewayHealth(): Promise<GatewayHealth> {
  const base = await requireGatewayBase();
  return fetchJson<GatewayHealth>(`${base}/centraid/_gateway/health`, {
    headers: authHeader(),
    method: 'GET',
  });
}

/** Usage analytics for the active vault over the last `windowDays` (default 30). */
export async function fetchInsightsSummary(windowDays = 30): Promise<InsightsSummary> {
  const base = await requireGatewayBase();
  return fetchJson<InsightsSummary>(
    `${base}/centraid/_insights/summary?windowDays=${encodeURIComponent(String(windowDays))}`,
    { headers: apiHeaders(), method: 'GET' },
  );
}

// --- Formatting (lean ports of packages/client/src/react/format.ts) ---

/** Compact token/count: 1.2k, 3.4M, 987. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}

/** USD to at most cents, with a leading $. Sub-cent nonzero shows "<$0.01". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/** RSS/byte size in the largest sensible unit. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${trim(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Coarse uptime: "3d 4h", "5h 12m", or "12m". */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

/** Milliseconds rounded for display: "0.8 ms" / "42 ms". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" from an epoch-ms or ISO time. */
export function relativeTime(when: number | string): string {
  const then = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function trim(n: number): string {
  // One decimal, but drop a trailing ".0" so 3.0k reads as 3k.
  return n.toFixed(1).replace(/\.0$/, '');
}
