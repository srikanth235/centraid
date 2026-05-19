/**
 * Openclaw cron registration + reconciliation for centraid automations.
 *
 * Cron registration goes through `callGatewayTool("cron.add", ...)`
 * rather than the plugin-cron API (`PluginHookGatewayCronService.add`)
 * because the latter only accepts `payload: { kind: "systemEvent" }`
 * — we need `kind: "agentTurn"` to ride the standard isolated-agent
 * pipeline. The gateway-rpc method has no such restriction.
 *
 * See issue #70 § Why this isn't Option A and § Cron job registration
 * for the design rationale.
 *
 * Reconciliation: on `gateway_start`, diff centraid's `automations`
 * SQLite mirror against openclaw's `cron.list` output. Three classes
 * of fix-up:
 *   - DB has it, cron doesn't  → register
 *   - cron has it, DB doesn't  → remove (zombie from a deleted app)
 *   - both have it, mismatched → update
 *
 * Cron names follow `centraid:<appId>:<name>` so the diff is a
 * straightforward set operation.
 */

import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import type { AutomationRow } from '@centraid/runtime-core';
import { CENTRAID_MOCK_MODEL_ID, CENTRAID_MOCK_PROVIDER_ID } from './automations-provider.js';

/** Prefix every centraid-owned cron job's name so reconciliation can identify them. */
const CRON_PREFIX = 'centraid';

export function cronNameFor(appId: string, automationName: string): string {
  return `${CRON_PREFIX}:${appId}:${automationName}`;
}

interface CronJobLite {
  name: string;
  enabled?: boolean;
}

interface CronAddPayload {
  name: string;
  enabled: boolean;
  schedule: { kind: 'cron'; expr: string; tz?: string };
  sessionTarget: 'isolated';
  wakeMode: 'now';
  payload: {
    kind: 'agentTurn';
    message: string;
    model: string;
    toolsAllow?: readonly string[];
    timeoutSeconds: number;
    lightContext: true;
  };
}

export function payloadFor(row: AutomationRow): CronAddPayload {
  return {
    name: cronNameFor(row.appId, row.name),
    enabled: row.enabled,
    schedule: { kind: 'cron', expr: row.cronExpr },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: `<<<centraid:${row.appId}:${row.name}>>>`,
      model: `${CENTRAID_MOCK_PROVIDER_ID}/${CENTRAID_MOCK_MODEL_ID}`,
      ...(row.manifest.requires.tools ? { toolsAllow: row.manifest.requires.tools } : {}),
      timeoutSeconds: 300,
      lightContext: true,
    },
  };
}

/**
 * Register or update one automation's cron job. Idempotent: tries
 * `cron.add` first; if openclaw reports the job already exists,
 * falls back to `cron.update`.
 */
export async function upsertCronJob(row: AutomationRow): Promise<void> {
  const payload = payloadFor(row);
  try {
    await callGatewayTool('cron.add', {}, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists|duplicate/i.test(msg)) {
      await callGatewayTool('cron.update', {}, payload);
      return;
    }
    throw err;
  }
}

export async function removeCronJob(appId: string, name: string): Promise<void> {
  const cronName = cronNameFor(appId, name);
  try {
    await callGatewayTool('cron.remove', {}, { name: cronName });
  } catch (err) {
    // Tolerate "not found" — happens when the user deleted the
    // openclaw cron job manually between centraid registration and
    // teardown.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|no such/i.test(msg)) throw err;
  }
}

export async function listCentraidCronJobs(): Promise<string[]> {
  const result = await callGatewayTool<{ jobs?: CronJobLite[] }>(
    'cron.list',
    {},
    {
      includeDisabled: true,
    },
  );
  const jobs = result.jobs ?? [];
  return jobs.map((j) => j.name).filter((n) => n.startsWith(`${CRON_PREFIX}:`));
}

// `reconcileAutomationCron(store)` lived here in the original
// issue-#70 implementation. The replacement is
// `OpenclawAutomationHost.reconcile(rows)` — same diff algorithm,
// but the rows are passed in by the caller (matching the
// `AutomationHost` contract shared with the local OS scheduler).
// Callers that want "everything" pass `store.listAll()`; per-app
// sync hooks pass `store.listByApp(appId)`.
