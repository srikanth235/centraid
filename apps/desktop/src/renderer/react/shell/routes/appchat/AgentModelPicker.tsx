import { type CSSProperties, type JSX, useCallback, useEffect, useReducer, useRef } from 'react';
import {
  getAgentsStatus,
  getRunnerStatus,
  getUserPrefs,
  saveUserPrefs,
} from '../../../../gateway-client.js';
import {
  AM_ACCENT,
  AM_BIN,
  AM_TITLE,
  isSwitchable,
  type RunnerKey,
  type SwitchableKind,
} from './appChatModel.js';
import styles from './AgentModelPicker.module.css';
import { cx } from '../../../ui/cx.js';

type AmAgents = Awaited<ReturnType<typeof getAgentsStatus>>;
type AmModel = NonNullable<Awaited<ReturnType<typeof getRunnerStatus>>['models']>[number];
type AmModelsStatus = Awaited<ReturnType<typeof getRunnerStatus>>['modelsStatus'];

const AM_TIERS: Array<[NonNullable<AmModel['tier']>, string]> = [
  ['smart', 'Most capable'],
  ['balanced', 'Balanced'],
  ['fast', 'Fastest'],
];

function CaretGlyph(): JSX.Element {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function RefreshGlyph(): JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/**
 * Coupled Agent · Model control for the copilot composer — a faithful port of
 * the vanilla `am*` subsystem in app-chat.ts. One pill reads "<Agent> · <Model>";
 * opening it reveals the agents (switching the active runner is a gateway-wide
 * change) and, below, the active runner's own models. The selection is keyed
 * per-runner (`chatModelByRunner`) so an agent switch can never leave a foreign
 * model id selected; a model gone stale within its runner is shown as an
 * explicit "unavailable" state with one-click repair, never silently re-sent.
 *
 * On mount it registers a model resolver with the parent copilot so `submit`
 * sends the runner's currently-pinned model (or the gateway default).
 */
export default function AgentModelPicker({
  active,
  registerModelResolver,
}: {
  active: boolean;
  registerModelResolver: (fn: () => Promise<string | undefined>) => void;
}): JSX.Element {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const amOpen = useRef(false);
  const amLoaded = useRef(false);
  const amActiveRunner = useRef<RunnerKey>('codex');
  const amAgents = useRef<AmAgents | null>(null);
  const amModels = useRef<AmModel[]>([]);
  const amModelsStatus = useRef<AmModelsStatus>(undefined);
  const amSelByRunner = useRef<Record<string, string>>({});
  const amSwitching = useRef(false);
  const amBusy = useRef(false);
  const amPollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const amPollDeadline = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const amAgentAvailable = useCallback(
    (kind: RunnerKey): boolean =>
      kind === 'codex' ? !!amAgents.current?.codexAvailable : !!amAgents.current?.claudeAvailable,
    [],
  );
  const amAgentVersion = useCallback(
    (kind: RunnerKey): string | undefined =>
      kind === 'codex' ? amAgents.current?.codexVersion : amAgents.current?.claudeVersion,
    [],
  );

  // The active runner's current selection: a gateway default, a valid pinned
  // model, or a pinned id no longer offered by the runner (stale).
  const amSelection = useCallback((): {
    mode: 'default' | 'pinned' | 'stale';
    id: string;
    model?: AmModel;
  } => {
    const saved = amSelByRunner.current[amActiveRunner.current];
    if (!saved) return { mode: 'default', id: '' };
    const model = amModels.current.find((m) => m.id === saved);
    return model ? { mode: 'pinned', id: saved, model } : { mode: 'stale', id: saved };
  }, []);

  const amModelName = (m: AmModel): string => m.name ?? m.id;

  const amClearPoll = useCallback((): void => {
    if (amPollTimer.current) {
      clearTimeout(amPollTimer.current);
      amPollTimer.current = undefined;
    }
  }, []);

  const amLoad = useCallback(
    async (opts: { refresh?: boolean; poll?: boolean } = {}): Promise<void> => {
      const [prefs, agents, status, settings] = await Promise.all([
        getUserPrefs().catch(() => ({}) as Record<string, unknown>),
        getAgentsStatus().catch(() => null),
        getRunnerStatus(opts.refresh ? { refresh: true } : {}).catch(() => null),
        window.CentraidApi.getSettings().catch(() => null),
      ]);
      // Trust the gateway's reported runner kind (incl. `openclaw`) so a remote
      // OpenClaw gateway isn't mislabelled as codex. Fall back to the local
      // agent pref only when the gateway didn't report a usable kind.
      const statusKind = status?.kind;
      amActiveRunner.current =
        statusKind === 'claude-code' || statusKind === 'codex' || statusKind === 'openclaw'
          ? statusKind
          : prefs['agent.runner.kind'] === 'claude-code'
            ? 'claude-code'
            : 'codex';
      amAgents.current = agents;
      amModels.current = status?.models ?? [];
      amModelsStatus.current = status?.modelsStatus;
      amSelByRunner.current = settings?.chatModelByRunner ?? {};
      amLoaded.current = true;
      // A fresh (non-poll) load opens a new polling window; polls reuse it.
      if (!opts.poll) amPollDeadline.current = Date.now() + 30_000;
      bump();
      // Poll runner-status while the gateway is still enumerating so the picker
      // fills in without the user doing anything. Bounded by the deadline.
      amClearPoll();
      if (amModelsStatus.current === 'loading' && Date.now() < amPollDeadline.current) {
        amPollTimer.current = setTimeout(() => void amLoad({ poll: true }), 800);
      }
    },
    [amClearPoll],
  );

  // Resolve the model id to send for the active runner. When loaded, use the
  // cached (optimistically-updated) per-runner selection; otherwise read
  // settings + the agent pref directly. `undefined` → gateway picks its default.
  useEffect(() => {
    registerModelResolver(async () => {
      if (amLoaded.current) {
        const saved = amSelByRunner.current[amActiveRunner.current];
        if (!saved) return undefined;
        // Don't send a model the runner no longer offers — that's the
        // "unavailable · won't be sent" state. Only suppress when we have a
        // catalog to check against.
        if (amModels.current.length && !amModels.current.some((m) => m.id === saved))
          return undefined;
        return saved;
      }
      const [settings, prefs] = await Promise.all([
        window.CentraidApi.getSettings(),
        getUserPrefs().catch(() => ({}) as Record<string, unknown>),
      ]);
      const kindRaw = prefs['agent.runner.kind'];
      const kind = typeof kindRaw === 'string' && kindRaw ? kindRaw : 'codex';
      return settings.chatModelByRunner?.[kind];
    });
  }, [registerModelResolver]);

  // Populate the pill when the panel first opens (mirrors vanilla toggle()).
  useEffect(() => {
    if (active && !amLoaded.current) void amLoad();
  }, [active, amLoad]);

  // Cleanup timers + close the pop on outside click / Escape.
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (amOpen.current && wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        amOpen.current = false;
        bump();
      }
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && amOpen.current) {
        amOpen.current = false;
        bump();
      }
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onEsc);
      amClearPoll();
    };
  }, [amClearPoll]);

  const amSwitchAgent = useCallback(
    async (kind: SwitchableKind): Promise<void> => {
      if (kind === amActiveRunner.current || amSwitching.current || !amAgentAvailable(kind)) return;
      amSwitching.current = true;
      bump();
      try {
        await saveUserPrefs({ 'agent.runner.kind': kind });
        amActiveRunner.current = kind;
        await amLoad({ refresh: true });
      } catch {
        /* keep the prior runner */
      } finally {
        amSwitching.current = false;
        bump();
      }
    },
    [amAgentAvailable, amLoad],
  );

  const amSelectModel = useCallback(async (id: string): Promise<void> => {
    // Optimistic local update, then persist just this runner's entry.
    if (id) amSelByRunner.current = { ...amSelByRunner.current, [amActiveRunner.current]: id };
    else {
      const next = { ...amSelByRunner.current };
      delete next[amActiveRunner.current];
      amSelByRunner.current = next;
    }
    amOpen.current = false;
    bump();
    try {
      await window.CentraidApi.saveSettings({ chatModelByRunner: { [amActiveRunner.current]: id } });
    } catch {
      /* best-effort; the next open reconciles from disk */
    }
  }, []);

  const amRefresh = useCallback(async (): Promise<void> => {
    amBusy.current = true;
    bump();
    try {
      await amLoad({ refresh: true });
    } finally {
      amBusy.current = false;
      bump();
    }
  }, [amLoad]);

  const toggleAm = useCallback((): void => {
    amOpen.current = !amOpen.current;
    if (amOpen.current && !amLoaded.current) void amLoad();
    bump();
  }, [amLoad]);

  // ── Render ────────────────────────────────────────────────────────────────
  const accent = AM_ACCENT[amActiveRunner.current];
  const sel = amSelection();
  const discovering = amModelsStatus.current === 'loading' && amModels.current.length === 0;
  const accentStyle = { '--am-accent': accent } as CSSProperties;

  const modelNode =
    sel.mode === 'default' ? (
      discovering ? (
        <span className={styles.chatAmDiscovering}>Discovering…</span>
      ) : (
        <span>Gateway default</span>
      )
    ) : sel.mode === 'pinned' ? (
      <span>{amModelName(sel.model as AmModel)}</span>
    ) : (
      <span className={styles.chatAmWarn} title={`${sel.id} is no longer available`}>
        ⚠ {sel.id}
      </span>
    );

  const agentCard = (kind: SwitchableKind): JSX.Element => {
    const isActive = kind === amActiveRunner.current;
    const available = amAgentAvailable(kind);
    const version = amAgentVersion(kind);
    const meta = !available ? 'not found' : version ? `${AM_BIN[kind]} · ${version}` : AM_BIN[kind];
    return (
      <button
        type="button"
        className={styles.chatAmAgentcard}
        aria-pressed={isActive ? 'true' : 'false'}
        disabled={!(available && !isActive)}
        style={{ '--am-accent': AM_ACCENT[kind] } as CSSProperties}
        onClick={() => void amSwitchAgent(kind)}
      >
        <span className={styles.chatAmAcTop}>
          <span className={styles.chatAmDot} style={{ background: AM_ACCENT[kind] }} />
          <span className={styles.chatAmAcName}>{AM_TITLE[kind]}</span>
        </span>
        <span className={styles.chatAmAcMeta}>{meta}</span>
        {isActive && <span className={styles.chatAmAcActive}>ACTIVE</span>}
      </button>
    );
  };

  const optionRow = (opts: {
    label: string;
    id: string;
    selected: boolean;
    hint?: string;
    isDefault?: boolean;
    onChoose: () => void;
  }): JSX.Element => (
    <button
      key={opts.id || '__default'}
      type="button"
      className={styles.chatAmOpt}
      role="menuitemradio"
      aria-checked={opts.selected ? 'true' : 'false'}
      onClick={() => opts.onChoose()}
    >
      <span className={styles.chatAmCheck}>{opts.selected ? '✓' : ''}</span>
      <span className={styles.chatAmOptLab}>
        {opts.label}
        {opts.hint && <small>{` · ${opts.hint}`}</small>}
      </span>
      {opts.id && <span className={styles.chatAmOptId}>{opts.id}</span>}
      {opts.isDefault && <span className={styles.chatAmTag}>default</span>}
    </button>
  );

  const tiered = amModels.current.some((m) => m.tier);
  const staleDefault = amModels.current.find((m) => m.default) ?? amModels.current[0];

  return (
    <div className={styles.chatAm} ref={wrapRef}>
      <button
        type="button"
        className={amBusy.current ? cx(styles.chatAmTrigger, styles.chatAmBusy) : styles.chatAmTrigger}
        aria-haspopup="true"
        aria-expanded={amOpen.current ? 'true' : 'false'}
        title="Agent and model"
        style={accentStyle}
        onClick={(e) => {
          e.stopPropagation();
          toggleAm();
        }}
      >
        <span className={cx(styles.chatAmSeg, styles.chatAmAgent)}>
          <span className={styles.chatAmDot} style={{ background: accent }} />
          {AM_TITLE[amActiveRunner.current]}
        </span>
        <span className={cx(styles.chatAmSeg, styles.chatAmModel)}>
          {modelNode}
          <span className={styles.chatAmCaret}>
            <CaretGlyph />
          </span>
        </span>
      </button>
      <div
        className={styles.chatAmPop}
        data-open={amOpen.current ? 'true' : undefined}
        role="menu"
        aria-label="Agent and model"
        style={accentStyle}
      >
        {!amLoaded.current ? (
          <div className={styles.chatAmLoading}>Loading agents…</div>
        ) : (
          <>
            <div className={styles.chatAmSeclabel}>Agent</div>
            {isSwitchable(amActiveRunner.current) ? (
              <div className={styles.chatAmAgentgrid}>
                {agentCard('codex')}
                {agentCard('claude-code')}
              </div>
            ) : (
              <div
                className={styles.chatAmAgentcard}
                aria-pressed="true"
                style={{ '--am-accent': AM_ACCENT[amActiveRunner.current] } as CSSProperties}
              >
                <span className={styles.chatAmAcTop}>
                  <span
                    className={styles.chatAmDot}
                    style={{ background: AM_ACCENT[amActiveRunner.current] }}
                  />
                  <span className={styles.chatAmAcName}>{AM_TITLE[amActiveRunner.current]}</span>
                </span>
                <span className={styles.chatAmAcMeta}>active runner</span>
              </div>
            )}
            <div className={styles.chatAmDivider} />
            <div className={styles.chatAmModelhead}>
              <span className={styles.chatAmModelfor}>
                Models for {AM_TITLE[amActiveRunner.current]}
              </span>
              <button
                type="button"
                className={
                  amModelsStatus.current === 'loading'
                    ? cx(styles.chatAmRefresh, styles.chatAmBusy)
                    : styles.chatAmRefresh
                }
                title="Re-enumerate from the runner"
                onClick={() => void amRefresh()}
              >
                <span className={styles.chatAmRefreshIcon}>
                  <RefreshGlyph />
                </span>
                Refresh
              </button>
            </div>
            {sel.mode === 'stale' && (
              <div className={styles.chatAmStale}>
                <span>Saved model </span>
                <b>{sel.id}</b>
                <span>
                  {` isn’t offered by ${AM_TITLE[amActiveRunner.current]} anymore. It won’t be sent.`}
                </span>
                <div className={styles.chatAmStaleFix}>
                  {staleDefault && (
                    <button
                      type="button"
                      className={cx(styles.chatAmStaleBtn, styles.chatAmStalePrimary)}
                      onClick={() => void amSelectModel(staleDefault.id)}
                    >
                      {`Use ${amModelName(staleDefault)}`}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.chatAmStaleBtn}
                    onClick={() => void amSelectModel('')}
                  >
                    Gateway default
                  </button>
                </div>
              </div>
            )}
            <div className={styles.chatAmModellist}>
              {optionRow({
                label: 'Gateway default',
                id: '',
                hint: 'runner decides',
                selected: sel.mode === 'default',
                onChoose: () => void amSelectModel(''),
              })}
              {amModels.current.length === 0 && amModelsStatus.current === 'loading' ? (
                <div className={styles.chatAmLoadrow}>
                  <div className={styles.chatAmLoaddots}>
                    <i />
                    <i />
                    <i />
                  </div>
                  <span>{`Discovering ${AM_TITLE[amActiveRunner.current]} models…`}</span>
                </div>
              ) : amModels.current.length === 0 ? (
                <div className={styles.chatAmEmpty}>
                  {`No models reported by ${AM_TITLE[amActiveRunner.current]}.`}
                </div>
              ) : tiered ? (
                AM_TIERS.map(([tier, label]) => {
                  const inTier = amModels.current.filter((m) => m.tier === tier);
                  if (!inTier.length) return null;
                  return (
                    <div key={tier}>
                      <div className={styles.chatAmTierlabel}>{label}</div>
                      {inTier.map((m) =>
                        optionRow({
                          label: amModelName(m),
                          id: m.id,
                          isDefault: m.default,
                          selected: sel.mode === 'pinned' && sel.id === m.id,
                          onChoose: () => void amSelectModel(m.id),
                        }),
                      )}
                    </div>
                  );
                })
              ) : (
                amModels.current.map((m) =>
                  optionRow({
                    label: amModelName(m),
                    id: m.id,
                    isDefault: m.default,
                    selected: sel.mode === 'pinned' && sel.id === m.id,
                    onChoose: () => void amSelectModel(m.id),
                  }),
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
