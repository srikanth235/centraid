// Two read-only mirrors over the same gateway base. Health is gateway-wide
// (host bearer only, never a vault header). Insights are vault-scoped
// (`apiHeaders`). Shapes live here because mobile does not depend on the
// gateway package — source: health-registry.ts / screen-contracts.ts.

import {
  formatBytes as sharedFormatBytes,
  formatRelativeTime,
} from "@centraid/design";

import {
  apiHeaders,
  authHeader,
  fetchJson,
  requireGatewayBase,
} from "./gateway";

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

export interface InsightsKpis {
  totalTokens: number;
  hydrationTokens: number;
  /** Floor while `unpricedRuns` > 0. */
  totalCostUsd: number;
  harnessReportedCostUsd: number;
  estimatedCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  /** Window-wide only — the daily rollup has no per-day outcome split. */
  failedRuns: number;
  failedCostUsd: number;
  appsTouched: number;
  /** Not on the gateway rollup. Do not read until a gateway sends one. */
  quotaTokens: number;
  unpricedRuns: number;
  unreportedRuns: number;
}

/** Counts runs, not outcomes — no per-day failure split exists. */
export interface InsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}

export interface InsightsSourceRow {
  key: string;
  label: string;
  kind: string;
  runs: number;
  tokens: number;
  costUsd: number;
  automationName?: string;
}

export interface InsightsAttention {
  kind: "top_source";
  key: string;
  label: string;
  kindLabel: string;
  share: number;
  costUsd: number;
}

export interface InsightsHarnessRow {
  harness: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsModelRow {
  model: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsPeakDay {
  date: string;
  tokens: number;
  costUsd: number;
  topSources: Array<{
    key: string;
    label: string;
    kind: string;
    tokens: number;
    costUsd: number;
  }>;
}

export interface InsightsEffortRow {
  effort: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface InsightsActivityRow {
  runId: string;
  kind: string;
  label: string;
  automationRef?: string;
  automationName?: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  hydrationTokens: number;
  costUsd: number;
  harness?: string;
  model?: string;
  effort?: string;
}

export interface InsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: InsightsKpis;
  daily: InsightsDailyPoint[];
  bySource: InsightsSourceRow[];
  byHarness: InsightsHarnessRow[];
  byModel: InsightsModelRow[];
  byEffort: InsightsEffortRow[];
  recent: InsightsActivityRow[];
  peakDay?: InsightsPeakDay;
  attention?: InsightsAttention;
}

export async function fetchGatewayHealth(): Promise<GatewayHealth> {
  const base = await requireGatewayBase();
  return fetchJson<GatewayHealth>(`${base}/centraid/_gateway/health`, {
    headers: authHeader(),
    method: "GET",
  });
}

export async function fetchInsightsSummary(
  windowDays = 30
): Promise<InsightsSummary> {
  const base = await requireGatewayBase();
  return fetchJson<InsightsSummary>(
    `${base}/centraid/_insights/summary?windowDays=${encodeURIComponent(String(windowDays))}`,
    { headers: apiHeaders(), method: "GET" }
  );
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function formatBytes(n: number): string {
  return sharedFormatBytes(n);
}

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function relativeTime(when: number | string): string {
  const then = typeof when === "number" ? when : Date.parse(when);
  return formatRelativeTime(Number.isFinite(then) ? then : undefined);
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/u, "");
}
