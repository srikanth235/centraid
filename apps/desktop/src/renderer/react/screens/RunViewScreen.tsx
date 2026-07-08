import { useEffect, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuStatusKind,
  RunLogRowDTO,
  RunNodeDTO,
  RunViewBridgeProps,
  RunViewSnapshot,
} from '../bridge.js';

const STATUS_ICON: Record<AuStatusKind, IconName> = {
  active: 'Power',
  paused: 'Pause',
  draft: 'Pencil',
  running: 'Loader',
  success: 'CheckCircle',
  failed: 'AlertTriangle',
};

function StatusPill({ kind, label }: { kind: AuStatusKind; label: string }): JSX.Element {
  return (
    <span className="cd-au-status" data-tone={kind} role="status">
      <span
        className="cd-au-status-ic"
        data-spin={kind === 'running' ? 'true' : undefined}
        aria-hidden="true"
      >
        <Icon name={STATUS_ICON[kind]} size={12} />
      </span>
      <span className="cd-au-status-tx">{label}</span>
    </span>
  );
}

function TimelineNode({ node }: { node: RunNodeDTO }): JSX.Element {
  const [open, setOpen] = useState(false);
  const railIcon: IconName =
    node.status === 'running' ? 'Loader' : node.status === 'ok' ? 'CheckCircle' : 'AlertTriangle';
  return (
    <div className="cd-au-tl-item" data-status={node.status}>
      <span className="cd-au-tl-rail" aria-hidden="true">
        <span className="cd-au-tl-dot" data-spin={node.status === 'running' ? 'true' : undefined}>
          <Icon name={railIcon} size={node.status === 'running' ? 12 : 13} />
        </span>
        <span className="cd-au-tl-line" />
      </span>
      <div className="cd-au-tl-card" data-status={node.status}>
        <button
          type="button"
          className="cd-au-tl-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="cd-au-tl-type" aria-hidden="true">
            <Icon name={node.typeIcon as IconName} size={13} />
          </span>
          <span className="cd-au-tl-name">{node.name}</span>
          <span className="cd-au-tl-kind">{node.kind}</span>
          <span className="cd-au-tl-meta">{node.meta || '—'}</span>
          <span className="cd-au-tl-chev" aria-hidden="true">
            <Icon name="ChevronRight" size={14} />
          </span>
        </button>
        <div className="cd-au-tl-body" hidden={!open}>
          {node.error ? <div className="cd-au-tl-error">{node.error}</div> : null}
          {node.response ? <div className="cd-au-tl-response">{node.response}</div> : null}
          {node.input ? (
            <>
              <div className="cd-au-step-label">Input</div>
              <pre className="cd-au-step-pre">{node.input}</pre>
            </>
          ) : null}
          {node.output ? (
            <>
              <div className="cd-au-step-label">Output</div>
              <pre className="cd-au-step-pre">{node.output}</pre>
            </>
          ) : null}
          {!node.error && !node.response && !node.input && !node.output ? (
            <div className="cd-au-step-empty">No payload recorded.</div>
          ) : null}
        </div>
        {node.streaming && node.liveText ? (
          <div className="cd-au-tl-stream">
            <span className="cd-au-tl-stream-tx">{node.liveText}</span>
            <span className="cd-au-tl-caret" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LogRow({ row }: { row: RunLogRowDTO }): JSX.Element {
  const [openIn, setOpenIn] = useState(false);
  const [openOut, setOpenOut] = useState(false);
  return (
    <div className="cd-au-log-row" data-tone={row.tone}>
      <span className="cd-au-log-time">{row.time}</span>
      <div className="cd-au-log-main">
        <div className="cd-au-log-head">
          <span className="cd-au-log-glyph" data-status={row.tone} aria-hidden="true" />
          <span className="cd-au-log-label">{row.label}</span>
          {row.sub ? <span className="cd-au-log-sub">{row.sub}</span> : null}
        </div>
        {row.error ? <div className="cd-au-tl-error">{row.error}</div> : null}
        {row.response ? <div className="cd-au-log-response">{row.response}</div> : null}
        {row.input ? (
          <>
            <button
              type="button"
              className="cd-au-log-chip"
              aria-expanded={openIn}
              onClick={() => setOpenIn((v) => !v)}
            >
              <Icon name="Braces" size={11} />
              <span>args</span>
            </button>
            <pre className="cd-au-log-pre" hidden={!openIn}>
              {row.input}
            </pre>
          </>
        ) : null}
        {row.output ? (
          <>
            <button
              type="button"
              className="cd-au-log-chip"
              aria-expanded={openOut}
              onClick={() => setOpenOut((v) => !v)}
            >
              <Icon name="Braces" size={11} />
              <span>output</span>
            </button>
            <pre className="cd-au-log-pre" hidden={!openOut}>
              {row.output}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Automation run-viewer, ported to React (issue #325, Phase 3). The vanilla
 * side owns the SSE stream + node model and pushes a fully-derived snapshot on
 * each event via the `update` fn handed to `onReady`; React renders the
 * timeline (rail + node cards + final outcome + KPI rail) or log (KPI strip +
 * transcript rows) mode. Same `cd-au-*` classes.
 */
export default function RunViewScreen({
  initialMode,
  onReady,
  onBack,
  onOpenAutomation,
  onRunAgain,
  onSetMode,
}: RunViewBridgeProps): JSX.Element {
  const [snap, setSnap] = useState<RunViewSnapshot | null>(null);
  const [mode, setMode] = useState(initialMode);
  const [detailsHidden, setDetailsHidden] = useState(false);

  useEffect(() => {
    onReady((s) => setSnap(s));
  }, [onReady]);

  if (!snap) return <div className="cd-au-loading">Loading run…</div>;

  const setModeAnd = (m: 'timeline' | 'log'): void => {
    setMode(m);
    onSetMode(m);
  };

  const header = (
    <>
      <div className="cd-au-crumb">
        <button type="button" onClick={onBack}>
          Automations
        </button>
        <span className="cd-au-crumb-sep" aria-hidden="true">
          <Icon name="ArrowRight" size={12} />
        </span>
        <button type="button" onClick={onOpenAutomation}>
          {snap.crumbName}
        </button>
        <span className="cd-au-crumb-sep" aria-hidden="true">
          <Icon name="ArrowRight" size={12} />
        </span>
        <span>Run</span>
      </div>
      <div className="cd-au-rv-head">
        <span className="cd-au-glyph" data-hue={snap.hue} style={{ width: 42, height: 42 }}>
          <Icon name={snap.glyphIcon as IconName} size={19} />
        </span>
        <div className="cd-au-rv-head-main">
          <div className="cd-au-rv-head-name">
            {snap.headerName}
            <StatusPill kind={snap.statusKind} label={snap.statusLabel} />
          </div>
          <div className="cd-au-rv-head-meta">{`${snap.startedLabel}  ·  ${snap.model}`}</div>
        </div>
        <div className="cd-au-actions">
          <div className="cd-au-rv-seg" role="tablist" aria-label="Run view">
            {(['timeline', 'log'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className="cd-au-rv-seg-b"
                role="tab"
                aria-selected={mode === k}
                data-active={mode === k ? 'true' : undefined}
                onClick={() => setModeAnd(k)}
              >
                <Icon name={k === 'timeline' ? 'Activity' : 'Braces'} size={12} />
                <span>{k === 'timeline' ? 'Timeline' : 'Log'}</span>
              </button>
            ))}
          </div>
          {mode === 'timeline' ? (
            <button
              type="button"
              className="cd-au-btn cd-au-btn-ghost cd-au-btn-sm"
              onClick={() => setDetailsHidden((v) => !v)}
            >
              <Icon name="Eye" size={13} />
              <span>{detailsHidden ? 'Show details' : 'Hide details'}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="cd-au-btn cd-au-btn-ghost cd-au-btn-sm"
            onClick={onRunAgain}
          >
            <Icon name="Reset" size={13} />
            <span>Run again</span>
          </button>
        </div>
      </div>
    </>
  );

  if (mode === 'log') {
    return (
      <div className="cd-au-rv">
        {header}
        <div className="cd-au-log">
          <div className="cd-au-log-stats">
            <div className="cd-au-log-stat">
              <div className="cd-au-log-stat-l">Trigger</div>
              <div className="cd-au-log-stat-v">
                <span className="cd-au-log-stat-trig">
                  <span className="cd-au-log-stat-ic" aria-hidden="true">
                    <Icon name={snap.logKpi.triggerIcon as IconName} size={13} />
                  </span>
                  <span>{snap.logKpi.triggerLabel}</span>
                </span>
              </div>
            </div>
            <div className="cd-au-log-stat">
              <div className="cd-au-log-stat-l">Tokens</div>
              <div className="cd-au-log-stat-v">{snap.logKpi.tokens}</div>
            </div>
            <div className="cd-au-log-stat">
              <div className="cd-au-log-stat-l">Cost</div>
              <div className="cd-au-log-stat-v">{snap.logKpi.cost}</div>
            </div>
            <div className="cd-au-log-stat">
              <div className="cd-au-log-stat-l">Duration</div>
              <div className="cd-au-log-stat-v">{snap.logKpi.duration}</div>
            </div>
            <div className="cd-au-log-stat">
              <div className="cd-au-log-stat-l">Outcome</div>
              <div className="cd-au-log-stat-v">
                <StatusPill kind={snap.side.outcomeKind} label={snap.side.outcomeLabel} />
              </div>
            </div>
          </div>
          <div className="cd-au-log-panel">
            {snap.logRows.map((row, i) => (
              <LogRow key={`${row.tone}:${i}`} row={row} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cd-au-rv">
      {header}
      <div className={detailsHidden ? 'cd-au-rv-grid cd-au-rv-grid--narrow' : 'cd-au-rv-grid'}>
        <div className="cd-au-rv-thread-col">
          <div className="cd-au-tl">
            <div className="cd-au-tl-item" data-status="trigger">
              <span className="cd-au-tl-rail" aria-hidden="true">
                <span className="cd-au-tl-dot">
                  <Icon name={snap.triggerHeroIcon as IconName} size={13} />
                </span>
                <span className="cd-au-tl-line" />
              </span>
              <div className="cd-au-tl-card cd-au-tl-card-trigger">
                <div className="cd-au-tl-trig-head">
                  <span className="cd-au-tl-trig-label">{snap.triggerLabel}</span>
                </div>
                <div className="cd-au-trig-line">
                  <span aria-hidden="true">
                    <Icon name="Clock" size={14} />
                  </span>
                  {snap.triggersSummary}
                </div>
                <div className="cd-au-trig-instr cd-au-trig-instr--open">{snap.promptInstr}</div>
              </div>
            </div>

            {snap.nodes.map((node) => (
              <TimelineNode key={node.ordinal} node={node} />
            ))}

            <div
              className="cd-au-tl-item cd-au-tl-item-final"
              data-status={snap.final.kind === 'pending' ? 'running' : snap.final.kind}
            >
              <span className="cd-au-tl-rail" aria-hidden="true">
                <span
                  className="cd-au-tl-dot"
                  data-spin={snap.final.kind === 'pending' ? 'true' : undefined}
                >
                  <Icon
                    name={
                      snap.final.kind === 'pending'
                        ? 'Loader'
                        : snap.final.kind === 'ok'
                          ? 'CheckCircle'
                          : 'AlertTriangle'
                    }
                    size={snap.final.kind === 'pending' ? 12 : 13}
                  />
                </span>
              </span>
              <div
                className="cd-au-tl-card"
                data-status={snap.final.kind === 'pending' ? 'running' : snap.final.kind}
              >
                <div className="cd-au-tl-head cd-au-tl-head-static">
                  <span className="cd-au-tl-type" aria-hidden="true">
                    <Icon
                      name={snap.final.kind === 'fail' ? 'AlertTriangle' : 'Sparkle'}
                      size={13}
                    />
                  </span>
                  <span className="cd-au-tl-name">
                    {snap.final.kind === 'fail' ? 'Run failed' : `Centraid · ${snap.final.model}`}
                  </span>
                </div>
                {snap.final.kind === 'pending' ? (
                  <div className="cd-au-pending">
                    <span className="cd-au-pending-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>Working — this updates live as the run progresses.</span>
                  </div>
                ) : (
                  <div className="cd-au-tl-final-body">
                    {snap.final.kind === 'ok' ? (
                      <>
                        <p className="cd-au-reply-lead">
                          {snap.final.summary ?? 'The run completed.'}
                        </p>
                        {snap.final.output ? (
                          <>
                            <div className="cd-au-step-label">Output</div>
                            <pre className="cd-au-step-pre">{snap.final.output}</pre>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="cd-au-reply-lead">This run did not complete.</p>
                        <div className="cd-au-tl-error">
                          {snap.final.error ?? 'No error detail was recorded.'}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="cd-au-rside">
          <div className="cd-au-rside-card">
            <div className="cd-au-rside-h">Run detail</div>
            <div className="cd-au-rside-row">
              <span className="cd-au-rside-k">Outcome</span>
              <StatusPill kind={snap.side.outcomeKind} label={snap.side.outcomeLabel} />
            </div>
            {(
              [
                ['Trigger', snap.side.trigger],
                ['Duration', snap.side.duration],
                ['Started', snap.side.started],
                ['Run ID', snap.side.runId],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="cd-au-rside-row">
                <span className="cd-au-rside-k">{k}</span>
                <span className="cd-au-rside-v">{v}</span>
              </div>
            ))}
          </div>
          <div className="cd-au-rside-card">
            <div className="cd-au-rside-h">Usage</div>
            {(
              [
                ['Tokens', snap.side.tokens],
                ['Cost', snap.side.cost],
                ['Steps', snap.side.steps],
                ['Model', snap.side.model],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="cd-au-rside-row">
                <span className="cd-au-rside-k">{k}</span>
                <span className="cd-au-rside-v">{v}</span>
              </div>
            ))}
          </div>
          <div className="cd-au-rside-card">
            <div className="cd-au-rside-h">Belongs to</div>
            <button type="button" className="cd-au-rside-link" onClick={onOpenAutomation}>
              <span>{snap.crumbName}</span>
              <span aria-hidden="true">
                <Icon name="ArrowRight" size={14} />
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
