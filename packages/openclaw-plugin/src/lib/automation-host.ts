/**
 * AutomationHost adapter on top of openclaw's gateway cron service.
 *
 * The plugin used to call `upsertCronJob` / `removeCronJob` /
 * `reconcileAutomationCron` directly from `index.ts`. Those helpers
 * stay as the low-level wire layer (they speak `cron.add` /
 * `cron.update` / `cron.remove` / `cron.list` against the gateway
 * RPC), but every caller now goes through this `AutomationHost`
 * implementation — same shape the local gateway's in-process `InProcessScheduler`
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
} from '@centraid/automation';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import {
  desiredCronJobs,
  listCentraidCronJobs,
  removeCronJob,
  upsertCronJob,
  type CronAddPayload,
} from './automations-cron.js';

export class OpenclawAutomationHost implements AutomationHost {
  async register(row: AutomationRow): Promise<void> {
    // `upsertCronJob` already issues add-or-update + carries
    // `row.enabled` through to the openclaw payload, so disabled
    // rows produce a suppressed-but-registered entry rather than no
    // entry at all.
    await upsertCronJob(row);
  }

  async unregister(automationRef: string): Promise<void> {
    await removeCronJob(automationRef);
  }

  async list(): Promise<readonly string[]> {
    return listCentraidCronJobs();
  }

  async reconcile(desired: ReadonlyArray<AutomationRow>): Promise<AutomationReconcileResult> {
    // One automation fans out to several cron jobs (one per cron
    // trigger); flatten every row's desired jobs into a name→payload
    // map so the diff stays a straightforward set operation.
    const desiredByCronName = new Map<string, CronAddPayload>();
    for (const row of desired) {
      for (const [name, payload] of desiredCronJobs(row)) {
        desiredByCronName.set(name, payload);
      }
    }

    const actualNames = new Set(await listCentraidCronJobs());

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // Re-issue `cron.update` for entries on both sides — covers the
    // case where the mirror absorbed an enabled toggle or schedule
    // change while the plugin was offline. Idempotent server-side.
    for (const [cronName, payload] of desiredByCronName) {
      if (actualNames.has(cronName)) {
        await callGatewayTool('cron.update', {}, payload);
        updated.push(cronName);
      } else {
        await callGatewayTool('cron.add', {}, payload);
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
