import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import Button from '../ui/Button.js';
import type {
  AgentCardDTO,
  AgentRunnerKind,
  AgentsStatusDTO,
  ModelSubsystem,
  SettingsProvidersBridgeProps,
} from '../screen-contracts.js';
import { DrawerGroup } from './settings-controls.js';
import AgentEntry from './SettingsProvidersAgents.js';
import { ModelSelect, Select, modelLabel } from './SettingsProvidersSelects.js';
import styles from './SettingsProvidersScreen.module.css';
import controlsCss from '../styles/controls.module.css';

const POLL_MS = 800;
const POLL_WINDOW_MS = 30_000;

/**
 * The routing lanes. Each resolves independently to an (agent, model) pair —
 * a lane left unset inherits the default lane. Before per-subsystem runners
 * these were model-only overrides hanging off one globally-active agent.
 */
const SUBSYSTEM_ROWS: ReadonlyArray<{ key: ModelSubsystem; label: string; hint: string }> = [
  { key: 'assistant', label: 'Assistant', hint: 'Global Ask across your vault.' },
  { key: 'ask', label: 'In-app Ask', hint: 'The Ask panel inside each app.' },
  { key: 'builder', label: 'Builder', hint: 'The app-building agent.' },
  { key: 'automations', label: 'Automations', hint: 'Background automations & enrichers.' },
];

/**
 * One routing lane. `runner === ''` means inherit the default lane, and the
 * inherit option names what it resolves to — "Use default model" alone told you
 * nothing about what would actually run, and with agents inheriting too that
 * ambiguity would have doubled.
 */
function RouteRow({
  label,
  hint,
  cards,
  runner,
  model,
  resolvedCard,
  resolvedAgentDefault,
  defaultCard,
  onSetRunner,
  onSetModel,
}: {
  label: string;
  hint: string;
  cards: AgentCardDTO[];
  runner: AgentRunnerKind | '';
  model: string;
  resolvedCard: AgentCardDTO | undefined;
  /** The resolved agent's own default model id — what this lane inherits. */
  resolvedAgentDefault: string;
  defaultCard: AgentCardDTO | undefined;
  onSetRunner: (v: string) => void;
  onSetModel: (v: string) => void;
}): JSX.Element {
  return (
    <div
      className={styles.routeRow}
      style={{ '--route-accent': resolvedCard?.accent } as CSSProperties}
    >
      <div className={styles.routeMeta}>
        <div className={styles.routeName}>
          <span className={styles.routeDot} />
          {label}
        </div>
        <span className={styles.routeHint}>{hint}</span>
      </div>
      <Select
        value={runner}
        onChange={onSetRunner}
        inherited={!runner}
        ariaLabel={`Agent for ${label}`}
      >
        <option value="">
          {defaultCard ? `Use default · ${defaultCard.title}` : 'Use default'}
        </option>
        {cards.map((c) => (
          <option key={c.kind} value={c.kind} disabled={!c.connected}>
            {c.connected ? c.title : `${c.title} · unavailable`}
          </option>
        ))}
      </Select>
      {resolvedCard ? (
        <ModelSelect
          card={resolvedCard}
          saved={model}
          onChange={onSetModel}
          emptyLabel={`Use default · ${modelLabel(resolvedCard, resolvedAgentDefault)}`}
          ariaLabel={`Model for ${label}`}
        />
      ) : (
        <span className={styles.routeHint}>—</span>
      )}
    </div>
  );
}

/**
 * Settings → Agents. Two sections, and the split is the point: **Routing** is
 * where every decision lives (each subsystem resolves to its own agent and
 * model), **Agents** is inventory — what is installed, what it exposes, and
 * which lanes land on it.
 *
 * The page previously led with an exclusive Codex/Claude-Code radio, because
 * exactly one agent could be active. Per-subsystem runners retire that
 * premise: there is no "active" agent any more, only a *default* one that
 * unset lanes fall back to — so it became the first lane of the same table
 * rather than a separate control above it.
 */
export default function SettingsProvidersScreen({
  loadStatus,
  refreshModels,
  activateRunner,
  setAgentModel,
  setSubsystemModel,
  setSubsystemRunner,
}: SettingsProvidersBridgeProps): JSX.Element {
  const [status, setStatus] = useState<AgentsStatusDTO | null>(null);
  const [defaultKind, setDefaultKind] = useState<AgentRunnerKind>('codex');
  const [savedByKind, setSavedByKind] = useState<Record<string, string>>({});
  const [subsystemByKind, setSubsystemByKind] = useState<
    Record<string, Partial<Record<ModelSubsystem, string>>>
  >({});
  const [runnerBySubsystem, setRunnerBySubsystem] = useState<
    Partial<Record<ModelSubsystem, AgentRunnerKind>>
  >({});
  const [busyModels, setBusyModels] = useState(false);
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((s: AgentsStatusDTO) => {
    setStatus(s);
    setDefaultKind(s.selectedKind);
    setSavedByKind(s.savedModelByKind);
    setSubsystemByKind(s.subsystemModelByKind);
    setRunnerBySubsystem(s.subsystemRunnerByKey);
  }, []);

  const poll = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void loadStatus().then((s) => {
        // Poll only fills in loading model lists — keep the user's
        // optimistic runner/model selection, don't reapply from the server.
        setStatus(s);
        if (s.anyLoading && Date.now() < deadlineRef.current) poll();
      });
    }, POLL_MS);
  }, [loadStatus]);

  useEffect(() => {
    deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    void loadStatus().then((s) => {
      apply(s);
      if (s.anyLoading) poll();
    });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loadStatus, apply, poll]);

  const doRefresh = (fn: () => Promise<AgentsStatusDTO>, setBusy: (b: boolean) => void): void => {
    setBusy(true);
    deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    void fn()
      .then((s) => {
        apply(s);
        if (s.anyLoading) poll();
      })
      .finally(() => setBusy(false));
  };

  const onSetDefault = (kind: string): void => {
    if (!kind || kind === defaultKind) return;
    const prev = defaultKind;
    setDefaultKind(kind as AgentRunnerKind); // optimistic
    void activateRunner(kind as AgentRunnerKind).then((ok) => {
      if (!ok) setDefaultKind(prev);
    });
  };

  const onSetModel = (kind: AgentRunnerKind, v: string): void => {
    setSavedByKind((m) => {
      const next = { ...m };
      if (v) next[kind] = v;
      else delete next[kind];
      return next;
    });
    setAgentModel(kind, v);
  };

  const onSetSubsystemModel = (
    kind: AgentRunnerKind,
    subsystem: ModelSubsystem,
    v: string,
  ): void => {
    setSubsystemByKind((m) => {
      const next = { ...m, [kind]: { ...m[kind] } };
      if (v) next[kind]![subsystem] = v;
      else delete next[kind]![subsystem];
      return next;
    });
    setSubsystemModel(kind, subsystem, v);
  };

  const onSetSubsystemRunner = (subsystem: ModelSubsystem, v: string): void => {
    setRunnerBySubsystem((m) => {
      const next = { ...m };
      if (v) next[subsystem] = v as AgentRunnerKind;
      else delete next[subsystem];
      return next;
    });
    setSubsystemRunner(subsystem, v as AgentRunnerKind | '');
  };

  const cards = status?.cards ?? [];
  const cardFor = (kind: AgentRunnerKind): AgentCardDTO | undefined =>
    cards.find((c) => c.kind === kind);
  const defaultCard = cardFor(defaultKind);
  /** A lane's agent: its own override, else the default lane's. */
  const resolvedKind = (s: ModelSubsystem): AgentRunnerKind => runnerBySubsystem[s] ?? defaultKind;
  const usedBy = (kind: AgentRunnerKind): string[] =>
    SUBSYSTEM_ROWS.filter((r) => resolvedKind(r.key) === kind).map((r) => r.label);

  return (
    <>
      <DrawerGroup label="Routing">
        <div className={controlsCss.note}>
          Each surface picks its own agent and model. A lane left on “Use default” follows the
          default lane below, so you can run the Builder on one agent and everything else on
          another.
        </div>
        {status === null ? (
          <div className={controlsCss.note}>Reading agent status…</div>
        ) : (
          <div className={styles.panel}>
            <div
              className={styles.routeRow}
              data-default="true"
              style={{ '--route-accent': defaultCard?.accent } as CSSProperties}
            >
              <div className={styles.routeMeta}>
                <div className={styles.routeName}>
                  <span className={styles.routeDot} />
                  Default
                </div>
                <span className={styles.routeHint}>
                  Every lane set to “Use default” lands here.
                </span>
              </div>
              <Select value={defaultKind} onChange={onSetDefault} ariaLabel="Default agent">
                {cards.map((c) => (
                  <option key={c.kind} value={c.kind} disabled={!c.connected}>
                    {c.connected ? c.title : `${c.title} · unavailable`}
                  </option>
                ))}
              </Select>
              <span className={styles.routeHint}>
                {defaultCard
                  ? `${modelLabel(defaultCard, savedByKind[defaultKind] ?? '')} — set per agent below`
                  : '—'}
              </span>
            </div>
            {SUBSYSTEM_ROWS.map((row) => {
              const kind = resolvedKind(row.key);
              const card = cardFor(kind);
              return (
                <RouteRow
                  key={row.key}
                  label={row.label}
                  hint={row.hint}
                  cards={cards}
                  runner={runnerBySubsystem[row.key] ?? ''}
                  model={subsystemByKind[kind]?.[row.key] ?? ''}
                  resolvedCard={card}
                  resolvedAgentDefault={savedByKind[kind] ?? ''}
                  defaultCard={defaultCard}
                  onSetRunner={(v) => onSetSubsystemRunner(row.key, v)}
                  onSetModel={(v) => onSetSubsystemModel(kind, row.key, v)}
                />
              );
            })}
          </div>
        )}
      </DrawerGroup>
      <DrawerGroup label="Agents">
        <div className={controlsCss.note}>
          Detected on this gateway. Detection is CLI-only — the gateway ran `&lt;bin&gt; --version`;
          Centraid doesn’t inspect how each agent authenticates. Each agent’s default model is what
          its lanes fall back to.
        </div>
        <div className={styles.panel}>
          {status === null ? (
            <div className={controlsCss.note}>Reading credential status…</div>
          ) : (
            cards.map((card) => (
              <AgentEntry
                key={card.kind}
                card={card}
                usedBy={usedBy(card.kind)}
                isDefault={card.kind === defaultKind}
                saved={savedByKind[card.kind] ?? ''}
                onSetModel={(v) => onSetModel(card.kind, v)}
              />
            ))
          )}
        </div>
        <div className={styles.actionsRow}>
          <Button
            variant="soft"
            size="sm"
            icon="Reset"
            disabled={busyModels}
            label="Refresh models"
            onClick={() => doRefresh(refreshModels, setBusyModels)}
          />
        </div>
      </DrawerGroup>
    </>
  );
}
