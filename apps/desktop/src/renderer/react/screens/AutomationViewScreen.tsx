import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuStatusKind,
  AutomationViewBridgeProps,
  AutomationViewData,
  AuViewRunDTO,
} from '../bridge.js';

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
      className="cd-au-run"
      data-ok={String(run.ok)}
      onClick={() => run.automationId && onOpen(run.automationId, run.runId)}
    >
      <span className="cd-au-run-ic" data-ok={String(run.ok)} aria-hidden="true">
        <Icon name={run.ok ? 'CheckCircle' : 'AlertCircle'} size={15} />
      </span>
      <span className="cd-au-run-sum">{run.summary}</span>
      <span className="cd-au-run-trig">
        <span aria-hidden="true">
          <Icon name={run.trigIcon as IconName} size={12} />
        </span>
        <span>{run.trigLabel}</span>
      </span>
      <span className="cd-au-run-when">
        <b>{run.whenLabel}</b>
        <span className="cd-au-run-when-meta">{run.metaLabel}</span>
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
    <div className="cd-au-kpi">
      <div className="cd-au-kpi-l">
        <span className="cd-au-kpi-ic" aria-hidden="true">
          <Icon name={icon} size={13} />
        </span>
        <span>{label}</span>
      </div>
      <div className="cd-au-kpi-v" data-ok={ok ? 'true' : undefined}>
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

  if (state === 'loading') return <div className="cd-au-loading">Loading automation…</div>;
  if (state === 'error') return <div className="cd-au-loading">Could not load automation.</div>;
  if (state === 'missing') return <div className="cd-au-loading">Automation not found.</div>;

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
    <div className="cd-au-view">
      <div className="cd-au-vhead">
        <div>
          <div className="cd-au-crumb">
            <button type="button" onClick={onBack}>
              Automations
            </button>
            <span className="cd-au-crumb-sep" aria-hidden="true">
              <Icon name="ArrowRight" size={12} />
            </span>
            <span>{d.name}</span>
          </div>
          <div className="cd-au-vtitle">
            <span className="cd-au-glyph" data-hue={d.hue} style={{ width: 46, height: 46 }}>
              <Icon name={d.glyphIcon as IconName} size={21} />
            </span>
            <div className="cd-au-vtitle-text">
              <h1>{d.name}</h1>
              {d.description ? <p className="cd-au-vsub">{d.description}</p> : null}
            </div>
          </div>
        </div>
        <div className="cd-au-actions">
          <button
            type="button"
            className="cd-au-btn cd-au-btn-danger cd-au-btn-icon"
            title="Delete automation"
            aria-label={`Delete ${d.name}`}
            disabled={busy}
            onClick={doDelete}
          >
            <Icon name="Trash" size={15} />
          </button>
          <button
            type="button"
            className="cd-au-btn cd-au-btn-ghost cd-au-btn-icon"
            title="Edit in builder"
            disabled={busy}
            onClick={onEdit}
          >
            <Icon name="Pencil" size={15} />
          </button>
          <button
            type="button"
            className="cd-au-btn cd-au-btn-primary"
            disabled={busy || running}
            onClick={doRun}
          >
            <Icon name="Play" size={14} />
            <span>{running ? 'Starting…' : 'Run now'}</span>
          </button>
        </div>
      </div>

      <div className="cd-au-hero" data-hue={d.hue}>
        <span className="cd-au-hero-icon" aria-hidden="true">
          <Icon name={d.heroIcon as IconName} size={26} />
        </span>
        <div className="cd-au-hero-main">
          <div className="cd-au-hero-eyebrow cd-au-hero-kind">{d.kindEyebrow}</div>
          <div className="cd-au-hero-when">{d.when}</div>
          {d.cronExprs.length > 0 ? (
            <div className="cd-au-hero-detail">
              {d.cronExprs.map((expr) => (
                <span key={expr} className="cd-au-hero-cron">
                  <span className="cd-au-hero-cron-ic" aria-hidden="true">
                    <Icon name="Braces" size={12} />
                  </span>
                  <code>{expr}</code>
                </span>
              ))}
            </div>
          ) : null}
          {d.nextRuns.length > 0 ? (
            <div className="cd-au-hero-next">
              <div className="cd-au-hero-next-lbl">Next 3 runs</div>
              <div className="cd-au-hero-next-pills">
                {d.nextRuns.map((label, i) => (
                  <span
                    key={label}
                    className="cd-au-hero-next-pill"
                    data-active={i === 0 ? 'true' : undefined}
                  >
                    <i className="cd-au-hero-next-dot" aria-hidden="true" />
                    <span>{label}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {d.webhook ? (
            d.webhook.pending || !d.webhook.url ? (
              <div className="cd-au-hero-webhook" data-provisioning="true">
                <span className="cd-au-status-ic" data-spin="true" aria-hidden="true">
                  <Icon name="Loader" size={13} />
                </span>
                <span>Provisioning endpoint… · secret minted server-side</span>
              </div>
            ) : (
              <div className="cd-au-hero-webhook">
                <span className="cd-au-hero-wh-ic" aria-hidden="true">
                  <Icon name="Webhook" size={14} />
                </span>
                <code className="cd-au-hero-wh-url">{d.webhook.url}</code>
                <button
                  type="button"
                  className="cd-au-hero-copy"
                  aria-label="Copy webhook URL"
                  title="Copy webhook URL"
                  onClick={() => d.webhook?.url && onCopyWebhook(d.webhook.url)}
                >
                  <Icon name="Copy" size={13} />
                </button>
                <span className="cd-au-hero-wh-note">
                  <span aria-hidden="true">
                    <Icon name="Key" size={12} />
                  </span>
                  Secret minted server-side
                </span>
              </div>
            )
          ) : null}
        </div>
        <div className="cd-au-hero-status">
          <span className="cd-au-status" data-tone={d.statusKind} role="status">
            <span className="cd-au-status-ic" aria-hidden="true">
              <Icon name={STATUS_ICON[d.statusKind]} size={12} />
            </span>
            <span className="cd-au-status-tx">{d.statusLabel}</span>
          </span>
          <div className="cd-au-hero-toggle">
            <span className="cd-au-hero-toggle-lbl">Enabled</span>
            <label className="cd-au-switch" title={d.enabled ? 'Disable' : 'Enable'}>
              <input
                type="checkbox"
                role="switch"
                aria-checked={d.enabled}
                aria-label={`${d.enabled ? 'Disable' : 'Enable'} ${d.name}`}
                checked={d.enabled}
                onChange={(e) => doToggle(e.target.checked)}
              />
              <span className="cd-au-switch-track" aria-hidden="true" />
            </label>
          </div>
        </div>
      </div>

      <div className="cd-au-cols">
        <div className="cd-au-col-main">
          <div className="cd-au-runhist">
            <div className="cd-au-runhist-h">
              <h2>Run history</h2>
              <div className="cd-au-filters">
                {RUN_FILTERS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className="cd-au-filter"
                    data-filter={key}
                    data-active={key === filter ? 'true' : undefined}
                    onClick={() => setFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cd-au-card">
              <div className="cd-au-runs">
                {shownRuns.length > 0 ? (
                  shownRuns.map((run) => <RunRow key={run.runId} run={run} onOpen={onOpenRun} />)
                ) : (
                  <div className="cd-au-runs-empty">No runs in this view yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="cd-au-side">
          <div className="cd-au-card cd-au-rail-card">
            <div className="cd-au-rail-eyebrow">Last 30 days</div>
            <div className="cd-au-kpis">
              <Kpi icon="Activity" label="Runs · 30d" value={d.kpis.total} />
              <Kpi icon="CheckCircle" label="Success" value={d.kpis.successPct} ok />
              <Kpi icon="Clock" label="Avg duration" value={d.kpis.avg} />
              <Kpi icon="Coin" label="Cost · 30d" value={d.kpis.cost} />
            </div>
          </div>
          <div className="cd-au-card cd-au-rail-card">
            <div className="cd-au-rail-eyebrow">Behavior</div>
            <BehaviorRow icon="Settings" label="Model" value={d.behavior.model} />
            <BehaviorRow icon="History" label="Run history" value={d.behavior.historyLabel} />
            <BehaviorRow icon="AlertTriangle" label="On failure" value={d.behavior.onFailure} />
            {d.tools.length > 0 ? (
              <div className="cd-au-tools-sec">
                <div className="cd-au-rail-eyebrow cd-au-rail-eyebrow-sub">Tools</div>
                <div className="cd-au-tools">
                  {d.tools.map((t) => (
                    <span key={t} className="cd-au-tool-chip">
                      <span className="cd-au-tool-ic" aria-hidden="true">
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
    <div className="cd-au-beh-row">
      <span className="cd-au-beh-ic" aria-hidden="true">
        <Icon name={icon} size={14} />
      </span>
      <span className="cd-au-beh-k">{label}</span>
      <span className="cd-au-beh-v">{value}</span>
    </div>
  );
}
