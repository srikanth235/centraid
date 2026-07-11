// Automations overview data layer — ports the vanilla app-automations.ts
// `collectAutomationRuns` + `buildOverviewData`. Every display value (hue,
// glyph, trigger/status labels, formatted run meta) is computed here so the
// React AutomationsOverviewScreen imports no vanilla formatters. All derivation
// helpers come from the pure automation-identity + app-format modules.
import { auStatusForRow, glyphForId, hueForId } from '../../../automation-identity.js';
import {
  fmtRetention,
  fmtTokens,
  formatDuration,
  formatWhereClauses,
  relativeRunLabel,
  relativeTime,
  triggersSummary,
} from '../../../app-format.js';
import { cronNextRuns } from '../../../cron.js';
import { createAutomation, listAutomationRuns, listAutomations } from '../../../gateway-client.js';
import type { AuOverviewData, AuStatusKind, AutomationViewData } from '../../screen-contracts.js';

/** Scaffold a fresh disabled draft automation, returning its id to open in the
 *  builder (vanilla createAndOpenAutomationBuilder, minus the navigation). A
 *  plain slug id — the app.json#kind, not the id, is the automation signal. */
export async function scaffoldAutomationDraft(): Promise<string> {
  const id = `automation-${Math.random().toString(36).slice(2, 8)}`;
  await createAutomation({ id, name: 'New automation', enabled: false });
  return id;
}

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

/** Title-Case trigger-origin icon + label for a run row — shared by the
 *  overview feed's `metaLabel` and the single-view's run rows, so a run never
 *  surfaces the raw lowercase `triggerOrigin`/`triggerKind` enum ("data" ·
 *  1.2s) to a user. */
function triggerOriginLabel(run: CentraidAutomationRunRecord): { icon: string; label: string } {
  return run.triggerOrigin === 'webhook'
    ? { icon: 'Webhook', label: 'Webhook' }
    : run.triggerOrigin === 'data'
      ? { icon: 'Clock', label: 'Data' }
      : run.triggerOrigin === 'condition'
        ? { icon: 'Clock', label: 'Condition' }
        : run.triggerKind === 'manual'
          ? { icon: 'Play', label: 'Manual' }
          : { icon: 'Clock', label: 'Cron' };
}

/** Render a `where` condition clause readably — a plain string passes
 *  through, a structured `{column, op, value?}` array renders the same
 *  compact `column op value` lines the builder shows (formatWhereClauses),
 *  and any other shape falls back to pretty-printed JSON. */
function formatWhereClause(where: unknown): string {
  if (where === undefined || where === null) return '—';
  if (typeof where === 'string') return where;
  const compact = formatWhereClauses(where);
  if (compact !== null) return compact;
  try {
    return JSON.stringify(where, null, 2);
  } catch {
    return String(where);
  }
}

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
    // Live automation name → the run's own last-known name (carried on the
    // run record even after the automation is deleted) → the raw ref.
    automationName: run.automationId
      ? (nameByRef.get(run.automationId) ?? run.automationName ?? run.automationId)
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
  // Keep the prose consistent with the health tiles below it — drafts are
  // not "paused", they've simply never run.
  const subParts = [`${active} active`, `${paused} paused`];
  if (drafts > 0) subParts.push(`${drafts} drafts`);
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
        metaLabel: `${triggerOriginLabel(run).label} · ${dur} · ${fmtTokens(tokens)}`,
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

/** 30-day lifetime KPIs for an automation's runs (vanilla automationLifetime). */
function automationLifetime(runs: readonly CentraidAutomationRunRecord[]): {
  total: number;
  successPct: number | null;
  avg: string;
  cost: string;
} {
  const total = runs.length;
  const ok = runs.filter((r) => r.ok).length;
  const durations = runs
    .filter((r) => r.endedAt !== undefined)
    .map((r) => r.endedAt! - r.startedAt);
  const avgMs = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : undefined;
  const cost = runs.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
  return {
    total,
    successPct: total ? Math.round((ok / total) * 100) : null,
    avg: avgMs !== undefined ? formatDuration(Math.round(avgMs)) : '—',
    cost: cost > 0 ? `$${cost.toFixed(2)}` : '—',
  };
}

/** Derive the React single-view DTO — hero, run rows, 30-day KPIs, behavior —
 *  so the React screen imports no vanilla formatters (vanilla buildAutomationViewData). */
export function buildAutomationViewData(
  row: CentraidAutomationRow,
  runs: readonly CentraidAutomationRunRecord[],
  /**
   * The active gateway's base URL (`auth().baseUrl` — see
   * `gateway-client-core.ts`). The webhook route only ever lives on the
   * gateway that owns the automation (issue #96: core gateway mount), so a
   * bare `/_centraid-hook/<id>` path is ambiguous the moment more than one
   * gateway exists (remote daemon vs. this desktop's embedded one) — the
   * caller resolves it and passes it in here so this function stays pure
   * (no import of the gateway-client module, which has a load-time
   * `window.CentraidApi` side effect the unit tests stub around).
   */
  gatewayOrigin: string,
): AutomationViewData {
  const hasWebhook = row.triggers.some((t) => t.kind === 'webhook');
  const hasCron = row.triggers.some((t) => t.kind === 'cron');
  const hasRun = runs.length > 0;
  const cronExprs = row.triggers
    .filter((t): t is { kind: 'cron'; expr: string } => t.kind === 'cron')
    .map((t) => t.expr);
  const nextRuns =
    hasCron && cronExprs[0] ? cronNextRuns(cronExprs[0], 3).map((dt) => relativeRunLabel(dt)) : [];

  let webhook: AutomationViewData['webhook'] = null;
  if (hasWebhook) {
    const wh = row.triggers.find((t) => t.kind === 'webhook') as
      | { kind: 'webhook'; id?: string; pending?: true }
      | undefined;
    webhook =
      wh?.pending || !wh?.id
        ? { pending: true, url: null }
        : { pending: false, url: new URL(`/_centraid-hook/${wh.id}`, gatewayOrigin).toString() };
  }

  // Data/condition triggers get the same hero-level treatment as cron/webhook
  // — a user must be able to see WHAT a condition checks without opening raw
  // JSON (the manifest's `where` is `unknown`; a structured value is
  // pretty-printed, a plain string passes through).
  const dataTrig = row.triggers.find(
    (t): t is { kind: 'data'; entities: readonly string[]; every?: string } => t.kind === 'data',
  );
  const dataDetail: AutomationViewData['dataDetail'] = dataTrig
    ? {
        entities: [...dataTrig.entities],
        everyLabel: dataTrig.every ? `Every ${dataTrig.every}` : null,
      }
    : null;

  const condTrig = row.triggers.find(
    (t): t is { kind: 'condition'; entity: string; where?: unknown; every?: string } =>
      t.kind === 'condition',
  );
  const conditionDetail: AutomationViewData['conditionDetail'] = condTrig
    ? {
        entity: condTrig.entity,
        everyLabel: condTrig.every ? `Every ${condTrig.every}` : null,
        whereText: formatWhereClause(condTrig.where),
      }
    : null;

  const statusKind = auStatusForRow(row.enabled, hasRun) as AuStatusKind;
  const now = Date.now();
  const life = automationLifetime(runs.filter((r) => now - r.startedAt <= 30 * 86_400_000));
  const tools = row.manifest.requires.tools ?? [];

  return {
    behavior: {
      historyLabel: fmtRetention(row.manifest.history.keep),
      model: row.manifest.requires.model ?? row.manifest.costEstimate?.model ?? 'Default',
      onFailure: row.manifest.onFailure ? `Run "${row.manifest.onFailure}"` : 'Stop',
    },
    conditionDetail,
    cronExprs,
    dataDetail,
    description: row.manifest.description ?? null,
    enabled: row.enabled,
    glyphIcon: glyphForId(row.id),
    heroIcon: hasWebhook && !hasCron ? 'Webhook' : 'Clock',
    hue: hueForId(row.id),
    kindEyebrow: hasCron
      ? 'Cron schedule'
      : hasWebhook
        ? 'Webhook'
        : row.triggers.some((t) => t.kind === 'data')
          ? 'Data trigger'
          : row.triggers.some((t) => t.kind === 'condition')
            ? 'Condition'
            : 'Manual',
    kpis: {
      avg: life.avg,
      cost: life.cost,
      successPct: life.successPct === null ? '—' : `${life.successPct}%`,
      total: String(life.total),
    },
    name: row.name,
    nextRuns,
    runs: runs.map((run) => {
      const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
      const dur =
        run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
      const trig = triggerOriginLabel(run);
      const filterKey: 'cron' | 'webhook' | 'manual' | 'other' =
        run.triggerOrigin === 'webhook'
          ? 'webhook'
          : run.triggerKind === 'scheduled'
            ? 'cron'
            : run.triggerKind === 'manual'
              ? 'manual'
              : 'other';
      return {
        automationId: run.automationId ?? null,
        filterKey,
        metaLabel: `${dur} · ${fmtTokens(tokens)}`,
        ok: run.ok,
        runId: run.runId,
        summary: run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
        trigIcon: trig.icon,
        trigLabel: trig.label,
        whenLabel: relativeTime(new Date(run.startedAt).toISOString()),
      };
    }),
    statusKind,
    statusLabel: AU_STATUS_LABEL[statusKind],
    tools: tools.length > 0 ? [...tools] : [...(row.manifest.requires.mcps ?? [])],
    webhook,
    when: triggersSummary(row.triggers),
  };
}
