// Automations overview data layer — ports the vanilla app-automations.ts
// `collectAutomationRuns` + `buildOverviewData`. Every display value (hue,
// glyph, trigger/status labels, formatted run meta) is computed here so the
// React AutomationsOverviewScreen imports no vanilla formatters. All derivation
// helpers come from the pure automation-identity + app-format modules.
import { auStatusForRow, glyphForId, hueForId } from '../../../automation-identity.js';
import {
  fmtTokens,
  formatDuration,
  formatWhereClauses,
  relativeRunLabel,
  relativeTime,
  triggersSummary,
} from '../../../app-format.js';
import { cronNextRuns } from '../../../cron.js';
import { listAutomationRuns, listAutomations } from '../../../gateway-client.js';
import type {
  AuOverviewData,
  AuStatusKind,
  AuViewConditionDetailDTO,
  AuViewDataDetailDTO,
} from '../../screen-contracts.js';

export interface AutomationFeedEntry {
  automationId: string;
  automationName: string;
  run: CentraidAutomationRunRecord;
}

export const AU_STATUS_LABEL: Record<AuStatusKind, string> = {
  active: 'Active',
  paused: 'Paused',
  draft: 'Draft',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
};

/** Title-Case trigger-origin icon + label for a run row — shared by the
 *  overview feed's `metaLabel`, the single-view's run rows, and the thread's
 *  run entries (automationThreadData.ts), so a run never surfaces the raw
 *  lowercase `triggerOrigin`/`triggerKind` enum ("data" · 1.2s) to a user. */
export function triggerOriginLabel(run: CentraidAutomationRunRecord): {
  icon: string;
  label: string;
} {
  return run.triggerKind === 'compile'
    ? { icon: 'Sparkle', label: 'Compile' }
    : run.triggerOrigin === 'webhook'
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

/** Derive the React overview DTO from the loaded rows + run feed (vanilla buildOverviewData).
 *  `attentionByRef` is an optional, caller-computed map of automation `ref` →
 *  pending-consent-item count (the fleet row's amber attention badge —
 *  Automations UI revamp, receipts/issue-387-automations-ui-revamp.md). It's computed by the
 *  route wrapper via `filterConsentForAutomation` (automationThreadData.ts)
 *  rather than here, so this module doesn't take on a reverse dependency on
 *  the thread data layer that already depends on it. Omitted entirely (e.g.
 *  existing callers/tests), every row's `attentionCount` is 0. */
export function buildOverviewData(
  rows: readonly CentraidAutomationRow[],
  entries: readonly AutomationFeedEntry[],
  attentionByRef?: ReadonlyMap<string, number>,
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
    if (lastEntry?.run.endedAt !== undefined && !lastEntry.run.ok) attention += 1;
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
      const compile = last?.run.triggerKind === 'compile' ? last.run : undefined;
      const statusKind = (
        compile
          ? compile.endedAt === undefined
            ? 'running'
            : compile.ok
              ? 'success'
              : 'failed'
          : auStatusForRow(r.enabled, !!last)
      ) as AuStatusKind;
      const statusLabel = compile
        ? compile.endedAt === undefined
          ? 'Compiling…'
          : compile.ok
            ? 'Plan ready'
            : 'Compile failed'
        : AU_STATUS_LABEL[statusKind];
      const cronTrig = r.triggers.find(
        (t): t is { kind: 'cron'; expr: string } => t.kind === 'cron',
      );
      const nextRun = cronTrig ? cronNextRuns(cronTrig.expr, 1)[0] : undefined;
      return {
        attentionCount: attentionByRef?.get(r.ref) ?? 0,
        glyphIcon: glyphForId(r.id),
        hue: hueForId(r.id),
        id: r.id,
        integrations: [...(r.manifest.requires.mcps ?? [])],
        lastRunLabel: last
          ? `Last run ${relativeTime(new Date(last.run.startedAt).toISOString())}`
          : 'No runs yet',
        lastRunOk: last?.run.endedAt !== undefined ? last.run.ok : null,
        lastRunSummary: last
          ? last.run.ok
            ? (last.run.summary ?? null)
            : (last.run.error ?? 'Failed')
          : null,
        name: r.name,
        nextRunLabel: nextRun ? relativeRunLabel(nextRun) : null,
        ref: r.ref,
        statusKind,
        statusLabel,
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
        startedAt: run.startedAt,
        summary: run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
        whenLabel: relativeTime(new Date(run.startedAt).toISOString()),
      };
    }),
    subtitle: rows.length > 0 ? subParts.join('  ·  ') : 'Conversations that run on their own.',
  };
}

/** The hero/trigger derivation shared by the thread header DTO
 *  (automationThreadData.ts) and the editor route: webhook URL resolution,
 *  cron next-run projections, and the data/condition trigger detail blocks.
 *  Kept here (not in screen-contracts.ts, which stays free of ambient ipc
 *  types) since it takes the raw `CentraidAutomationRow`. */
export interface AutomationHeroDTO {
  cronExprs: string[];
  nextRuns: string[];
  webhook: { pending: boolean; url: string | null } | null;
  dataDetail: AuViewDataDetailDTO | null;
  conditionDetail: AuViewConditionDetailDTO | null;
  kindEyebrow: string;
  heroIcon: string;
  when: string;
}

/** Derive the hero/trigger block for one automation row (vanilla portion of
 *  deriveAutomationHero is factored here so automationThreadData.ts's thread
 *  header can reuse it instead of re-deriving webhook/cron/data/condition
 *  detail a second time). */
export function deriveAutomationHero(
  row: CentraidAutomationRow,
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
): AutomationHeroDTO {
  const hasWebhook = row.triggers.some((t) => t.kind === 'webhook');
  const hasCron = row.triggers.some((t) => t.kind === 'cron');
  const cronExprs = row.triggers
    .filter((t): t is { kind: 'cron'; expr: string } => t.kind === 'cron')
    .map((t) => t.expr);
  const nextRuns =
    hasCron && cronExprs[0] ? cronNextRuns(cronExprs[0], 3).map((dt) => relativeRunLabel(dt)) : [];

  let webhook: AutomationHeroDTO['webhook'] = null;
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
  const dataDetail: AuViewDataDetailDTO | null = dataTrig
    ? {
        entities: [...dataTrig.entities],
        everyLabel: dataTrig.every ? `Every ${dataTrig.every}` : null,
      }
    : null;

  const condTrig = row.triggers.find(
    (t): t is { kind: 'condition'; entity: string; where?: unknown; every?: string } =>
      t.kind === 'condition',
  );
  const conditionDetail: AuViewConditionDetailDTO | null = condTrig
    ? {
        entity: condTrig.entity,
        everyLabel: condTrig.every ? `Every ${condTrig.every}` : null,
        whereText: formatWhereClause(condTrig.where),
      }
    : null;

  return {
    conditionDetail,
    cronExprs,
    dataDetail,
    heroIcon: hasWebhook && !hasCron ? 'Webhook' : 'Clock',
    kindEyebrow: hasCron
      ? 'Cron schedule'
      : hasWebhook
        ? 'Webhook'
        : row.triggers.some((t) => t.kind === 'data')
          ? 'Data trigger'
          : row.triggers.some((t) => t.kind === 'condition')
            ? 'Condition'
            : 'Manual',
    nextRuns,
    webhook,
    when: triggersSummary(row.triggers),
  };
}
