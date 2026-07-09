import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuStatusKind,
  AutomationViewBridgeProps,
  AutomationViewData,
  AuViewRunDTO,
} from '../screen-contracts.js';
import styles from './AutomationViewScreen.module.css';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';

const STATUS_ICON: Record<AuStatusKind, IconName> = {
  active: 'Power',
  paused: 'Pause',
  draft: 'Pencil',
  running: 'Loader',
  success: 'CheckCircle',
  failed: 'AlertTriangle',
};

const RUN_FILTERS = [
  ['all', 'All'],
  ['cron', 'Cron'],
  ['webhook', 'Webhook'],
  ['manual', 'Manual'],
] as const;

function RunRow({
  run,
  onOpen,
}: {
  run: AuViewRunDTO;
  onOpen: (automationId: string, runId: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.run}
      data-ok={String(run.ok)}
      onClick={() => run.automationId && onOpen(run.automationId, run.runId)}
    >
      <span className={styles.runIc} data-ok={String(run.ok)} aria-hidden="true">
        <Icon name={run.ok ? 'CheckCircle' : 'AlertCircle'} size={15} />
      </span>
      <span className={styles.runSum}>{run.summary}</span>
      <span className={styles.runTrig}>
        <span aria-hidden="true">
          <Icon name={run.trigIcon as IconName} size={12} />
        </span>
        <span>{run.trigLabel}</span>
      </span>
      <span className={styles.runWhen}>
        <b>{run.whenLabel}</b>
        <span className={styles.runWhenMeta}>{run.metaLabel}</span>
      </span>
    </button>
  );
}

function Kpi({
  icon,
  label,
  value,
  ok,
}: {
  icon: IconName;
  label: string;
  value: string;
  ok?: boolean;
}): JSX.Element {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiL}>
        <span className={styles.kpiIc} aria-hidden="true">
          <Icon name={icon} size={13} />
        </span>
        <span>{label}</span>
      </div>
      <div className={styles.kpiV} data-ok={ok ? 'true' : undefined}>
        {value}
      </div>
    </div>
  );
}

/**
 * Automation single-view, ported to React (issue #325, Phase 3). Header +
 * trigger hero (cron/webhook, next-3-runs), enable toggle, filterable run
 * history, and a 30-day KPI + behavior rail. The vanilla side derives the DTO
 * and owns the gateway actions (delete/run/toggle) + the confirm dialog + the
 * live-streaming run-view handoff; React owns the view, filters, and reload.
 */
export default function AutomationViewScreen({
  loadData,
  onBack,
  onEdit,
  onDelete,
  onRun,
  onToggleEnabled,
  onCopyWebhook,
  onOpenRun,
}: AutomationViewBridgeProps): JSX.Element {
  const [state, setState] = useState<AutomationViewData | 'loading' | 'error' | 'missing'>(
    'loading',
  );
  const [filter, setFilter] = useState<'all' | 'cron' | 'webhook' | 'manual'>('all');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await loadData();
      setState(d ?? 'missing');
    } catch {
      setState('error');
    }
  }, [loadData]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state === 'loading') return <div className={au.auLoading}>Loading automation…</div>;
  if (state === 'error') return <div className={au.auLoading}>Could not load automation.</div>;
  if (state === 'missing') return <div className={au.auLoading}>Automation not found.</div>;

  const d = state;
  const shownRuns = d.runs.filter((r) => filter === 'all' || r.filterKey === filter);

  const doDelete = (): void => {
    setBusy(true);
    void onDelete().then((deleted) => {
      if (!deleted) setBusy(false);
    });
  };
  const doRun = (): void => {
    setRunning(true);
    void onRun().then((started) => {
      if (!started) setRunning(false);
    });
  };
  const doToggle = (next: boolean): void => {
    void onToggleEnabled(next).then((ok) => {
      if (ok) void reload();
    });
  };

  return (
    <div className={styles.view}>
      <div className={styles.vhead}>
        <div>
          <div className={au.auCrumb}>
            <button type="button" onClick={onBack}>
              Automations
            </button>
            <span className={au.auCrumbSep} aria-hidden="true">
              <Icon name="ArrowRight" size={12} />
            </span>
            <span>{d.name}</span>
          </div>
          <div className={styles.vtitle}>
            <span className={au.auGlyph} data-hue={d.hue} style={{ width: 46, height: 46 }}>
              <Icon name={d.glyphIcon as IconName} size={21} />
            </span>
            <div className={styles.vtitleText}>
              <h1>{d.name}</h1>
              {d.description ? <p className={styles.vsub}>{d.description}</p> : null}
            </div>
          </div>
        </div>
        <div className={au.auActions}>
          <button
            type="button"
            className={cx(au.auBtn, styles.btnDanger, styles.btnIcon)}
            title="Delete automation"
            aria-label={`Delete ${d.name}`}
            disabled={busy}
            onClick={doDelete}
          >
            <Icon name="Trash" size={15} />
          </button>
          <button
            type="button"
            className={cx(au.auBtn, au.auBtnGhost, styles.btnIcon)}
            title="Edit in builder"
            disabled={busy}
            onClick={onEdit}
          >
            <Icon name="Pencil" size={15} />
          </button>
          <button
            type="button"
            className={cx(au.auBtn, au.auBtnPrimary)}
            disabled={busy || running}
            onClick={doRun}
          >
            <Icon name="Play" size={14} />
            <span>{running ? 'Starting…' : 'Run now'}</span>
          </button>
        </div>
      </div>

      <div className={styles.hero} data-hue={d.hue}>
        <span className={styles.heroIcon} aria-hidden="true">
          <Icon name={d.heroIcon as IconName} size={26} />
        </span>
        <div className={styles.heroMain}>
          <div className={cx(styles.heroEyebrow, styles.heroKind)}>{d.kindEyebrow}</div>
          <div className={styles.heroWhen}>{d.when}</div>
          {d.cronExprs.length > 0 ? (
            <div className={styles.heroDetail}>
              {d.cronExprs.map((expr) => (
                <span key={expr} className={styles.heroCron}>
                  <span className={styles.heroCronIc} aria-hidden="true">
                    <Icon name="Braces" size={12} />
                  </span>
                  <code>{expr}</code>
                </span>
              ))}
            </div>
          ) : null}
          {d.nextRuns.length > 0 ? (
            <div className={styles.heroNext}>
              <div className={styles.heroNextLbl}>Next 3 runs</div>
              <div className={styles.heroNextPills}>
                {d.nextRuns.map((label, i) => (
                  <span
                    key={label}
                    className={styles.heroNextPill}
                    data-active={i === 0 ? 'true' : undefined}
                  >
                    <i className={styles.heroNextDot} aria-hidden="true" />
                    <span>{label}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {d.webhook ? (
            d.webhook.pending || !d.webhook.url ? (
              <div className={styles.heroWebhook} data-provisioning="true">
                <span className={au.auStatusIc} data-spin="true" aria-hidden="true">
                  <Icon name="Loader" size={13} />
                </span>
                <span>Provisioning endpoint… · secret minted server-side</span>
              </div>
            ) : (
              <div className={styles.heroWebhook}>
                <span className={styles.heroWhIc} aria-hidden="true">
                  <Icon name="Webhook" size={14} />
                </span>
                <code className={styles.heroWhUrl}>{d.webhook.url}</code>
                <button
                  type="button"
                  className={styles.heroCopy}
                  aria-label="Copy webhook URL"
                  title="Copy webhook URL"
                  onClick={() => d.webhook?.url && onCopyWebhook(d.webhook.url)}
                >
                  <Icon name="Copy" size={13} />
                </button>
                <span className={styles.heroWhNote}>
                  <span aria-hidden="true">
                    <Icon name="Key" size={12} />
                  </span>
                  Secret minted server-side
                </span>
              </div>
            )
          ) : null}
        </div>
        <div className={styles.heroStatus}>
          <span className={au.auStatus} data-tone={d.statusKind} role="status">
            <span className={au.auStatusIc} aria-hidden="true">
              <Icon name={STATUS_ICON[d.statusKind]} size={12} />
            </span>
            <span className="cd-au-status-tx">{d.statusLabel}</span>
          </span>
          <div className={styles.heroToggle}>
            <span className={styles.heroToggleLbl}>Enabled</span>
            <label className={styles.switch} title={d.enabled ? 'Disable' : 'Enable'}>
              <input
                type="checkbox"
                role="switch"
                aria-checked={d.enabled}
                aria-label={`${d.enabled ? 'Disable' : 'Enable'} ${d.name}`}
                checked={d.enabled}
                onChange={(e) => doToggle(e.target.checked)}
              />
              <span className={styles.switchTrack} aria-hidden="true" />
            </label>
          </div>
        </div>
      </div>

      <div className={styles.cols}>
        <div className={styles.colMain}>
          <div className={styles.runhist}>
            <div className={styles.runhistH}>
              <h2>Run history</h2>
              <div className={styles.filters}>
                {RUN_FILTERS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={styles.filter}
                    data-filter={key}
                    data-active={key === filter ? 'true' : undefined}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.card}>
              <div className={styles.runs}>
                {shownRuns.length > 0 ? (
                  shownRuns.map((run) => <RunRow key={run.runId} run={run} onOpen={onOpenRun} />)
                ) : (
                  <div className={styles.runsEmpty}>No runs in this view yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.side}>
          <div className={cx(styles.card, styles.railCard)}>
            <div className={styles.railEyebrow}>Last 30 days</div>
            <div className={styles.kpis}>
              <Kpi icon="Activity" label="Runs · 30d" value={d.kpis.total} />
              <Kpi icon="CheckCircle" label="Success" value={d.kpis.successPct} ok />
              <Kpi icon="Clock" label="Avg duration" value={d.kpis.avg} />
              <Kpi icon="Coin" label="Cost · 30d" value={d.kpis.cost} />
            </div>
          </div>
          <div className={cx(styles.card, styles.railCard)}>
            <div className={styles.railEyebrow}>Behavior</div>
            <BehaviorRow icon="Settings" label="Model" value={d.behavior.model} />
            <BehaviorRow icon="History" label="Run history" value={d.behavior.historyLabel} />
            <BehaviorRow icon="AlertTriangle" label="On failure" value={d.behavior.onFailure} />
            {d.tools.length > 0 ? (
              <div className={styles.toolsSec}>
                <div className={cx(styles.railEyebrow, styles.railEyebrowSub)}>Tools</div>
                <div className={styles.tools}>
                  {d.tools.map((t) => (
                    <span key={t} className={styles.toolChip}>
                      <span className={styles.toolIc} aria-hidden="true">
                        <Icon name="Plug" size={11} />
                      </span>
                      <code>{t}</code>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function BehaviorRow({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div className={styles.behRow}>
      <span className={styles.behIc} aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <span className={styles.behK}>{label}</span>
      <span className={styles.behV}>{value}</span>
    </div>
  );
}
