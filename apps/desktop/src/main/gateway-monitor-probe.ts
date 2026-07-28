import type { GatewayComponentIssue, GatewayProbe } from './gateway-monitor-core.js';

const PROBE_TIMEOUT_MS = 4000;
const HEALTH_PATH = '/centraid/_gateway/health';
const INFO_PATH = '/centraid/_gateway/info';

/** Probe a legacy gateway's liveness endpoint when it has no health endpoint. */
async function probeInfo(baseUrl: string, token: string | undefined): Promise<GatewayProbe> {
  const startedAt = Date.now();
  try {
    const res = await fetch(new URL(INFO_PATH, `${baseUrl}/`).toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const at = Date.now();
    if (!res.ok) return { at, ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      at,
      ok: true,
      latencyMs: at - startedAt,
      ...(typeof body.startedAt === 'number' ? { gatewayStartedAt: body.startedAt } : {}),
      ...(typeof body.uptimeMs === 'number' ? { gatewayUptimeMs: body.uptimeMs } : {}),
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      ...(typeof body.schemaEpoch === 'number' ? { schemaEpoch: body.schemaEpoch } : {}),
    };
  } catch (error) {
    return {
      at: Date.now(),
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractComponentIssues(body: Record<string, unknown>): GatewayComponentIssue[] {
  const raw = Array.isArray(body.components) ? body.components : [];
  const issues: GatewayComponentIssue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.status !== 'degraded' && record.status !== 'error') continue;
    if (typeof record.component !== 'string') continue;
    const message =
      typeof record.lastError === 'string'
        ? record.lastError
        : typeof record.detail === 'string'
          ? record.detail
          : undefined;
    issues.push({
      component: record.component,
      status: record.status,
      ...(message ? { message } : {}),
    });
  }
  return issues;
}

/** Probe component health, falling back to the legacy liveness endpoint on 404. */
export async function probeGateway(
  baseUrl: string,
  token: string | undefined,
): Promise<GatewayProbe> {
  const startedAt = Date.now();
  try {
    const res = await fetch(new URL(HEALTH_PATH, `${baseUrl}/`).toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) return probeInfo(baseUrl, token);
    const at = Date.now();
    if (!res.ok) return { at, ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const healthStatus =
      body.status === 'ok' || body.status === 'degraded' || body.status === 'error'
        ? body.status
        : undefined;
    return {
      at,
      ok: true,
      latencyMs: at - startedAt,
      ...(healthStatus ? { healthStatus } : {}),
      componentIssues: extractComponentIssues(body),
      ...(typeof body.startedAt === 'string' && !Number.isNaN(Date.parse(body.startedAt))
        ? { gatewayStartedAt: Date.parse(body.startedAt) }
        : {}),
      ...(typeof body.uptimeMs === 'number' ? { gatewayUptimeMs: body.uptimeMs } : {}),
    };
  } catch (error) {
    return {
      at: Date.now(),
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
