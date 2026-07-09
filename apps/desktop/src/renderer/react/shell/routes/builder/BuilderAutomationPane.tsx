import { type JSX, useEffect, useState } from 'react';
import { cronNextRuns, describeCron } from '../../../../cron.js';
import {
  listAutomationRuns,
  readAutomationRun,
  runAutomationNow,
} from '../../../../gateway-client.js';
import { iconSvg } from '../../iconSvg.js';
import styles from './BuilderAutomationPane.module.css';
import { cx } from '../../../ui/cx.js';

// React port of the vanilla builder's automation-mode right-pane views —
// Config / Flow / Runs / Code (see builder.ts `renderConfig` /
// `renderAutomationFlow` / `renderRuns` / `renderAutomationCode`). Config,
// Flow and Code are pure renders of the latest `automation.json` snapshot the
// shell re-reads after each agent turn; Runs owns its own fetch + run-now.
// Every class name matches the vanilla markup so the existing global styles in
// styles.css apply unchanged.

export interface BuilderAutomationPaneProps {
  tab: 'config' | 'flow' | 'runs' | 'code';
  appId: string;
  /** Latest automation.json snapshot the shell re-reads after each agent turn. */
  automationRow: CentraidAutomationRow | undefined;
  /** Config sections the last turn changed — flash a one-shot diff ribbon on each. */
  flashSections: ReadonlySet<string>;
}

// ---- helpers ported verbatim from builder.ts ----

// Relative "Nd ago" from an epoch-ms timestamp (builder.ts `relTime`).
function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Human retention label from the manifest's history.keep (builder.ts `fmtRetention`).
function fmtRetention(keep: CentraidAutomationManifest['history']['keep']): string {
  if (keep === 'all') return 'Keep all runs';
  if (keep === 'errors') return 'Keep failed runs only';
  if (typeof keep === 'object' && 'count' in keep) return `Last ${keep.count} runs`;
  if (typeof keep === 'object' && 'days' in keep) return `Last ${keep.days} days`;
  return '—';
}

function fmtNextRun(d: Date): string {
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Icon SVG strings — the exact glyphs + sizes the vanilla panes drew. Injected
// via dangerouslySetInnerHTML (the only sanctioned use here).
const svgCheck11 = iconSvg('Check', 11);
const svgHistory14 = iconSvg('History', 14);
const svgGlobe14 = iconSvg('Globe', 14);
const svgChevronDown14 = iconSvg('ChevronDown', 14);
const svgPlay12 = iconSvg('Play', 12);

/** Inline glyph span carrying a raw icon SVG string. */
function Glyph({ svg, className }: { svg: string; className?: string }): JSX.Element {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const LOADING = (wrapClass: string | undefined): JSX.Element => (
  <div className={wrapClass}>
    <p className={cx(styles.muted, styles.configLoading)}>Loading automation…</p>
  </div>
);

// ---------- Config view ----------

type ConfigSectionKey = 'what' | 'when' | 'behavior' | 'apps';

function ConfigView({
  automationRow,
  flashSections,
}: {
  automationRow: CentraidAutomationRow;
  flashSections: ReadonlySet<string>;
}): JSX.Element {
  const m = automationRow.manifest;
  const enabled = automationRow.enabled === true;

  // A titled section that flashes a one-shot diff ribbon when the latest chat
  // turn changed it. The shell owns/clears `flashSections`; we only read it.
  const Section = (key: ConfigSectionKey, label: string, body: JSX.Element): JSX.Element => {
    const flash = flashSections.has(key);
    return (
      <div
        key={key}
        className={flash ? cx(styles.section, styles.sectionFlash) : styles.section}
        data-section={key}
      >
        <div className={styles.sectionLabel}>
          <span>{label}</span>
          {flash ? (
            <span className={styles.diffRibbon}>
              <Glyph svg={svgCheck11} />
              Updated
            </span>
          ) : null}
        </div>
        {body}
      </div>
    );
  };

  const triggersBody =
    m.triggers.length === 0 ? (
      <div className={styles.triggers}>
        <p className={styles.muted}>Manual runs only — no schedule.</p>
      </div>
    ) : (
      <div className={styles.triggers}>
        {m.triggers.map((t, i) => {
          if (t.kind === 'cron') {
            const next = cronNextRuns(t.expr, 3);
            return (
              <div className={styles.trigger} key={i}>
                <div className={styles.triggerMain}>
                  <Glyph svg={svgHistory14} className={styles.triggerIcon} />
                  <span className={styles.triggerDesc}>{describeCron(t.expr)}</span>
                  <code className={styles.triggerExpr}>{t.expr}</code>
                </div>
                {next.length > 0 ? (
                  <div className={styles.nextruns}>
                    <span className={styles.muted}>Next: </span>
                    {next.map((d, j) => (
                      <span className={styles.nextrun} key={j}>
                        {fmtNextRun(d)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }
          // Webhook trigger — provisioned (has a minted route id) or pending.
          const pending = t.id === undefined;
          return (
            <div className={styles.trigger} key={i}>
              <div className={styles.triggerMain}>
                <Glyph svg={svgGlobe14} className={styles.triggerIcon} />
                <span className={styles.triggerDesc}>
                  {pending ? 'Webhook trigger — provisioning…' : 'Webhook trigger'}
                </span>
                {pending ? null : <code className={styles.triggerExpr}>{`/${t.id}`}</code>}
              </div>
              {pending ? (
                <div className={styles.nextruns}>
                  <span className={styles.muted}>A URL + secret are minted server-side.</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );

  const tools = m.requires.tools ?? [];
  const apps = m.apps ?? [];

  const cfgRow = (label: string, value: string): JSX.Element => (
    <div className={styles.row} key={label}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  );

  const behaviorBody = (
    <div className={styles.rows}>
      {cfgRow('Model', m.requires.model || 'Workspace default')}
      {cfgRow('Run history', fmtRetention(m.history.keep))}
      {m.onFailure ? cfgRow('On failure', `Run "${m.onFailure}"`) : null}
      {tools.length > 0 ? cfgRow('Tools', tools.join(', ')) : null}
    </div>
  );

  const appsBody =
    apps.length > 0 ? (
      <div className={styles.tags}>
        {apps.map((a) => (
          <span className={styles.tag} key={a}>
            {a}
          </span>
        ))}
      </div>
    ) : (
      <p className={styles.muted}>Not linked to any app.</p>
    );

  return (
    <div className={styles.config}>
      <div className={styles.configHead}>
        <div className={styles.configTitle}>{m.name || automationRow.id}</div>
        <span className={styles.chip} data-on={String(enabled)}>
          {enabled ? 'Enabled' : 'Draft'}
        </span>
      </div>
      {Section('what', 'What it does', <p className={styles.prompt}>{m.prompt || 'Not described yet.'}</p>)}
      {Section('when', 'When it runs', triggersBody)}
      {Section('behavior', 'Behavior', behaviorBody)}
      {Section('apps', 'Connected apps', appsBody)}
      <div className={styles.hint}>
        This view is filled in by the chat. Describe any change in the conversation.
      </div>
    </div>
  );
}

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
  sub?: string | null;
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
  sub?: string | null;
}

function FlowView({ automationRow }: { automationRow: CentraidAutomationRow }): JSX.Element {
  const m = automationRow.manifest;
  const stages: FlowStage[] = [];

  // Trigger.
  const t0 = (m.triggers ?? [])[0];
  let trigSvg = iconSvg('Play', 16);
  let trigTitle = 'Manual only';
  let trigSub: string | null = 'Runs only when you fire it.';
  if (t0) {
    if (t0.kind === 'cron') {
      trigSvg = iconSvg('Clock', 16);
      trigTitle = describeCron(t0.expr);
      const next = cronNextRuns(t0.expr, 1)[0];
      trigSub = next ? `Next: ${fmtNextRun(next)}` : t0.expr;
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
          className={cx("btn", "btn-primary", styles.runbtn)}
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
                  <span className={styles.runTrigger}>{r.triggerKind}</span>
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
