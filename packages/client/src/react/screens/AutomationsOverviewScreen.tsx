import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon, Button } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuOverviewData,
  AuOverviewRowDTO,
  AuOverviewRunDTO,
  AuStatusKind,
  AutomationsOverviewBridgeProps,
} from '../screen-contracts.js';
import styles from './AutomationsOverviewScreen.module.css';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';

// The Automations overview, rebuilt as "the fleet" (Automations UI revamp —
// see receipts/issue-387-automations-ui-revamp.md): a dense, calm register of every long-lived
// automation (name, enabled state, trigger, last/next fire, pending consent)
// with a secondary date-grouped feed of the fleet's recent runs below it.
// Screen owns loading/error/data state; `loadData` (route-supplied) fetches
// + derives everything else — this component renders, it doesn't compute.

const STATUS_META: Record<AuStatusKind, { icon: IconName; spin?: boolean }> = {
  active: { icon: 'Power' },
  paused: { icon: 'Pause' },
  draft: { icon: 'Pencil' },
  running: { icon: 'Loader', spin: true },
  success: { icon: 'CheckCircle' },
  failed: { icon: 'AlertTriangle' },
};

const RECENT_CAP = 10;

function StatusPill({ kind, label }: { kind: AuStatusKind; label: string }): JSX.Element {
  const meta = STATUS_META[kind];
  return (
    <span className={au.auStatus} data-tone={kind} data-au-status={kind}>
      <span className={au.auStatusIc} data-spin={meta.spin ? 'true' : undefined} aria-hidden="true">
        <Icon name={meta.icon} size={10} />
      </span>
      <span>{label}</span>
    </span>
  );
}

function FleetRow({
  row,
  onOpen,
}: {
  row: AuOverviewRowDTO;
  onOpen: (ref: string) => void;
}): JSX.Element {
  return (
    <button type="button" className={styles.row} data-hue={row.hue} onClick={() => onOpen(row.ref)}>
      <span className={au.auGlyph} data-hue={row.hue} data-size="sm" aria-hidden="true">
        <Icon name={row.glyphIcon as IconName} size={16} />
      </span>
      <span className={styles.rowMain}>
        <span className={styles.rowNameLine}>
          <span className={styles.rowName}>{row.name}</span>
          <StatusPill kind={row.statusKind} label={row.statusLabel} />
        </span>
        <span className={styles.rowMeta}>
          <span className={au.auTrigbadge} data-mono="true">
            <span className={au.auTrigbadgeIc} aria-hidden="true">
              <Icon name={row.triggerIcon as IconName} size={11} />
            </span>
            <span>{row.triggerLabel}</span>
          </span>
          {row.nextRunLabel ? (
            <span className={styles.rowNext} data-mono="true">
              Next {row.nextRunLabel}
            </span>
          ) : null}
        </span>
      </span>
      <span className={styles.rowLast} data-mono="true">
        {row.lastRunOk !== null ? (
          <i className={styles.lastDot} data-ok={String(row.lastRunOk)} aria-hidden="true" />
        ) : null}
        <span>{row.lastRunLabel}</span>
      </span>
      {row.attentionCount > 0 ? (
        <span
          className={styles.attentionBadge}
          title={`${row.attentionCount} item${row.attentionCount === 1 ? '' : 's'} waiting on you`}
        >
          <Icon name="AlertTriangle" size={11} />
          <span>{row.attentionCount}</span>
        </span>
      ) : null}
      <span className={styles.chev} aria-hidden="true">
        <Icon name="ChevronRight" size={15} />
      </span>
    </button>
  );
}

/** The run feed's `metaLabel` is `${originLabel} · ${duration} · ${tokens}`
 *  (automationsData.ts's `buildOverviewData`) — the activity row only wants
 *  the leading origin label ("Cron" / "Webhook" / "Manual" / …), not the
 *  duration/token detail the fleet row's run history already carries. */
function runOrigin(metaLabel: string): string {
  return metaLabel.split(' · ')[0] ?? metaLabel;
}

function ActivityRow({
  run,
  onOpen,
}: {
  run: AuOverviewRunDTO;
  onOpen: (automationId: string, runId: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.activityRow}
      onClick={() => onOpen(run.automationId, run.runId)}
    >
      <i className={styles.activityDot} data-ok={String(run.ok)} aria-hidden="true" />
      <span className={styles.activityName}>{run.name}</span>
      <span className={styles.activityOrigin} data-mono="true">
        {runOrigin(run.metaLabel)}
      </span>
      <span className={styles.activityWhen} data-mono="true">
        {run.whenLabel}
      </span>
    </button>
  );
}

/** Small-caps mono date-separator label for the activity feed — "Today" /
 *  "Yesterday" / "Mon, Jul 6" (mirrors the thread spine's date grouping,
 *  automationThreadData.ts's private `dateGroupLabel`, kept as an
 *  independent copy here since that helper isn't exported). */
function dateGroupLabel(startedAt: number): string {
  const d = new Date(startedAt);
  const now = new Date();
  const ds = d.toDateString();
  if (ds === now.toDateString()) return 'Today';
  if (ds === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

interface RunGroup {
  label: string;
  runs: AuOverviewRunDTO[];
}

/** Group already-newest-first runs into consecutive same-day buckets. */
function groupRuns(runs: readonly AuOverviewRunDTO[]): RunGroup[] {
  const groups: RunGroup[] = [];
  for (const run of runs) {
    const label = dateGroupLabel(run.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
  }
  return groups;
}

function HeaderActions({
  onBrowseTemplates,
  onNewAutomation,
}: {
  onBrowseTemplates: () => void;
  onNewAutomation: () => void;
}): JSX.Element {
  return (
    <div className={styles.actions}>
      <Button variant="soft" icon="Bolt" label="Browse templates" onClick={onBrowseTemplates} />
      <Button variant="primary" icon="Sparkle" label="New automation" onClick={onNewAutomation} />
    </div>
  );
}

function EmptyState({
  onBrowseTemplates,
  onNewAutomation,
}: {
  onBrowseTemplates: () => void;
  onNewAutomation: () => void;
}): JSX.Element {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon} aria-hidden="true">
        <Icon name="Bolt" size={22} />
      </div>
      <div className={styles.emptyTitle}>No automations yet</div>
      <p className={styles.emptyText}>
        An automation is a saved conversation that fires on a trigger. Start from a template, or
        describe one from scratch.
      </p>
      <div className={styles.emptyActions}>
        <Button variant="soft" icon="Bolt" label="Browse templates" onClick={onBrowseTemplates} />
        <Button variant="primary" icon="Sparkle" label="New automation" onClick={onNewAutomation} />
      </div>
    </div>
  );
}

export default function AutomationsOverviewScreen({
  loadData,
  onOpenAutomation,
  onOpenRun,
  onBrowseTemplates,
  onNewAutomation,
}: AutomationsOverviewBridgeProps): JSX.Element {
  const [state, setState] = useState<AuOverviewData | 'loading' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');

  const reload = useCallback(async () => {
    setState('loading');
    try {
      setState(await loadData());
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [loadData]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.skelHead} aria-hidden="true" />
        <div className={styles.loadingLabel} role="status">
          Loading automations…
        </div>
        <div className={styles.fleet} aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.skelRow} />
          ))}
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className={styles.error}>
        <div className={styles.errorIcon} aria-hidden="true">
          <Icon name="AlertCircle" size={22} />
        </div>
        <div className={styles.errorTitle}>Couldn&apos;t load automations</div>
        <div className={styles.errorText}>{errMsg}</div>
        <Button variant="primary" icon="Refresh" label="Retry" onClick={() => void reload()} />
      </div>
    );
  }

  const { rows, runs } = state;
  const activeCount = rows.filter((r) => r.statusKind === 'active').length;
  const pausedCount = rows.filter((r) => r.statusKind === 'paused').length;
  const draftCount = rows.filter((r) => r.statusKind === 'draft').length;
  const attentionCount = rows.filter((r) => r.attentionCount > 0 || r.lastRunOk === false).length;

  const subtitle =
    rows.length === 0
      ? 'Conversations that run on their own.'
      : [
          `${activeCount} active`,
          `${pausedCount} paused`,
          draftCount > 0 ? `${draftCount} draft${draftCount === 1 ? '' : 's'}` : null,
          attentionCount > 0 ? `${attentionCount} need attention` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');

  const recentRuns = runs.slice(0, RECENT_CAP);
  const runGroups = groupRuns(recentRuns);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Automations</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        <HeaderActions onBrowseTemplates={onBrowseTemplates} onNewAutomation={onNewAutomation} />
      </header>

      {rows.length === 0 ? (
        <EmptyState onBrowseTemplates={onBrowseTemplates} onNewAutomation={onNewAutomation} />
      ) : (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>Fleet</span>
              <span className={styles.sectionCount}>{rows.length}</span>
            </div>
            <div className={styles.fleet}>
              {rows.map((row) => (
                <FleetRow key={row.ref} row={row} onOpen={onOpenAutomation} />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>Recent activity</span>
            </div>
            {recentRuns.length > 0 ? (
              <div className={styles.activity}>
                {runGroups.map((group) => (
                  <div key={group.label} className={styles.activityGroup}>
                    <span className={styles.activityGroupLabel}>{group.label}</span>
                    <div className={styles.activityList}>
                      {group.runs.map((run) => (
                        <ActivityRow key={run.runId} run={run} onOpen={onOpenRun} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={cx(styles.activity, styles.activityEmpty)}>No runs recorded yet.</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
