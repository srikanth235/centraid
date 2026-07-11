import { type JSX, type ReactNode, useEffect, useState } from 'react';
import { cronNextRuns, describeCron } from '../../../../cron.js';
import {
  listAutomationRuns,
  readAutomationRun,
  runAutomationNow,
} from '../../../../gateway-client.js';
import { iconSvg } from '../../iconSvg.js';
import { formatWhereClauses } from './BuilderAutomationTriggers.js';
import {
  Glyph,
  fmtRetention,
  fmtNextRun,
  relTime,
  runOriginLabel,
} from './BuilderAutomationPaneShared.js';
import ConfigView from './BuilderAutomationConfigView.js';
import styles from './BuilderAutomationPane.module.css';
import buttonCss from '../../../ui/Button.module.css';
import { cx } from '../../../ui/cx.js';

// React port of the vanilla builder's automation-mode right-pane views —
// Config / Flow / Runs / Code (see builder.ts `renderConfig` /
// `renderAutomationFlow` / `renderRuns` / `renderAutomationCode`). Flow and
// Code are pure renders of the latest `automation.json` snapshot the shell
// re-reads after each agent turn; Config (BuilderAutomationConfigView.tsx)
// also owns the trigger add/edit/remove UI (GAP 1); Runs owns its own fetch
// + run-now. Every class name matches the vanilla markup so the existing
// global styles in styles.css apply unchanged.

export interface BuilderAutomationPaneProps {
  tab: 'config' | 'flow' | 'runs' | 'code';
  appId: string;
  /** Latest automation.json snapshot the shell re-reads after each agent turn. */
  automationRow: CentraidAutomationRow | undefined;
  /** Config sections the last turn changed — flash a one-shot diff ribbon on each. */
  flashSections: ReadonlySet<string>;
}

// Icon SVG strings — the exact glyphs + sizes the vanilla panes drew. Injected
// via dangerouslySetInnerHTML (the only sanctioned use here).
const svgChevronDown14 = iconSvg('ChevronDown', 14);
const svgPlay12 = iconSvg('Play', 12);

const LOADING = (wrapClass: string | undefined): JSX.Element => (
  <div className={wrapClass}>
    <p className={cx(styles.muted, styles.configLoading)}>Loading automation…</p>
  </div>
);

// ---------- Code view ----------

function CodeView({ automationRow }: { automationRow: CentraidAutomationRow }): JSX.Element {
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <span className={styles.codeFile}>automation.json</span>
        <span className={styles.codeTag}>read-only</span>
      </div>
      <pre className={styles.codePre}>{JSON.stringify(automationRow.manifest, null, 2)}</pre>
    </div>
  );
}

// ---------- Flow view ----------

function FlowNode({
  svg,
  kind,
  title,
  sub,
}: {
  svg: string;
  kind: string;
  title: string;
  // ReactNode (not just string) so the condition trigger's `where` clause can
  // render as a monospace block (GAP 2) instead of being flattened into text.
  sub?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.flowNode}>
      <Glyph svg={svg} className={styles.flowIc} />
      <div className={styles.flowBody}>
        <div className={styles.flowKind}>{kind}</div>
        <div className={styles.flowTitle}>{title}</div>
        {sub ? <div className={styles.flowSub}>{sub}</div> : null}
      </div>
    </div>
  );
}

function FlowConnector(): JSX.Element {
  return (
    <div className={styles.flowConn} aria-hidden="true">
      <span className={styles.flowConnLine} />
      <Glyph svg={svgChevronDown14} className={styles.flowConnChev} />
    </div>
  );
}

interface FlowStage {
  svg: string;
  kind: string;
  title: string;
  sub?: ReactNode;
}

function FlowView({ automationRow }: { automationRow: CentraidAutomationRow }): JSX.Element {
  const m = automationRow.manifest;
  const stages: FlowStage[] = [];

  // Trigger.
  const t0 = (m.triggers ?? [])[0];
  let trigSvg = iconSvg('Play', 16);
  let trigTitle = 'Manual only';
  let trigSub: ReactNode = 'Runs only when you fire it.';
  if (t0) {
    if (t0.kind === 'cron') {
      trigSvg = iconSvg('Clock', 16);
      trigTitle = describeCron(t0.expr);
      const next = cronNextRuns(t0.expr, 1)[0];
      trigSub = next ? `Next: ${fmtNextRun(next)}` : t0.expr;
    } else if (t0.kind === 'data') {
      trigSvg = iconSvg('Clock', 16);
      trigTitle = 'Data trigger';
      trigSub = `Fires on changes to ${t0.entities.join(', ')}`;
    } else if (t0.kind === 'condition') {
      trigSvg = iconSvg('Clock', 16);
      trigTitle = 'Condition trigger';
      // GAP 2: render the actual `where` clause instead of hiding it.
      const whereText = formatWhereClauses(t0.where);
      trigSub = (
        <>
          <span>Fires when {t0.entity} matches its condition</span>
          {whereText ? <pre className={styles.whereBlock}>{whereText}</pre> : null}
        </>
      );
    } else {
      trigSvg = iconSvg('Webhook', 16);
      trigTitle = t0.id ? 'Webhook' : 'Webhook — provisioning…';
      trigSub = t0.id ? `/${t0.id}` : 'A URL + secret are minted server-side.';
    }
  }
  stages.push({ svg: trigSvg, kind: 'Trigger', title: trigTitle, sub: trigSub });

  // Agent.
  stages.push({
    svg: iconSvg('Sparkle', 16),
    kind: 'Agent',
    title: m.requires.model || 'Workspace default',
    sub: m.prompt || 'Not described yet.',
  });

  // Connected apps / tools (optional).
  const connected = [...(m.requires.mcps ?? []), ...(m.apps ?? [])];
  if (connected.length > 0) {
    stages.push({ svg: iconSvg('Plug', 16), kind: 'Connected', title: connected.join(', ') });
  }

  // Outcome.
  stages.push({
    svg: iconSvg('Check', 16),
    kind: 'Outcome',
    title: 'Run recorded',
    sub: m.onFailure ? `On failure: run "${m.onFailure}"` : fmtRetention(m.history.keep),
  });

  return (
    <div className={styles.flow}>
      {stages.map((s, i) => (
        <div key={i} style={{ display: 'contents' }}>
          {i > 0 ? <FlowConnector /> : null}
          <FlowNode svg={s.svg} kind={s.kind} title={s.title} sub={s.sub} />
        </div>
      ))}
      <div className={styles.hint}>
        The flow is derived from automation.json — describe changes in the chat.
      </div>
    </div>
  );
}

// ---------- Runs view ----------

function RunsView({ appId }: { appId: string }): JSX.Element {
  const [runs, setRuns] = useState<CentraidAutomationRunRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!appId) return;
    let alive = true;
    setRuns(null);
    setFailed(false);
    listAutomationRuns({ automationId: appId, limit: 20 })
      .then((r) => {
        if (alive) setRuns(r);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [appId, nonce]);

  // Fire the automation once now and poll the ledger for the finished record,
  // then refresh the list (builder.ts `runAutomationOnce`, minus the chat
  // message-model side effects the shell owns).
  const runOnce = async (): Promise<void> => {
    if (!appId || busy) return;
    setBusy(true);
    try {
      const { runId } = await runAutomationNow({ automationId: appId });
      const deadline = Date.now() + 6 * 60 * 1000;
      let rec: CentraidAutomationRunRecord | null = null;
      while (Date.now() < deadline) {
        rec = await readAutomationRun({ runId });
        if (rec && rec.endedAt !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch {
      // Surfaced through the refreshed run list below.
    } finally {
      setBusy(false);
      setNonce((n) => n + 1);
    }
  };

  return (
    <div className={styles.runs}>
      <div className={styles.runsHead}>
        <div className={styles.runsHeadText}>
          <div className={styles.sectionLabel}>Test run</div>
          <p className={styles.muted}>
            Fire the automation once now, without waiting for the schedule.
          </p>
        </div>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, styles.runbtn)}
          disabled={busy}
          onClick={() => {
            void runOnce();
          }}
        >
          <Glyph svg={svgPlay12} />
          <span>Run once</span>
        </button>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Recent runs</div>
        <div className={styles.runlist}>
          {failed ? (
            <p className={styles.muted}>Could not load run history.</p>
          ) : runs === null ? (
            <p className={styles.muted}>Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className={styles.muted}>No runs yet. Use "Run once" to test it.</p>
          ) : (
            runs.map((r) => {
              const dur =
                r.endedAt !== undefined ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : '—';
              return (
                <div className={styles.runrow} data-ok={String(r.ok)} key={r.runId}>
                  <span className={styles.runDot} data-ok={String(r.ok)} />
                  <span className={styles.runSummary}>
                    {r.summary || r.error || (r.ok ? 'Completed' : 'Failed')}
                  </span>
                  <span className={styles.runTrigger}>{runOriginLabel(r)}</span>
                  <span className={styles.runMeta}>{`${dur} · ${relTime(r.startedAt)}`}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Root ----------

export default function BuilderAutomationPane(props: BuilderAutomationPaneProps): JSX.Element {
  const { tab, appId, automationRow, flashSections } = props;

  if (tab === 'runs') return <RunsView appId={appId} />;

  if (tab === 'config') {
    if (!automationRow) return LOADING(styles.config);
    return <ConfigView automationRow={automationRow} flashSections={flashSections} />;
  }
  if (tab === 'flow') {
    if (!automationRow) return LOADING(styles.flow);
    return <FlowView automationRow={automationRow} />;
  }
  // tab === 'code'
  if (!automationRow) return LOADING(styles.code);
  return <CodeView automationRow={automationRow} />;
}
