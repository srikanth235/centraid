/**
 * AutomationHost adapter on top of openclaw's gateway cron service.
 *
 * The plugin used to call `upsertCronJob` / `removeCronJob` /
 * `reconcileAutomationCron` directly from `index.ts`. Those helpers
 * stay as the low-level wire layer (they speak `cron.add` /
 * `cron.update` / `cron.remove` / `cron.list` against the gateway
 * RPC), but every caller now goes through this `AutomationHost`
 * implementation — same shape the local desktop's `OsSchedulerHost`
 * implements. That way "user toggled / deleted an automation" hits
 * one interface regardless of which backend is wired up.
 *
 * Disabled rows: openclaw's cron service does have a "registered but
 * suppressed" state (the `enabled: false` field in the cron payload),
 * so `register` keeps the entry even when `row.enabled === false`.
 * That's the opposite of the OS scheduler host, which collapses
 * disabled to unregister — both behaviors are valid per the
 * `AutomationHost` contract.
 */

import type {
  AutomationHost,
  AutomationReconcileResult,
  AutomationRow,
} from '@centraid/runtime-core';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import {
  cronNameFor,
  listCentraidCronJobs,
  removeCronJob,
  upsertCronJob,
  payloadFor,
} from './automations-cron.js';

export class OpenclawAutomationHost implements AutomationHost {
  async register(row: AutomationRow): Promise<void> {
    // `upsertCronJob` already issues add-or-update + carries
    // `row.enabled` through to the openclaw payload, so disabled
    // rows produce a suppressed-but-registered entry rather than no
    // entry at all.
    await upsertCronJob(row);
  }

  async unregister(automationId: string): Promise<void> {
    await removeCronJob(automationId);
  }

  async list(): Promise<readonly string[]> {
    return listCentraidCronJobs();
  }

  async reconcile(desired: ReadonlyArray<AutomationRow>): Promise<AutomationReconcileResult> {
    const desiredByCronName = new Map<string, AutomationRow>();
    for (const row of desired) {
      desiredByCronName.set(cronNameFor(row.id), row);
    }

    const actualNames = new Set(await listCentraidCronJobs());

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // Re-issue `cron.update` for entries on both sides — covers the
    // case where the mirror absorbed an enabled toggle or schedule
    // change while the plugin was offline. Idempotent server-side.
    for (const [cronName, row] of desiredByCronName) {
      if (actualNames.has(cronName)) {
        await callGatewayTool('cron.update', {}, payloadFor(row));
        updated.push(cronName);
      } else {
        await callGatewayTool('cron.add', {}, payloadFor(row));
        added.push(cronName);
      }
    }
    for (const cronName of actualNames) {
      if (!desiredByCronName.has(cronName)) {
        await callGatewayTool('cron.remove', {}, { name: cronName });
        removed.push(cronName);
      }
    }

    return { added, updated, removed };
  }
}
