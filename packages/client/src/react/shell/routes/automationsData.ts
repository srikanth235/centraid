import {
  fmtTokens,
  formatDuration,
  formatWhereClauses,
  relativeRunLabel,
  relativeTime,
  triggersSummary,
} from "../../../app-format.js";
// The automations overview data layer: every display value is computed here so
// AutomationsOverviewScreen formats nothing itself.
import {
  auStatusForRow,
  glyphForId,
  hueForId,
} from "../../../automation-identity.js";
import {
  cronNextRuns,
  cronRunLabel,
  resolveCronTimezone,
} from "../../../cron.js";
import {
  listAutomations,
  listAutomationTurnsByLane,
} from "../../../gateway-client.js";
import type {
  AuOverviewData,
  AuStatusKind,
  AuViewConditionDetailDTO,
  AuViewDataDetailDTO,
} from "../../screen-contracts.js";

export interface AutomationFeedEntry {
  automationId: string;
  automationName: string;
  run: CentraidAutomationTurnRecord;
}

export const AU_STATUS_LABEL: Record<AuStatusKind, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  running: "Running",
  success: "Success",
  failed: "Failed",
};

/** Shared by every run-row surface: the raw `triggerOrigin`/`triggerKind` enum
 *  must never reach a user. */
export function triggerOriginLabel(run: CentraidAutomationTurnRecord): {
  icon: string;
  label: string;
} {
  return run.triggerKind === "compile"
    ? { icon: "Sparkle", label: "Compile" }
    : // An interactive turn is the owner ASKING about runs, not a run; without
      // this arm it falls through to the "Cron" default.
      run.triggerKind === "interactive"
      ? { icon: "Send", label: "You asked" }
      : run.triggerOrigin === "webhook"
        ? { icon: "Webhook", label: "Webhook" }
        : run.triggerOrigin === "data"
          ? { icon: "Clock", label: "Data" }
          : run.triggerOrigin === "condition"
            ? { icon: "Clock", label: "Condition" }
            : run.triggerKind === "manual"
              ? { icon: "Play", label: "Manual" }
              : { icon: "Clock", label: "Cron" };
}

function formatWhereClause(where: unknown): string {
  if (where === undefined || where === null) return "—";
  if (typeof where === "string") return where;
  const compact = formatWhereClauses(where);
  if (compact !== null) return compact;
  try {
    return JSON.stringify(where, null, 2);
  } catch {
    return String(where);
  }
}

/** Returns the rows beside the feed: the caller shares this `Promise.all`, so
 *  fetching `listAutomations()` again would pay for the list twice. */
export async function collectAutomationRuns(): Promise<{
  rows: CentraidAutomationRow[];
  entries: AutomationFeedEntry[];
}> {
  // THE CALLS FAIL DIFFERENTLY ON PURPOSE. The list is load-bearing, so it
  // THROWS: swallowed, a 500 paints the empty state over a broken gateway. The
  // run feed is decoration and degrades to empty. Keep it as TWO lane-scoped
  // fetches (#731) — one window lets recognition runs crowd out the member's.
  const [autos, memberRuns, recognitionRuns] = await Promise.all([
    listAutomations(),
    listAutomationTurnsByLane({ limit: 100, systemLane: "member" }).catch(
      () => [] as CentraidAutomationTurnRecord[]
    ),
    listAutomationTurnsByLane({ limit: 100, systemLane: "recognition" }).catch(
      () => [] as CentraidAutomationTurnRecord[]
    ),
  ]);
  const runs = [...memberRuns, ...recognitionRuns];
  const nameByRef = new Map(autos.map((a) => [a.ref, a.name]));
  return {
    rows: autos,
    entries: runs.map((run) => ({
      automationId: run.automationId ?? "",
      // Live name → the run record's name (it survives deletion) → the ref.
      automationName: run.automationId
        ? (nameByRef.get(run.automationId) ??
          run.automationName ??
          run.automationId)
        : "Automation",
      run,
    })),
  };
}

/** `attentionByRef` (ref → pending-consent count) is computed by the route: this
 *  module must not depend on the thread data layer that depends on it. */
export function buildOverviewData(
  rows: readonly CentraidAutomationRow[],
  entries: readonly AutomationFeedEntry[],
  attentionByRef?: ReadonlyMap<string, number>
): AuOverviewData {
  const runs = entries
    .filter((e) => e.automationId)
    .slice()
    .sort((a, b) => b.run.startedAt - a.run.startedAt);
  const lastByRef = new Map<string, AutomationFeedEntry>();
  for (const e of runs)
    if (!lastByRef.has(e.automationId)) lastByRef.set(e.automationId, e);

  let active = 0;
  let paused = 0;
  let drafts = 0;
  let attention = 0;
  const memberRows = rows.filter((row) => row.systemLane === undefined);
  const memberRuns = runs.filter((entry) => entry.run.systemLane === undefined);
  for (const r of memberRows) {
    const lastEntry = lastByRef.get(r.ref);
    if (r.enabled) active += 1;
    else if (lastEntry) paused += 1;
    else drafts += 1;
    if (lastEntry?.run.endedAt !== undefined && !lastEntry.run.ok)
      attention += 1;
  }
  // Drafts are not "paused": they have simply never run.
  const subParts = [`${active} active`, `${paused} paused`];
  if (drafts > 0) subParts.push(`${drafts} drafts`);
  if (memberRuns.length > 0) subParts.push(`${memberRuns.length} recent runs`);

  return {
    health: { active, attention, drafts, paused },
    rows: rows.map((r) => {
      const last = lastByRef.get(r.ref);
      const hasCron = r.triggers.some((t) => t.kind === "cron");
      const hasWebhook = r.triggers.some((t) => t.kind === "webhook");
      const compile =
        last?.run.triggerKind === "compile" ? last.run : undefined;
      const statusKind = (
        compile
          ? compile.endedAt === undefined
            ? "running"
            : compile.ok
              ? "success"
              : "failed"
          : auStatusForRow(r.enabled, !!last)
      ) as AuStatusKind;
      const statusLabel = compile
        ? compile.endedAt === undefined
          ? "Compiling…"
          : compile.ok
            ? "Plan ready"
            : "Compile failed"
        : AU_STATUS_LABEL[statusKind];
      const cronTrig = r.triggers.find(
        (t): t is { kind: "cron"; expr: string; tz?: string } =>
          t.kind === "cron"
      );
      const cronTz = cronTrig ? resolveCronTimezone(cronTrig.tz) : undefined;
      const nextRun = cronTrig
        ? cronNextRuns(cronTrig.expr, 1, new Date(), cronTz)[0]
        : undefined;
      const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return {
        attentionCount: attentionByRef?.get(r.ref) ?? 0,
        recentFailover: last?.run.turnId.includes(":failover:") ?? false,
        glyphIcon: glyphForId(r.id),
        hue: hueForId(r.id),
        id: r.id,
        integrations: [...(r.manifest.requires.mcps ?? [])],
        lastRunLabel: last
          ? `Last run ${relativeTime(new Date(last.run.startedAt).toISOString())}`
          : "No runs yet",
        lastRunOk: last?.run.endedAt === undefined ? null : last.run.ok,
        lastRunSummary: last
          ? last.run.ok
            ? (last.run.summary ?? null)
            : (last.run.error ?? "Failed")
          : null,
        name: r.name,
        nextRunLabel: nextRun
          ? cronTz
            ? cronRunLabel(nextRun, {
                timeZone: cronTz,
                viewerTimeZone: viewerTz,
              })
            : relativeRunLabel(nextRun)
          : null,
        ref: r.ref,
        ...(r.systemLane ? { systemLane: r.systemLane } : {}),
        statusKind,
        statusLabel,
        triggerIcon: hasWebhook && !hasCron ? "Webhook" : "Clock",
        triggerLabel: triggersSummary(r.triggers),
      };
    }),
    runs: runs.map((entry) => {
      const { run, automationName, automationId } = entry;
      const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
      const dur =
        run.endedAt === undefined
          ? "—"
          : formatDuration(run.endedAt - run.startedAt);
      return {
        automationId,
        metaLabel: `${triggerOriginLabel(run).label} · ${dur} · ${fmtTokens(tokens)}`,
        name: automationName,
        ok: run.ok,
        runId: run.turnId,
        startedAt: run.startedAt,
        ...(run.systemLane ? { systemLane: run.systemLane } : {}),
        summary: run.ok ? (run.summary ?? "—") : (run.error ?? "Failed"),
        whenLabel: relativeTime(new Date(run.startedAt).toISOString()),
      };
    }),
    subtitle:
      memberRows.length > 0
        ? subParts.join("  ·  ")
        : "Conversations that run on their own.",
  };
}

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

export function deriveAutomationHero(
  row: CentraidAutomationRow,
  /**
   * The active gateway's base URL. A bare `/_centraid-hook/<id>` is ambiguous
   * once more than one gateway exists, and the caller resolves it so this stays
   * pure — importing gateway-client would add a load-time `window` side effect.
   */
  gatewayOrigin: string
): AutomationHeroDTO {
  const hasWebhook = row.triggers.some((t) => t.kind === "webhook");
  const hasCron = row.triggers.some((t) => t.kind === "cron");
  const cronTriggers = row.triggers.filter(
    (t): t is { kind: "cron"; expr: string; tz?: string } => t.kind === "cron"
  );
  const cronExprs = cronTriggers.map((t) => t.expr);
  const firstCron = cronTriggers[0];
  const cronTz = firstCron ? resolveCronTimezone(firstCron.tz) : undefined;
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nextRuns =
    hasCron && cronExprs[0]
      ? cronNextRuns(cronExprs[0], 3, new Date(), cronTz).map((dt) =>
          cronTz
            ? cronRunLabel(dt, { timeZone: cronTz, viewerTimeZone: viewerTz })
            : relativeRunLabel(dt)
        )
      : [];

  let webhook: AutomationHeroDTO["webhook"] = null;
  if (hasWebhook) {
    const wh = row.triggers.find((t) => t.kind === "webhook") as
      | { kind: "webhook"; id?: string; pending?: true }
      | undefined;
    webhook =
      wh?.pending || !wh?.id
        ? { pending: true, url: null }
        : {
            pending: false,
            url: new URL(`/_centraid-hook/${wh.id}`, gatewayOrigin).toString(),
          };
  }

  // A user must see WHAT a condition checks without opening raw JSON.
  const dataTrig = row.triggers.find(
    (t): t is { kind: "data"; entities: readonly string[]; every?: string } =>
      t.kind === "data"
  );
  const dataDetail: AuViewDataDetailDTO | null = dataTrig
    ? {
        entities: [...dataTrig.entities],
        everyLabel: dataTrig.every ? `Every ${dataTrig.every}` : null,
      }
    : null;

  const condTrig = row.triggers.find(
    (
      t
    ): t is {
      kind: "condition";
      entity: string;
      where?: unknown;
      every?: string;
    } => t.kind === "condition"
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
    heroIcon: hasWebhook && !hasCron ? "Webhook" : "Clock",
    kindEyebrow: hasCron
      ? "Cron schedule"
      : hasWebhook
        ? "Webhook"
        : row.triggers.some((t) => t.kind === "data")
          ? "Data trigger"
          : row.triggers.some((t) => t.kind === "condition")
            ? "Condition"
            : "Manual",
    nextRuns,
    webhook,
    when: triggersSummary(row.triggers),
  };
}
