import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuOverviewData,
  AuOverviewRowDTO,
  AuOverviewRunDTO,
  AuStatusKind,
  AutomationsOverviewBridgeProps,
} from '../screen-contracts.js';
import { INTEGRATION_HUES } from '../format.js';
import styles from './AutomationsOverviewScreen.module.css';
import { cx } from '../ui/cx.js';

const STATUS_META: Record<AuStatusKind, { icon: IconName; spin?: boolean }> = {
  active: { icon: 'Power' },
  paused: { icon: 'Pause' },
  draft: { icon: 'Pencil' },
  running: { icon: 'Loader', spin: true },
  success: { icon: 'CheckCircle' },
  failed: { icon: 'AlertTriangle' },
};

const RUN_CAP = 6;

function StatusPill({ kind, label }: { kind: AuStatusKind; label: string }): JSX.Element {
  const m = STATUS_META[kind];
  return (
    <span className="cd-au-status" data-tone={kind} role="status">
      <span className="cd-au-status-ic" data-spin={m.spin ? 'true' : undefined} aria-hidden="true">
        <Icon name={m.icon} size={12} />
      </span>
      <span className="cd-au-status-tx">{label}</span>
    </span>
  );
}

function IntegrationDots({ names }: { names: readonly string[] }): JSX.Element {
  return (
    <div className="cd-au-ov-dots" aria-hidden={names.length === 0}>
      {names.slice(0, 4).map((name) => (
        <i
          key={name}
          className="cd-au-ov-dot"
          title={name}
          style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
        />
      ))}
      {names.length > 4 ? (
        <span className="cd-au-ov-dot-more">{`+${names.length - 4}`}</span>
      ) : null}
    </div>
  );
}

function AutomationRow({
  row,
  onOpen,
}: {
  row: AuOverviewRowDTO;
  onOpen: (ref: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="cd-au-ov-row"
      data-hue={row.hue}
      onClick={() => onOpen(row.ref)}
    >
      <span className="cd-au-glyph" data-hue={row.hue} style={{ width: 38, height: 38 }}>
        <Icon name={row.glyphIcon as IconName} size={17} />
      </span>
      <span className="cd-au-ov-body">
        <span className="cd-au-ov-name">{row.name}</span>
        <span className="cd-au-trigbadge" data-mono="true">
          <span className="cd-au-trigbadge-ic" aria-hidden="true">
            <Icon name={row.triggerIcon as IconName} size={12} />
          </span>
          <span className="cd-au-trigbadge-tx">{row.triggerLabel}</span>
        </span>
      </span>
      <IntegrationDots names={row.integrations} />
      <span className="cd-au-ov-last">{row.lastRunLabel}</span>
      <span className="cd-au-ov-right">
        <StatusPill kind={row.statusKind} label={row.statusLabel} />
        <span className="cd-au-ov-chev" aria-hidden="true">
          <Icon name="ChevronRight" size={16} />
        </span>
      </span>
    </button>
  );
}

function RunRow({
  run,
  onOpen,
}: {
  run: AuOverviewRunDTO;
  onOpen: (automationId: string, runId: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="cd-au-ov-run"
      data-ok={String(run.ok)}
      onClick={() => onOpen(run.automationId, run.runId)}
    >
      <span className="cd-au-ov-run-ic" data-ok={String(run.ok)} aria-hidden="true">
        <Icon name={run.ok ? 'CheckCircle' : 'AlertTriangle'} size={14} />
      </span>
      <span className="cd-au-ov-run-body">
        <span className="cd-au-ov-run-name">{run.name}</span>
        <span className="cd-au-ov-run-sum">{run.summary}</span>
      </span>
      <span className="cd-au-ov-run-when">
        <b>{run.whenLabel}</b>
        <span className="cd-au-ov-run-meta">{run.metaLabel}</span>
      </span>
    </button>
  );
}

/**
 * Automations overview, ported to React (issue #325, Phase 3). The vanilla
 * route module derives every display value and supplies it via `loadData`;
 * React owns the loading/error/data states, the health tiles, the automations
 * list, and the recent-runs "View all" toggle. Same `cd-au-*` classes.
 */
export default function AutomationsOverviewScreen({
  loadData,
  onOpenAutomation,
  onOpenRun,
  onBrowseTemplates,
  onNewAutomation,
}: AutomationsOverviewBridgeProps): JSX.Element {
  const [state, setState] = useState<AuOverviewData | 'loading' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [expanded, setExpanded] = useState(false);

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
      <div className={styles.ov}>
        <div className={styles.skelStrip} aria-hidden="true" />
        <div className={styles.loadingLabel} role="status">
          Loading automations…
        </div>
        <div className={styles.ovList} aria-hidden="true">
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
        <button type="button" className="cd-au-btn cd-au-btn-primary" onClick={() => void reload()}>
          <Icon name="Refresh" size={14} />
          <span>Retry</span>
        </button>
      </div>
    );
  }

  const { rows, runs, health } = state;
  const actions = (
    <div className="cd-au-actions">
      <button type="button" className="cd-au-btn cd-au-btn-ghost" onClick={onBrowseTemplates}>
        <Icon name="Bolt" size={14} />
        <span>Browse templates</span>
      </button>
      <button type="button" className="cd-au-btn cd-au-btn-primary" onClick={onNewAutomation}>
        <Icon name="Sparkle" size={14} />
        <span>New automation</span>
      </button>
    </div>
  );

  const shownRuns = expanded ? runs : runs.slice(0, RUN_CAP);

  return (
    <div className={styles.ov}>
      <div className={styles.ovHead}>
        <div>
          <h1 className={styles.ovTitle}>Automations</h1>
          <p className={styles.ovSub}>{state.subtitle}</p>
        </div>
        {actions}
      </div>

      {rows.length > 0 ? (
        <div className={styles.health}>
          <HealthTile icon="Power" value={health.active} label="Active" tone="active" />
          <HealthTile icon="Pause" value={health.paused} label="Paused" tone="paused" />
          <HealthTile icon="Pencil" value={health.drafts} label="Drafts" tone="draft" />
          <HealthTile
            icon="AlertTriangle"
            value={health.attention}
            label="Need attention"
            tone="attention"
          />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Icon name="Bolt" size={22} />
          </div>
          <div className={styles.emptyTitle}>No automations yet</div>
          <div className={styles.emptyText}>
            An automation is a saved conversation that fires on a trigger. Start from a template, or
            describe one from scratch.
          </div>
        </div>
      ) : (
        <>
          <div className={styles.ovSec}>
            <span className={styles.ovSecT}>Your automations</span>
            <span className={styles.ovSecM}>{String(rows.length)}</span>
          </div>
          <div className={styles.ovList}>
            {rows.map((row) => (
              <AutomationRow key={row.ref} row={row} onOpen={onOpenAutomation} />
            ))}
          </div>

          <div className={styles.ovRuns}>
            <div className={styles.ovSec}>
              <span className={styles.ovSecT}>Recent runs</span>
              {runs.length > 0 ? (
                <span className={styles.ovSecM}>{String(runs.length)}</span>
              ) : null}
              {runs.length > RUN_CAP ? (
                <button
                  type="button"
                  className={styles.ovViewall}
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? (
                    <span>Show less</span>
                  ) : (
                    <>
                      <span>View all</span>
                      <Icon name="ChevronRight" size={13} />
                    </>
                  )}
                </button>
              ) : null}
            </div>
            {runs.length > 0 ? (
              <div className={styles.ovStream}>
                {shownRuns.map((run) => (
                  <RunRow key={run.runId} run={run} onOpen={onOpenRun} />
                ))}
              </div>
            ) : (
              <div className={cx(styles.ovStream, styles.ovStreamEmpty)}>No runs recorded yet.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function HealthTile({
  icon,
  value,
  label,
  tone,
}: {
  icon: IconName;
  value: number;
  label: string;
  tone: 'active' | 'paused' | 'draft' | 'attention';
}): JSX.Element {
  return (
    <div className={styles.healthTile} data-tone={tone}>
      <span className={styles.healthIc} aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className={styles.healthMeta}>
        <span className={styles.healthV}>{String(value)}</span>
        <span className={styles.healthK}>{label}</span>
      </div>
    </div>
  );
}
