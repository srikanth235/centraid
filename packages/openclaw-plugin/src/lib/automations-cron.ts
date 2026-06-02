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
 * Cron names follow `centraid:<appId>/<automationId>` (the automation's
 * globally-unique handle) so the diff is a straightforward set
 * operation and stays unique across apps.
 */

import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { cronTriggersOf, type AutomationRow } from '@centraid/automation-engine';
import { CENTRAID_MOCK_MODEL_ID, CENTRAID_MOCK_PROVIDER_ID } from './automations-provider.js';

/** Prefix every centraid-owned cron job's name so reconciliation can identify them. */
const CRON_PREFIX = 'centraid';

/**
 * Base cron-job name for an automation handle — also the name of its
 * first (or only) cron trigger.
 */
export function cronNameFor(automationRef: string): string {
  return `${CRON_PREFIX}:${automationRef}`;
}

/**
 * Cron-job name for the Nth cron trigger of an automation. Index 0 is
 * the bare `centraid:<ref>`; later triggers get a `:<n>` suffix so a
 * multi-cron automation maps to several distinctly-named cron jobs.
 * Neither an app id nor an automation id contains `:`, so the boundary
 * is unambiguous.
 */
function cronNameAt(automationRef: string, index: number): string {
  return index === 0 ? cronNameFor(automationRef) : `${cronNameFor(automationRef)}:${index}`;
}

/** True when `name` is a centraid cron job belonging to `automationRef`. */
function cronNameBelongsTo(name: string, automationRef: string): boolean {
  const base = cronNameFor(automationRef);
  return name === base || name.startsWith(`${base}:`);
}

interface CronJobLite {
  name: string;
  enabled?: boolean;
}

export interface CronAddPayload {
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

function payloadFor(row: AutomationRow, name: string, expr: string): CronAddPayload {
  return {
    name,
    enabled: row.enabled,
    schedule: { kind: 'cron', expr },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: `<<<centraid:${row.ref}>>>`,
      model: `${CENTRAID_MOCK_PROVIDER_ID}/${CENTRAID_MOCK_MODEL_ID}`,
      ...(row.manifest.requires.tools ? { toolsAllow: row.manifest.requires.tools } : {}),
      timeoutSeconds: 300,
      lightContext: true,
    },
  };
}

/**
 * The cron-job payloads an automation should have on the gateway — one
 * per cron trigger. Webhook triggers produce no cron job (they ride the
 * `/_centraid-hook` HTTP route instead).
 */
export function desiredCronJobs(row: AutomationRow): Map<string, CronAddPayload> {
  const out = new Map<string, CronAddPayload>();
  cronTriggersOf(row.triggers).forEach((t, i) => {
    const name = cronNameAt(row.ref, i);
    out.set(name, payloadFor(row, name, t.expr));
  });
  return out;
}

async function upsertCronPayload(payload: CronAddPayload): Promise<void> {
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

async function removeCronByName(name: string): Promise<void> {
  try {
    await callGatewayTool('cron.remove', {}, { name });
  } catch (err) {
    // Tolerate "not found" — happens when the user deleted the
    // openclaw cron job manually between centraid registration and
    // teardown.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|no such/i.test(msg)) throw err;
  }
}

/**
 * Register or update an automation's cron jobs — one per cron trigger.
 * Idempotent (`cron.add`, falling back to `cron.update`). Also drops any
 * cron job left over from a previous, longer trigger list.
 */
export async function upsertCronJob(row: AutomationRow): Promise<void> {
  const desired = desiredCronJobs(row);
  for (const payload of desired.values()) {
    await upsertCronPayload(payload);
  }
  for (const name of await listCentraidCronJobs()) {
    if (cronNameBelongsTo(name, row.ref) && !desired.has(name)) {
      await removeCronByName(name);
    }
  }
}

/** Remove every cron job belonging to an automation handle. */
export async function removeCronJob(automationRef: string): Promise<void> {
  const own = (await listCentraidCronJobs()).filter((n) => cronNameBelongsTo(n, automationRef));
  // The base name may not appear in `cron.list` if the job was never
  // registered; remove it explicitly so teardown stays idempotent.
  for (const name of new Set([cronNameFor(automationRef), ...own])) {
    await removeCronByName(name);
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
// Callers pass `store.listAll()` — model-B reconcile is always global.
