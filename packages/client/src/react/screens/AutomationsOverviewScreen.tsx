import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon, Button } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuOverviewData,
  AuOverviewRowDTO,
  AuOverviewRunDTO,
  AuOverviewSuggestionDTO,
  AuStatusKind,
  AutomationsOverviewBridgeProps,
} from '../screen-contracts.js';
import styles from './AutomationsOverviewScreen.module.css';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';

// Automations overview (Automations UI revamp — see
// receipts/issue-387-automations-ui-revamp.md): a calm register of every
// long-lived automation (name, status, trigger, last/next fire, attention)
// with a date-grouped recent-runs feed below. Screen owns load/error/data;
// `loadData` (route) fetches + derives — this component renders.

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

/** Attention / failed-last-run first, then alphabetical — so the list answers
 *  "what needs me?" before "what's everything named?" */
function sortOverviewRows(rows: readonly AuOverviewRowDTO[]): AuOverviewRowDTO[] {
  return [...rows].sort((a, b) => {
    const aAtt = a.attentionCount > 0 || a.lastRunOk === false ? 1 : 0;
    const bAtt = b.attentionCount > 0 || b.lastRunOk === false ? 1 : 0;
    if (aAtt !== bAtt) return bAtt - aAtt;
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function FleetRow({
  row,
  onOpen,
}: {
  row: AuOverviewRowDTO;
  onOpen: (ref: string) => void;
}): JSX.Element {
  const needsYou = row.attentionCount > 0 || row.lastRunOk === false;
  return (
    <button
      type="button"
      className={styles.row}
      data-hue={row.hue}
      data-needs-you={needsYou ? 'true' : undefined}
      data-last-failed={row.lastRunOk === false ? 'true' : undefined}
      data-testid="automation-row"
      onClick={() => onOpen(row.ref)}
    >
      <span className={au.auGlyph} data-hue={row.hue} data-size="sm" aria-hidden="true">
        <Icon name={row.glyphIcon as IconName} size={16} />
      </span>
      <span className={styles.rowMain}>
        <span className={styles.rowNameLine}>
          <span className={styles.rowName} data-testid="automation-row-name">
            {row.name}
          </span>
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
      <span
        className={styles.rowLast}
        data-mono="true"
        data-ok={row.lastRunOk === null ? undefined : String(row.lastRunOk)}
      >
        {row.lastRunOk !== null ? (
          <i className={styles.lastDot} data-ok={String(row.lastRunOk)} aria-hidden="true" />
        ) : null}
        <span>
          {row.lastRunOk === false
            ? row.lastRunLabel.replace(/^Last run /i, 'Failed ')
            : row.lastRunLabel}
        </span>
      </span>
      {row.attentionCount > 0 ? (
        <span
          className={styles.attentionBadge}
          title={`${row.attentionCount} item${row.attentionCount === 1 ? '' : 's'} waiting on you`}
        >
          <Icon name="AlertTriangle" size={11} />
          <span>{row.attentionCount}</span>
        </span>
      ) : row.lastRunOk === false ? (
        <span className={styles.failedBadge} title="Last run failed">
          Failed
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
      data-ok={String(run.ok)}
      onClick={() => onOpen(run.automationId, run.runId)}
    >
      <i className={styles.activityDot} data-ok={String(run.ok)} aria-hidden="true" />
      <span className={styles.activityName}>{run.name}</span>
      <span className={styles.activityOrigin} data-mono="true">
        {runOrigin(run.metaLabel)}
        {run.ok ? '' : ' · failed'}
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

function SuggestionCard({
  suggestion,
  onAdd,
}: {
  suggestion: AuOverviewSuggestionDTO;
  onAdd: (id: string) => void;
}): JSX.Element {
  return (
    <div className={styles.suggestCard} data-testid="automation-suggestion">
      <div className={styles.suggestMain}>
        <div className={styles.suggestName}>{suggestion.name}</div>
        <p className={styles.suggestDesc}>{suggestion.desc}</p>
        {suggestion.triggerLabel ? (
          <span className={styles.suggestTrigger} data-mono="true">
            {suggestion.triggerLabel}
          </span>
        ) : null}
      </div>
      <Button variant="soft" size="sm" label="Add" onClick={() => onAdd(suggestion.id)} />
    </div>
  );
}

function EmptyState({
  suggestions,
  onBrowseTemplates,
  onNewAutomation,
  onUseSuggestion,
}: {
  suggestions: AuOverviewSuggestionDTO[];
  onBrowseTemplates: () => void;
  onNewAutomation: () => void;
  onUseSuggestion?: (templateId: string) => void;
}): JSX.Element {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon} aria-hidden="true">
        <Icon name="Bolt" size={22} />
      </div>
      <div className={styles.emptyTitle}>No automations yet</div>
      <p className={styles.emptyText}>
        Automations run on a schedule or when your data changes — summarize mail, sync calendars, or
        watch the vault. Start from a template or write instructions from scratch.
      </p>
      {suggestions.length > 0 && onUseSuggestion ? (
        <div className={styles.suggestSection} data-testid="automation-suggestions">
          <div className={styles.sectionHead}>
            <span className={styles.sectionLabel}>Suggested starters</span>
          </div>
          <div className={styles.suggestGrid}>
            {suggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} onAdd={onUseSuggestion} />
            ))}
          </div>
        </div>
      ) : null}
      <div className={styles.emptyActions}>
        <Button variant="primary" icon="Sparkle" label="New automation" onClick={onNewAutomation} />
        <Button variant="soft" icon="Bolt" label="Browse templates" onClick={onBrowseTemplates} />
      </div>
    </div>
  );
}

export default function AutomationsOverviewScreen({
  loadData,
  loadSuggestions,
  onOpenAutomation,
  onOpenRun,
  onBrowseTemplates,
  onNewAutomation,
  onUseSuggestion,
}: AutomationsOverviewBridgeProps): JSX.Element {
  const [state, setState] = useState<AuOverviewData | 'loading' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [suggestions, setSuggestions] = useState<AuOverviewSuggestionDTO[]>([]);
  const [filter, setFilter] = useState('');

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

  useEffect(() => {
    if (!loadSuggestions) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    void loadSuggestions()
      .then((rows) => {
        if (!cancelled) setSuggestions(rows);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSuggestions]);

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
      <div className={styles.error} data-testid="automations-error">
        <div className={styles.errorIcon} aria-hidden="true">
          <Icon name="AlertCircle" size={22} />
        </div>
        <div className={styles.errorTitle}>Couldn&apos;t load automations</div>
        <div className={styles.errorText}>{errMsg || 'Check the gateway and try again.'}</div>
        <Button variant="primary" icon="Refresh" label="Retry" onClick={() => void reload()} />
      </div>
    );
  }

  const { rows, runs, health } = state;
  const activeCount = health.active;
  const pausedCount = health.paused;
  const draftCount = health.drafts;
  const attentionCount = rows.filter((r) => r.attentionCount > 0 || r.lastRunOk === false).length;

  const subtitle =
    rows.length === 0
      ? 'Run on a schedule or when your data changes.'
      : [
          `${activeCount} active`,
          `${pausedCount} paused`,
          draftCount > 0 ? `${draftCount} draft${draftCount === 1 ? '' : 's'}` : null,
          attentionCount > 0
            ? `${attentionCount} need${attentionCount === 1 ? 's' : ''} attention`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');

  const q = filter.trim().toLowerCase();
  const sortedRows = sortOverviewRows(rows);
  const visibleRows = !q
    ? sortedRows
    : sortedRows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.triggerLabel.toLowerCase().includes(q) ||
          r.statusLabel.toLowerCase().includes(q),
      );

  const recentRuns = runs.slice(0, RECENT_CAP);
  const runGroups = groupRuns(recentRuns);
  const isEmpty = rows.length === 0;

  return (
    <div className={styles.page} data-testid="automations-overview">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Automations</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        {/* Empty state owns its CTAs so we don't double the same pair. */}
        {!isEmpty ? (
          <HeaderActions onBrowseTemplates={onBrowseTemplates} onNewAutomation={onNewAutomation} />
        ) : null}
      </header>

      {isEmpty ? (
        <EmptyState
          suggestions={suggestions}
          onBrowseTemplates={onBrowseTemplates}
          onNewAutomation={onNewAutomation}
          onUseSuggestion={onUseSuggestion}
        />
      ) : (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>Your automations</span>
              <span className={styles.sectionCount}>{rows.length}</span>
              {rows.length >= 4 ? (
                <label className={styles.filterWrap}>
                  <Icon name="Search" size={13} />
                  <input
                    className={styles.filterInput}
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter…"
                    aria-label="Filter automations"
                  />
                </label>
              ) : null}
            </div>
            {visibleRows.length === 0 ? (
              <div className={styles.filterEmpty}>
                No automations match “{filter.trim()}”.
                <button type="button" className={styles.filterClear} onClick={() => setFilter('')}>
                  Clear filter
                </button>
              </div>
            ) : (
              <div className={styles.fleet}>
                {visibleRows.map((row) => (
                  <FleetRow key={row.ref} row={row} onOpen={onOpenAutomation} />
                ))}
              </div>
            )}
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
              <div className={cx(styles.activity, styles.activityEmpty)}>
                No runs yet. Open an automation and use <strong>Run now</strong>, or wait for its
                trigger.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
