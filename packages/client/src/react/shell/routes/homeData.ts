import { relativeTime, triggersSummary } from '../../../app-format.js';
import { auStatusForRow, glyphForId, hueForId } from '../../../automation-identity.js';
import type { AppearancePrefs } from '../../../app-shell-context.js';
import type { AuStatusKind, HomeAppItemDTO, HomeAutoItemDTO } from '../../screen-contracts.js';
import type { AutomationFeedEntry } from './automationsData.js';

const AU_LABEL: Record<AuStatusKind, string> = {
  active: 'Active',
  draft: 'Draft',
  failed: 'Failed',
  paused: 'Paused',
  running: 'Running',
  success: 'Success',
};

const isDraftApp = (a: AppMetaResolvedType): a is DraftAppMeta =>
  (a as DraftAppMeta).__draft === true;

const recent = (iso?: string): boolean => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && Date.now() - t < 24 * 60 * 60 * 1000;
};

export interface HomeDeps {
  userApps: readonly UserAppMeta[];
  isStarred: (id: string) => boolean;
  tileVariant: AppearancePrefs['tileVariant'];
}

/** Derive the Home app-card DTOs from the resolved app list (vanilla renderHomeAsync). */
export function buildHomeAppItems(
  apps: readonly AppMetaResolvedType[],
  deps: HomeDeps,
): HomeAppItemDTO[] {
  return apps.map((a) => {
    const draft = isDraftApp(a);
    const ua = draft ? undefined : deps.userApps.find((x) => x.id === a.id);
    const tone = draft ? 'draft' : recent(ua?.createdAt) ? 'new' : null;
    const finish = window.CentraidTokens.tileFinish(a.color, deps.tileVariant);
    return {
      desc: a.desc || '',
      draft,
      iconKey: a.iconKey,
      id: a.id,
      name: a.name,
      starred: deps.isStarred(a.id),
      stamp: draft ? 'saved' : relativeTime(ua?.updatedAt),
      tile: {
        background: finish.background,
        boxShadow: finish.boxShadow,
        glyphColor: finish.glyphColor,
      },
      tone,
    };
  });
}

/** Derive the Home automation-card DTOs from the rows + their last-run feed. */
export function buildHomeAutoItems(
  rows: readonly CentraidAutomationRow[],
  entries: readonly AutomationFeedEntry[],
  isStarred: (id: string) => boolean,
): HomeAutoItemDTO[] {
  const lastByRef = lastRunByRef(entries);
  return rows.map((row) => {
    const last = lastByRef.get(row.ref);
    const isWebhook =
      row.triggers.some((t) => t.kind === 'webhook') &&
      !row.triggers.some((t) => t.kind === 'cron');
    const statusKind = auStatusForRow(row.enabled, !!last) as AuStatusKind;
    return {
      blurb: row.manifest.description || triggersSummary(row.triggers),
      footOk: !!last?.run.ok,
      footTimeLabel: last
        ? relativeTime(new Date(last.run.startedAt).toISOString())
        : 'No runs yet',
      glyphIcon: glyphForId(row.id),
      hue: hueForId(row.id),
      integrations: [...(row.manifest.requires.mcps ?? [])],
      name: row.name,
      ref: row.ref,
      starred: isStarred(row.ref),
      statusKind,
      statusLabel: AU_LABEL[statusKind],
      triggerIcon: isWebhook ? 'Webhook' : 'Clock',
      triggerLabel: triggersSummary(row.triggers),
    };
  });
}

function lastRunByRef(entries: readonly AutomationFeedEntry[]): Map<string, AutomationFeedEntry> {
  const runs = entries
    .filter((e) => e.automationId)
    .slice()
    .sort((a, b) => b.run.startedAt - a.run.startedAt);
  const lastByRef = new Map<string, AutomationFeedEntry>();
  for (const e of runs) if (!lastByRef.has(e.automationId)) lastByRef.set(e.automationId, e);
  return lastByRef;
}

/** Count automations whose most recent run failed (the "needs attention" badge). */
export function attentionCount(
  rows: readonly CentraidAutomationRow[],
  entries: readonly AutomationFeedEntry[],
): number {
  const lastByRef = lastRunByRef(entries);
  let attention = 0;
  for (const r of rows) {
    const last = lastByRef.get(r.ref);
    if (last && !last.run.ok) attention += 1;
  }
  return attention;
}

/** The hero eyebrow date, e.g. "TUESDAY · 19 MAY". */
export function heroDateLabel(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return `${weekday} · ${d.getDate()} ${month}`;
}

export const HERO_SUGGESTIONS = ['Habit tracker', 'Weekly review', 'Inbox digest', 'Invoice filer'];
