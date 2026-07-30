// governance: allow-repo-hygiene file-size-limit (#567) the provider settings screen coordinates one atomic runner/preflight/capability/ladder state surface whose optimistic rollback must remain centralized
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";

import type {
  AgentCardDTO,
  AgentRunnerKind,
  AgentsStatusDTO,
  ModelSubsystem,
  SettingsProvidersBridgeProps,
} from "../screen-contracts.js";
import { openConfirm } from "../shell/confirm.js";
import Button from "../ui/Button.js";
import { DrawerGroup } from "./settings-controls.js";
import AgentEntry from "./SettingsProvidersAgents.js";
import {
  ConfigSelect,
  ModelSelect,
  Select,
  modelLabel,
} from "./SettingsProvidersSelects.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./SettingsProvidersScreen.module.css";

const POLL_MS = 800;
const POLL_WINDOW_MS = 30_000;
/** How long the "Diagnostics copied" acknowledgement stays on the button. */
const COPIED_ACK_MS = 2000;

/**
 * The status poll's self-rescheduling timer. It lives at module scope, taking
 * the refs and loaders it needs as arguments, because a recursive function
 * declared inside the component body reads as a render value that depends on
 * itself — which is neither memoizable nor analysable.
 */
function schedulePoll(
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  deadlineRef: { current: number },
  loadStatus: () => Promise<AgentsStatusDTO>,
  onStatus: (s: AgentsStatusDTO) => void
): void {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    void loadStatus().then((s) => {
      // Poll only fills in loading model lists — keep the user's
      // optimistic runner/model selection, don't reapply from the server.
      onStatus(s);
      if (s.anyLoading && Date.now() < deadlineRef.current)
        schedulePoll(timerRef, deadlineRef, loadStatus, onStatus);
    });
  }, POLL_MS);
}

function clearTimers(
  ...timers: Array<{ current: ReturnType<typeof setTimeout> | null }>
): void {
  for (const timer of timers) {
    if (timer.current) clearTimeout(timer.current);
  }
}

/**
 * The routing lanes. Each resolves independently to an (agent, model) pair —
 * a lane left unset inherits the default lane. Before per-subsystem runners
 * these were model-only overrides hanging off one globally-active agent.
 */
const ALL_SUBSYSTEM_ROWS: ReadonlyArray<{
  key: ModelSubsystem;
  label: string;
  hint: string;
}> = [
  {
    key: "assistant",
    label: "Assistant",
    hint: "Global Ask across your vault.",
  },
  { key: "ask", label: "In-app Ask", hint: "The Ask panel inside each app." },
  { key: "builder", label: "Builder", hint: "The app-building agent." },
  {
    key: "automations",
    label: "Automations",
    hint: "Background automations & enrichers.",
  },
];

/**
 * The lanes that get a routing row. Builder is withheld: every builder entry
 * point is hidden by default (#434), so a routing control for a surface the
 * member cannot open is configuration for nothing.
 *
 * It stays in `ALL_SUBSYSTEM_ROWS` on purpose, because that list also feeds the
 * inventory's "used by" chips. A stored builder pin keeps resolving, and
 * hiding the row must not also hide the fact that an agent is carrying that
 * lane — invisible-but-active routing is what group D was about.
 */
const ROUTING_ROWS = ALL_SUBSYSTEM_ROWS.filter((row) => row.key !== "builder");

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
  effort,
  resolvedCard,
  resolvedAgentDefault,
  resolvedAgentDefaultEffort,
  defaultCard,
  ladder,
  onSetRunner,
  onSetModel,
  onSetEffort,
  onSetLadder,
  unattended,
}: {
  label: string;
  hint: string;
  cards: AgentCardDTO[];
  runner: AgentRunnerKind | "";
  model: string;
  effort: string;
  resolvedCard: AgentCardDTO | undefined;
  /** The resolved agent's own default model id — what this lane inherits. */
  resolvedAgentDefault: string;
  resolvedAgentDefaultEffort: string;
  defaultCard: AgentCardDTO | undefined;
  ladder: AgentRunnerKind[];
  onSetRunner: (v: string) => void;
  onSetModel: (v: string) => void;
  onSetEffort: (v: string) => void;
  onSetLadder: (v: AgentRunnerKind[]) => void;
  unattended: boolean;
}): JSX.Element {
  const [fallbackPick, setFallbackPick] = useState("");
  const [fallbackFeedback, setFallbackFeedback] = useState<string | null>(null);
  // D13: ladder membership IS the consent record, so the row shows exactly what
  // is stored — including a member that currently resolves as this lane's
  // primary. Hiding it made the UI disagree with the consent the gateway holds.
  const activeLadder = ladder.filter(
    (kind, index) => ladder.indexOf(kind) === index
  );
  // Unattended failover runs with no one watching, so a fallback must be past
  // its session preflight — `connected` alone admits an agent that will stop
  // and ask for auth mid-run.
  const availableFallbacks = cards.filter(
    (card) =>
      card.sessionReady &&
      card.kind !== resolvedCard?.kind &&
      !activeLadder.includes(card.kind)
  );
  return (
    <div
      className={styles.routeRow}
      style={{ "--route-accent": resolvedCard?.accent } as CSSProperties}
    >
      <div className={styles.routeMeta}>
        <div className={styles.routeName}>
          <span className={styles.routeDot} />
          {label}
        </div>
        <span className={styles.routeHint}>{hint}</span>
      </div>
      <div className={styles.routeControls}>
        <Select
          value={runner}
          onChange={onSetRunner}
          inherited={!runner}
          ariaLabel={`Agent for ${label}`}
        >
          <option value="">
            {defaultCard ? `Use default · ${defaultCard.title}` : "Use default"}
          </option>
          {runner && !cards.some((card) => card.kind === runner) ? (
            <option value={runner}>{runner} · existing hidden pin</option>
          ) : null}
          {cards.map((c) => (
            <option key={c.kind} value={c.kind} disabled={!c.connected}>
              {c.connected ? c.title : `${c.title} · unavailable`}
            </option>
          ))}
        </Select>
        {resolvedCard ? (
          <>
            <ModelSelect
              card={resolvedCard}
              saved={model}
              onChange={onSetModel}
              emptyLabel={`Use default · ${modelLabel(resolvedCard, resolvedAgentDefault)}`}
              ariaLabel={`Model for ${label}`}
            />
            <ConfigSelect
              card={resolvedCard}
              category="thought_level"
              saved={effort}
              onChange={onSetEffort}
              emptyLabel={`Use default · ${resolvedAgentDefaultEffort || "agent effort"}`}
              ariaLabel={`Effort for ${label}`}
            />
          </>
        ) : (
          <span className={styles.routeHint}>—</span>
        )}
      </div>
      {/* Failover is configurable only for the unattended lane. Attended lanes
          recover at the next turn with the member right there to see it and
          pick differently, so a stored ladder mostly served to hand the
          conversation to another provider without being asked. Automations
          fire with nobody watching, which is the case that needs a ladder. An
          attended lane's existing ladder is left stored and still honoured. */}
      {unattended ? (
        <div className={styles.ladderRow}>
          <span className={styles.routeHint}>In-fire failover</span>
          {activeLadder.length === 0 ? (
            <span className={styles.routeHint}>None</span>
          ) : (
            activeLadder.map((kind, index) => {
              const card = cards.find((candidate) => candidate.kind === kind);
              return (
                <span className={styles.ladderMember} key={kind}>
                  {card?.title ?? kind}
                  <button
                    type="button"
                    aria-label={`Move ${card?.title ?? kind} earlier for ${label}`}
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...activeLadder];
                      [next[index - 1], next[index]] = [
                        next[index]!,
                        next[index - 1]!,
                      ];
                      onSetLadder(next);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${card?.title ?? kind} later for ${label}`}
                    disabled={index === activeLadder.length - 1}
                    onClick={() => {
                      const next = [...activeLadder];
                      [next[index], next[index + 1]] = [
                        next[index + 1]!,
                        next[index]!,
                      ];
                      onSetLadder(next);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${card?.title ?? kind} from ${label} failover`}
                    onClick={() =>
                      onSetLadder(
                        activeLadder.filter((entry) => entry !== kind)
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              );
            })
          )}
          <select
            className={styles.ladderAdd}
            aria-label={`Add fallback agent for ${label}`}
            value={fallbackPick}
            disabled={availableFallbacks.length === 0}
            onChange={(event) => {
              const kind = event.target.value as AgentRunnerKind;
              if (!kind) return;
              setFallbackPick(kind);
              setFallbackFeedback(null);
              const title =
                cards.find((card) => card.kind === kind)?.title ?? kind;
              void openConfirm({
                confirmLabel: "Add fallback",
                title: `Add ${title} to ${label} failover?`,
                message: `If earlier agents fail, Centraid may send the conversation handoff, attachments, and vault-derived context to ${title} without another prompt. A later manual switch remains separately confirm-gated.`,
              }).then((approved) => {
                if (approved) {
                  onSetLadder([...activeLadder, kind]);
                  setFallbackFeedback(`${title} added`);
                } else {
                  setFallbackFeedback(`${title} was not added`);
                }
                setFallbackPick("");
              });
            }}
          >
            <option value="">Add fallback…</option>
            {availableFallbacks.map((card) => (
              <option key={card.kind} value={card.kind}>
                {card.title}
              </option>
            ))}
          </select>
          {fallbackFeedback ? (
            <span className={styles.routeHint}>{fallbackFeedback}</span>
          ) : null}
          {cards
            .filter((card) => card.connected && !card.sessionReady)
            .map((card) => (
              <span className={styles.routeHint} key={card.kind}>
                {card.title}: {card.fallbackBlockedReason}
              </span>
            ))}
        </div>
      ) : null}
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
  setAgentConfigPin,
  setSubsystemModel,
  setSubsystemConfigPin,
  setSubsystemRunner,
  setSubsystemRunnerLadder,
}: SettingsProvidersBridgeProps): JSX.Element {
  const [status, setStatus] = useState<AgentsStatusDTO | null>(null);
  const [defaultKind, setDefaultKind] = useState<AgentRunnerKind>("codex");
  const [savedByKind, setSavedByKind] = useState<Record<string, string>>({});
  const [subsystemByKind, setSubsystemByKind] = useState<
    Record<string, Partial<Record<ModelSubsystem, string>>>
  >({});
  const [defaultConfigByKind, setDefaultConfigByKind] = useState<
    Record<string, Record<string, string>>
  >({});
  const [subsystemConfigByKind, setSubsystemConfigByKind] = useState<
    Record<string, Partial<Record<ModelSubsystem, Record<string, string>>>>
  >({});
  const [runnerBySubsystem, setRunnerBySubsystem] = useState<
    Partial<Record<ModelSubsystem, AgentRunnerKind>>
  >({});
  const [runnerLadders, setRunnerLadders] = useState<
    Partial<Record<ModelSubsystem, AgentRunnerKind[]>>
  >({});
  const [busyModels, setBusyModels] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((s: AgentsStatusDTO) => {
    setStatus(s);
    setDefaultKind(s.selectedKind);
    setSavedByKind(s.savedModelByKind);
    setSubsystemByKind(s.subsystemModelByKind);
    setDefaultConfigByKind(s.defaultConfigPinsByKind);
    setSubsystemConfigByKind(s.subsystemConfigPinsByKind);
    setRunnerBySubsystem(s.subsystemRunnerByKey);
    setRunnerLadders(s.subsystemRunnerLadders);
  }, []);

  const poll = useCallback(() => {
    schedulePoll(timerRef, deadlineRef, loadStatus, setStatus);
  }, [loadStatus]);

  useEffect(() => {
    deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    void loadStatus().then((s) => {
      apply(s);
      if (s.anyLoading) poll();
    });
    return () => clearTimers(timerRef, copiedTimerRef);
  }, [loadStatus, apply, poll]);

  const doRefresh = (
    fn: () => Promise<AgentsStatusDTO>,
    setBusy: (b: boolean) => void
  ): void => {
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
    v: string
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
    const previous = runnerBySubsystem[subsystem];
    setRunnerBySubsystem((m) => {
      const next = { ...m };
      if (v) next[subsystem] = v as AgentRunnerKind;
      else delete next[subsystem];
      return next;
    });
    void setSubsystemRunner(subsystem, v as AgentRunnerKind | "").then((ok) => {
      if (ok) return;
      setRunnerBySubsystem((current) => {
        const next = { ...current };
        if (previous) next[subsystem] = previous;
        else delete next[subsystem];
        return next;
      });
    });
  };

  const onSetSubsystemRunnerLadder = (
    subsystem: ModelSubsystem,
    kinds: AgentRunnerKind[]
  ): void => {
    setRunnerLadders((current) => ({ ...current, [subsystem]: kinds }));
    setSubsystemRunnerLadder(subsystem, kinds);
  };

  const onSetAgentConfig = (
    kind: AgentRunnerKind,
    category: string,
    value: string
  ): void => {
    setDefaultConfigByKind((current) => {
      const next = { ...current, [kind]: { ...current[kind] } };
      if (value) next[kind]![category] = value;
      else delete next[kind]![category];
      return next;
    });
    setAgentConfigPin(kind, category, value);
  };

  const onSetSubsystemConfig = (
    kind: AgentRunnerKind,
    subsystem: ModelSubsystem,
    category: string,
    value: string
  ): void => {
    setSubsystemConfigByKind((current) => {
      const next = {
        ...current,
        [kind]: {
          ...current[kind],
          [subsystem]: { ...current[kind]?.[subsystem] },
        },
      };
      if (value) next[kind]![subsystem]![category] = value;
      else delete next[kind]![subsystem]![category];
      return next;
    });
    setSubsystemConfigPin(kind, subsystem, category, value);
  };

  const cards = status?.cards ?? [];
  const cardFor = (kind: AgentRunnerKind): AgentCardDTO | undefined =>
    cards.find((c) => c.kind === kind);
  const defaultCard = cardFor(defaultKind);
  /** A lane's agent: its own override, else the default lane's. */
  const resolvedKind = (s: ModelSubsystem): AgentRunnerKind =>
    runnerBySubsystem[s] ?? defaultKind;
  const usedBy = (kind: AgentRunnerKind): string[] =>
    ALL_SUBSYSTEM_ROWS.filter((r) => resolvedKind(r.key) === kind).map(
      (r) => r.label
    );

  return (
    <>
      <DrawerGroup label="Routing">
        <div className={controlsCss.note}>
          Each surface picks its own agent and model. A lane left on “Use
          default” follows the default lane below, so you can run Automations on
          one agent and everything else on another.
        </div>
        {status === null ? (
          <div className={controlsCss.note}>Reading agent status…</div>
        ) : (
          <div className={styles.panel}>
            <div
              className={styles.routeRow}
              data-default="true"
              style={{ "--route-accent": defaultCard?.accent } as CSSProperties}
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
              <div className={styles.routeControls}>
                <Select
                  value={defaultKind}
                  onChange={onSetDefault}
                  ariaLabel="Default agent"
                >
                  {cards.some((card) => card.kind === defaultKind) ? null : (
                    <option value={defaultKind}>
                      {defaultKind} · existing hidden pin
                    </option>
                  )}
                  {cards.map((c) => (
                    <option key={c.kind} value={c.kind} disabled={!c.connected}>
                      {c.connected ? c.title : `${c.title} · unavailable`}
                    </option>
                  ))}
                </Select>
                <span className={styles.routeHint}>
                  {defaultCard
                    ? `${modelLabel(defaultCard, savedByKind[defaultKind] ?? "")} — set per agent below`
                    : "—"}
                </span>
              </div>
            </div>
            {ROUTING_ROWS.map((row) => {
              const kind = resolvedKind(row.key);
              const card = cardFor(kind);
              return (
                <RouteRow
                  key={row.key}
                  label={row.label}
                  hint={row.hint}
                  cards={cards}
                  runner={runnerBySubsystem[row.key] ?? ""}
                  model={subsystemByKind[kind]?.[row.key] ?? ""}
                  effort={
                    subsystemConfigByKind[kind]?.[row.key]?.thought_level ?? ""
                  }
                  resolvedCard={card}
                  resolvedAgentDefault={savedByKind[kind] ?? ""}
                  resolvedAgentDefaultEffort={
                    defaultConfigByKind[kind]?.thought_level ??
                    card?.configOptions?.find(
                      (option) => option.category === "thought_level"
                    )?.currentValue ??
                    ""
                  }
                  defaultCard={defaultCard}
                  ladder={runnerLadders[row.key] ?? []}
                  onSetRunner={(v) => onSetSubsystemRunner(row.key, v)}
                  onSetModel={(v) => onSetSubsystemModel(kind, row.key, v)}
                  onSetEffort={(v) =>
                    onSetSubsystemConfig(kind, row.key, "thought_level", v)
                  }
                  onSetLadder={(v) => onSetSubsystemRunnerLadder(row.key, v)}
                  unattended={row.key === "automations"}
                />
              );
            })}
          </div>
        )}
      </DrawerGroup>
      <DrawerGroup label="Agents">
        <div className={controlsCss.note}>
          Detected on this gateway. Detection is CLI-only — the gateway ran
          `&lt;bin&gt; --version`; Centraid doesn’t inspect how each agent
          authenticates. Each agent’s default model is what its lanes fall back
          to.
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
                saved={savedByKind[card.kind] ?? ""}
                effort={defaultConfigByKind[card.kind]?.thought_level ?? ""}
                onSetModel={(v) => onSetModel(card.kind, v)}
                onSetEffort={(v) =>
                  onSetAgentConfig(card.kind, "thought_level", v)
                }
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
            label="Refresh models & capabilities"
            onClick={() => doRefresh(refreshModels, setBusyModels)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon="Copy"
            label={
              diagnosticsCopied
                ? "Diagnostics copied"
                : "Copy capability diagnostics"
            }
            disabled={!status}
            onClick={() => {
              if (!status) return;
              void navigator.clipboard?.writeText(status.diagnosticsJson);
              setDiagnosticsCopied(true);
              // The label is an acknowledgement, not a state — without this the
              // button reads "Diagnostics copied" for the rest of the session.
              if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
              copiedTimerRef.current = setTimeout(
                () => setDiagnosticsCopied(false),
                COPIED_ACK_MS
              );
            }}
          />
        </div>
      </DrawerGroup>
    </>
  );
}
