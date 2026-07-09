// Automations overview data layer — ports the vanilla app-automations.ts
// `collectAutomationRuns` + `buildOverviewData`. Every display value (hue,
// glyph, trigger/status labels, formatted run meta) is computed here so the
// React AutomationsOverviewScreen imports no vanilla formatters. All derivation
// helpers come from the pure automation-identity + app-format modules.
import { auStatusForRow, glyphForId, hueForId } from '../../../automation-identity.js';
import { fmtTokens, formatDuration, relativeTime, triggersSummary } from '../../../app-format.js';
import { listAutomationRuns, listAutomations } from '../../../gateway-client.js';
import type { AuOverviewData, AuStatusKind } from '../../bridge.js';

export interface AutomationFeedEntry {
  automationId: string;
  automationName: string;
  run: CentraidAutomationRunRecord;
}

const AU_STATUS_LABEL: Record<AuStatusKind, string> = {
  active: 'Active',
  paused: 'Paused',
  draft: 'Draft',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
};

/** Fetch the automation rows + their recent run feed (vanilla collectAutomationRuns). */
export async function collectAutomationRuns(): Promise<AutomationFeedEntry[]> {
  let autos: CentraidAutomationRow[] = [];
  let runs: CentraidAutomationRunRecord[] = [];
  try {
    [autos, runs] = await Promise.all([listAutomations(), listAutomationRuns({ limit: 100 })]);
  } catch {
    return [];
  }
  const nameByRef = new Map(autos.map((a) => [a.ref, a.name]));
  return runs.map((run) => ({
    automationId: run.automationId ?? '',
    automationName: run.automationId
      ? (nameByRef.get(run.automationId) ?? run.automationId)
      : 'Automation',
    run,
  }));
}

/** Derive the React overview DTO from the loaded rows + run feed (vanilla buildOverviewData). */
export function buildOverviewData(
  rows: readonly CentraidAutomationRow[],
  entries: readonly AutomationFeedEntry[],
): AuOverviewData {
  const runs = entries
    .filter((e) => e.automationId)
    .slice()
    .sort((a, b) => b.run.startedAt - a.run.startedAt);
  const lastByRef = new Map<string, AutomationFeedEntry>();
  for (const e of runs) if (!lastByRef.has(e.automationId)) lastByRef.set(e.automationId, e);

  let active = 0;
  let paused = 0;
  let drafts = 0;
  let attention = 0;
  for (const r of rows) {
    const lastEntry = lastByRef.get(r.ref);
    if (r.enabled) active += 1;
    else if (lastEntry) paused += 1;
    else drafts += 1;
    if (lastEntry && !lastEntry.run.ok) attention += 1;
  }
  const subParts = [`${active} active`, `${paused + drafts} paused`];
  if (runs.length > 0) subParts.push(`${runs.length} recent runs`);

  return {
    health: { active, attention, drafts, paused },
    rows: rows.map((r) => {
      const last = lastByRef.get(r.ref);
      const hasCron = r.triggers.some((t) => t.kind === 'cron');
      const hasWebhook = r.triggers.some((t) => t.kind === 'webhook');
      const statusKind = auStatusForRow(r.enabled, !!last) as AuStatusKind;
      return {
        glyphIcon: glyphForId(r.id),
        hue: hueForId(r.id),
        id: r.id,
        integrations: [...(r.manifest.requires.mcps ?? [])],
        lastRunLabel: last
          ? `Last run ${relativeTime(new Date(last.run.startedAt).toISOString())}`
          : 'No runs yet',
        name: r.name,
        ref: r.ref,
        statusKind,
        statusLabel: AU_STATUS_LABEL[statusKind],
        triggerIcon: hasWebhook && !hasCron ? 'Webhook' : 'Clock',
        triggerLabel: triggersSummary(r.triggers),
      };
    }),
    runs: runs.map((entry) => {
      const { run, automationName, automationId } = entry;
      const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
      const dur = run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : '—';
      return {
        automationId,
        metaLabel: `${run.triggerOrigin ?? run.triggerKind} · ${dur} · ${fmtTokens(tokens)}`,
        name: automationName,
        ok: run.ok,
        runId: run.runId,
        summary: run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
        whenLabel: relativeTime(new Date(run.startedAt).toISOString()),
      };
    }),
    subtitle: rows.length > 0 ? subParts.join('  ·  ') : 'Conversations that run on their own.',
  };
}
