import { useEffect, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuStatusKind,
  RunLogRowDTO,
  RunNodeDTO,
  RunViewBridgeProps,
  RunViewSnapshot,
} from '../screen-contracts.js';
import { cx } from '../ui/cx.js';
import styles from './RunViewScreen.module.css';
import au from '../styles/automation.module.css';

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
    <span className={au.auStatus} data-tone={kind} role="status">
      <span
        className={au.auStatusIc}
        data-spin={kind === 'running' ? 'true' : undefined}
        aria-hidden="true"
      >
        <Icon name={STATUS_ICON[kind]} size={12} />
      </span>
      <span>{label}</span>
    </span>
  );
}

function TimelineNode({ node }: { node: RunNodeDTO }): JSX.Element {
  const [open, setOpen] = useState(false);
  const railIcon: IconName =
    node.status === 'running' ? 'Loader' : node.status === 'ok' ? 'CheckCircle' : 'AlertTriangle';
  return (
    <div className={styles.tlItem} data-status={node.status}>
      <span className={styles.tlRail} aria-hidden="true">
        <span className={styles.tlDot} data-spin={node.status === 'running' ? 'true' : undefined}>
          <Icon name={railIcon} size={node.status === 'running' ? 12 : 13} />
        </span>
        <span className={styles.tlLine} />
      </span>
      <div className={styles.tlCard} data-status={node.status}>
        <button
          type="button"
          className={styles.tlHead}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={styles.tlType} aria-hidden="true">
            <Icon name={node.typeIcon as IconName} size={13} />
          </span>
          <span className={styles.tlName}>{node.name}</span>
          <span className={styles.tlKind}>{node.kind}</span>
          <span className={styles.tlMeta}>{node.meta || '—'}</span>
          <span className={styles.tlChev} aria-hidden="true">
            <Icon name="ChevronRight" size={14} />
          </span>
        </button>
        <div className={styles.tlBody} hidden={!open}>
          {node.error ? <div className={styles.tlError}>{node.error}</div> : null}
          {node.response ? <div className={styles.tlResponse}>{node.response}</div> : null}
          {node.input ? (
            <>
              <div className={styles.stepLabel}>Input</div>
              <pre className={styles.stepPre}>{node.input}</pre>
            </>
          ) : null}
          {node.output ? (
            <>
              <div className={styles.stepLabel}>Output</div>
              <pre className={styles.stepPre}>{node.output}</pre>
            </>
          ) : null}
          {!node.error && !node.response && !node.input && !node.output ? (
            <div className={styles.stepEmpty}>No payload recorded.</div>
          ) : null}
        </div>
        {node.streaming && node.liveText ? (
          <div className={styles.tlStream}>
            <span className={styles.tlStreamTx}>{node.liveText}</span>
            <span className={styles.tlCaret} aria-hidden="true" />
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
    <div className={styles.logRow} data-tone={row.tone}>
      <span className={styles.logTime}>{row.time}</span>
      <div className={styles.logMain}>
        <div className={styles.logHead}>
          <span className={styles.logGlyph} data-status={row.tone} aria-hidden="true" />
          <span className={styles.logLabel}>{row.label}</span>
          {row.sub ? <span className={styles.logSub}>{row.sub}</span> : null}
        </div>
        {row.error ? <div className={styles.tlError}>{row.error}</div> : null}
        {row.response ? <div className={styles.logResponse}>{row.response}</div> : null}
        {row.input ? (
          <>
            <button
              type="button"
              className={styles.logChip}
              aria-expanded={openIn}
              onClick={() => setOpenIn((v) => !v)}
            >
              <Icon name="Braces" size={11} />
              <span>args</span>
            </button>
            <pre className={styles.logPre} hidden={!openIn}>
              {row.input}
            </pre>
          </>
        ) : null}
        {row.output ? (
          <>
            <button
              type="button"
              className={styles.logChip}
              aria-expanded={openOut}
              onClick={() => setOpenOut((v) => !v)}
            >
              <Icon name="Braces" size={11} />
              <span>output</span>
            </button>
            <pre className={styles.logPre} hidden={!openOut}>
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

  if (!snap) return <div className={au.auLoading}>Loading run…</div>;

  const setModeAnd = (m: 'timeline' | 'log'): void => {
    setMode(m);
    onSetMode(m);
  };

  const header = (
    <>
      <div className={au.auCrumb}>
        <button type="button" onClick={onBack}>
          Automations
        </button>
        <span className={au.auCrumbSep} aria-hidden="true">
          <Icon name="ArrowRight" size={12} />
        </span>
        <button type="button" onClick={onOpenAutomation}>
          {snap.crumbName}
        </button>
        <span className={au.auCrumbSep} aria-hidden="true">
          <Icon name="ArrowRight" size={12} />
        </span>
        <span>Run</span>
      </div>
      <div className={styles.rvHead}>
        <span className={au.auGlyph} data-hue={snap.hue} style={{ width: 42, height: 42 }}>
          <Icon name={snap.glyphIcon as IconName} size={19} />
        </span>
        <div className={styles.rvHeadMain}>
          <div className={styles.rvHeadName}>
            {snap.headerName}
            <StatusPill kind={snap.statusKind} label={snap.statusLabel} />
          </div>
          <div className={styles.rvHeadMeta}>{`${snap.startedLabel}  ·  ${snap.model}`}</div>
        </div>
        <div className={au.auActions}>
          <div className={styles.rvSeg} role="tablist" aria-label="Run view">
            {(['timeline', 'log'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={styles.rvSegB}
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
              className={cx(au.auBtn, au.auBtnGhost, styles.btnSm)}
              onClick={() => setDetailsHidden((v) => !v)}
            >
              <Icon name="Eye" size={13} />
              <span>{detailsHidden ? 'Show details' : 'Hide details'}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={cx(au.auBtn, au.auBtnGhost, styles.btnSm)}
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
      <div className={styles.rv}>
        {header}
        <div className={styles.log}>
          <div className={styles.logStats}>
            <div className={styles.logStat}>
              <div className={styles.logStatL}>Trigger</div>
              <div className={styles.logStatV}>
                <span className={styles.logStatTrig}>
                  <span className={styles.logStatIc} aria-hidden="true">
                    <Icon name={snap.logKpi.triggerIcon as IconName} size={13} />
                  </span>
                  <span>{snap.logKpi.triggerLabel}</span>
                </span>
              </div>
            </div>
            <div className={styles.logStat}>
              <div className={styles.logStatL}>Tokens</div>
              <div className={styles.logStatV}>{snap.logKpi.tokens}</div>
            </div>
            <div className={styles.logStat}>
              <div className={styles.logStatL}>Cost</div>
              <div className={styles.logStatV}>{snap.logKpi.cost}</div>
            </div>
            <div className={styles.logStat}>
              <div className={styles.logStatL}>Duration</div>
              <div className={styles.logStatV}>{snap.logKpi.duration}</div>
            </div>
            <div className={styles.logStat}>
              <div className={styles.logStatL}>Outcome</div>
              <div className={styles.logStatV}>
                <StatusPill kind={snap.side.outcomeKind} label={snap.side.outcomeLabel} />
              </div>
            </div>
          </div>
          <div className={styles.logPanel}>
            {snap.logRows.map((row, i) => (
              <LogRow key={`${row.tone}:${i}`} row={row} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.rv}>
      {header}
      <div className={detailsHidden ? cx(styles.rvGrid, styles.rvGridNarrow) : styles.rvGrid}>
        <div className={styles.rvThreadCol}>
          <div className={styles.tl}>
            <div className={styles.tlItem} data-status="trigger">
              <span className={styles.tlRail} aria-hidden="true">
                <span className={styles.tlDot}>
                  <Icon name={snap.triggerHeroIcon as IconName} size={13} />
                </span>
                <span className={styles.tlLine} />
              </span>
              <div className={cx(styles.tlCard, styles.tlCardTrigger)}>
                <div className={styles.tlTrigHead}>
                  <span className={styles.tlTrigLabel}>{snap.triggerLabel}</span>
                </div>
                <div className={styles.trigLine}>
                  <span aria-hidden="true">
                    <Icon name="Clock" size={14} />
                  </span>
                  {snap.triggersSummary}
                </div>
                <div className={cx(styles.trigInstr, styles.trigInstrOpen)}>{snap.promptInstr}</div>
              </div>
            </div>

            {snap.nodes.map((node) => (
              <TimelineNode key={node.ordinal} node={node} />
            ))}

            <div
              className={cx(styles.tlItem, styles.tlItemFinal)}
              data-status={snap.final.kind === 'pending' ? 'running' : snap.final.kind}
            >
              <span className={styles.tlRail} aria-hidden="true">
                <span
                  className={styles.tlDot}
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
                className={styles.tlCard}
                data-status={snap.final.kind === 'pending' ? 'running' : snap.final.kind}
              >
                <div className={cx(styles.tlHead, styles.tlHeadStatic)}>
                  <span className={styles.tlType} aria-hidden="true">
                    <Icon
                      name={snap.final.kind === 'fail' ? 'AlertTriangle' : 'Sparkle'}
                      size={13}
                    />
                  </span>
                  <span className={styles.tlName}>
                    {snap.final.kind === 'fail' ? 'Run failed' : `Centraid · ${snap.final.model}`}
                  </span>
                </div>
                {snap.final.kind === 'pending' ? (
                  <div className={styles.pending}>
                    <span className={styles.pendingDots} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>Working — this updates live as the run progresses.</span>
                  </div>
                ) : (
                  <div className={styles.tlFinalBody}>
                    {snap.final.kind === 'ok' ? (
                      <>
                        <p className={styles.replyLead}>
                          {snap.final.summary ?? 'The run completed.'}
                        </p>
                        {snap.final.output ? (
                          <>
                            <div className={styles.stepLabel}>Output</div>
                            <pre className={styles.stepPre}>{snap.final.output}</pre>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className={styles.replyLead}>This run did not complete.</p>
                        <div className={styles.tlError}>
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

        <div className={styles.rside}>
          <div className={styles.rsideCard}>
            <div className={styles.rsideH}>Run detail</div>
            <div className={styles.rsideRow}>
              <span className={styles.rsideK}>Outcome</span>
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
              <div key={k} className={styles.rsideRow}>
                <span className={styles.rsideK}>{k}</span>
                <span className={styles.rsideV}>{v}</span>
              </div>
            ))}
          </div>
          <div className={styles.rsideCard}>
            <div className={styles.rsideH}>Usage</div>
            {(
              [
                ['Tokens', snap.side.tokens],
                ['Cost', snap.side.cost],
                ['Steps', snap.side.steps],
                ['Model', snap.side.model],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className={styles.rsideRow}>
                <span className={styles.rsideK}>{k}</span>
                <span className={styles.rsideV}>{v}</span>
              </div>
            ))}
          </div>
          <div className={styles.rsideCard}>
            <div className={styles.rsideH}>Belongs to</div>
            <button type="button" className={styles.rsideLink} onClick={onOpenAutomation}>
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
