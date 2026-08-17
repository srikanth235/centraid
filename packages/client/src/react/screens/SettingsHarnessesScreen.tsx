import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";

import type {
  HarnessCardDTO,
  HarnessKind,
  HarnessesStatusDTO,
  ModelSubsystem,
  SettingsHarnessesBridgeProps,
} from "../screen-contracts.js";
import Button from "../ui/Button.js";
import { DrawerGroup } from "./settings-controls.js";
import HarnessEntry from "./SettingsHarnessEntries.js";
import { Select, clampEffort, modelLabel } from "./SettingsHarnessesSelects.js";
import RouteRow, {
  ALL_SUBSYSTEM_ROWS,
  ROUTING_ROWS,
} from "./SettingsHarnessLanes.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./SettingsHarnessesScreen.module.css";

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
  loadStatus: () => Promise<HarnessesStatusDTO>,
  onStatus: (s: HarnessesStatusDTO) => void
): void {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    void loadStatus().then((s) => {
      // Poll only fills in loading model lists — keep the user's
      // optimistic harness/model selection, don't reapply from the server.
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
 * Settings → Agents. Two sections, and the split is the point: **Routing** is
 * where every decision lives (each subsystem resolves to its own harness and
 * model), **Agents** is inventory — what is installed, what it exposes, and
 * which lanes land on it.
 *
 * The page previously led with an exclusive Codex/Claude-Code radio, because
 * exactly one harness could be active. Per-subsystem harnesses retire that
 * premise: there is no "active" harness any more, only a *default* one that
 * unset lanes fall back to — so it became the first lane of the same table
 * rather than a separate control above it.
 */
export default function SettingsHarnessesScreen({
  loadStatus,
  refreshModels,
  activateHarness,
  setHarnessModel,
  setHarnessConfigPin,
  setSubsystemModel,
  setSubsystemConfigPin,
  setSubsystemHarness,
  setSubsystemHarnessLadder,
  showToast,
}: SettingsHarnessesBridgeProps): JSX.Element {
  const [status, setStatus] = useState<HarnessesStatusDTO | null>(null);
  const [defaultKind, setDefaultKind] = useState<HarnessKind>("codex");
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
  const [harnessBySubsystem, setHarnessBySubsystem] = useState<
    Partial<Record<ModelSubsystem, HarnessKind>>
  >({});
  const [harnessLadders, setHarnessLadders] = useState<
    Partial<Record<ModelSubsystem, HarnessKind[]>>
  >({});
  const [busyModels, setBusyModels] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((s: HarnessesStatusDTO) => {
    setStatus(s);
    setDefaultKind(s.selectedKind);
    setSavedByKind(s.savedModelByKind);
    setSubsystemByKind(s.subsystemModelByKind);
    setDefaultConfigByKind(s.defaultConfigPinsByKind);
    setSubsystemConfigByKind(s.subsystemConfigPinsByKind);
    setHarnessBySubsystem(s.subsystemHarnessByKey);
    setHarnessLadders(s.subsystemHarnessLadders);
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
    fn: () => Promise<HarnessesStatusDTO>,
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

  /**
   * EVERY PICK ON THIS PAGE IS OPTIMISTIC AND EVERY PICK ROLLS BACK. A refused
   * write used to be invisible here — the model and effort setters were
   * fire-and-forget, so a gateway that rejected a pin left the pick sitting on
   * screen as though it were saved. The gateway's own text goes on the status
   * line and the displayed value returns to what the gateway holds.
   */
  const settle = (
    what: string,
    write: Promise<string | null>,
    rollback: () => void
  ): void => {
    void write.then((refusal) => {
      if (!refusal) return;
      rollback();
      showToast(`${what} not saved: ${refusal}`);
    });
  };

  const onSetDefault = (kind: string): void => {
    if (!kind || kind === defaultKind) return;
    const prev = defaultKind;
    setDefaultKind(kind as HarnessKind); // optimistic
    settle("Agent", activateHarness(kind as HarnessKind), () =>
      setDefaultKind(prev)
    );
  };

  /** Apply (or clear) one harness-default model in local state. */
  const applyModel = (kind: HarnessKind, v: string): void =>
    setSavedByKind((m) => {
      const next = { ...m };
      if (v) next[kind] = v;
      else delete next[kind];
      return next;
    });

  const onSetModel = (kind: HarnessKind, v: string): void => {
    const prev = savedByKind[kind] ?? "";
    applyModel(kind, v);
    settle("Model", setHarnessModel(kind, v), () => applyModel(kind, prev));
    clampHarnessEffort(kind);
  };

  /**
   * Changing the model clamps the level. A level the harness no longer offers
   * for the model now selected is one the runtime would drop on its own
   * (`pinThoughtLevel` answers `thought_level_not_offered`), so the pin goes
   * back to inherit rather than displaying a level nothing will honour.
   */
  const clampHarnessEffort = (kind: HarnessKind): void => {
    const card = cardFor(kind);
    const saved = defaultConfigByKind[kind]?.thought_level ?? "";
    if (!card || !saved || clampEffort(card, saved) === saved) return;
    onSetHarnessConfig(kind, "thought_level", "");
  };

  const clampSubsystemEffort = (
    kind: HarnessKind,
    subsystem: ModelSubsystem
  ): void => {
    const card = cardFor(kind);
    const saved = subsystemConfigByKind[kind]?.[subsystem]?.thought_level ?? "";
    if (!card || !saved || clampEffort(card, saved) === saved) return;
    onSetSubsystemConfig(kind, subsystem, "thought_level", "");
  };

  const applySubsystemModel = (
    kind: HarnessKind,
    subsystem: ModelSubsystem,
    v: string
  ): void =>
    setSubsystemByKind((m) => {
      const next = { ...m, [kind]: { ...m[kind] } };
      if (v) next[kind]![subsystem] = v;
      else delete next[kind]![subsystem];
      return next;
    });

  const onSetSubsystemModel = (
    kind: HarnessKind,
    subsystem: ModelSubsystem,
    v: string
  ): void => {
    const prev = subsystemByKind[kind]?.[subsystem] ?? "";
    applySubsystemModel(kind, subsystem, v);
    settle("Model", setSubsystemModel(kind, subsystem, v), () =>
      applySubsystemModel(kind, subsystem, prev)
    );
    clampSubsystemEffort(kind, subsystem);
  };

  const applySubsystemHarness = (subsystem: ModelSubsystem, v: string): void =>
    setHarnessBySubsystem((m) => {
      const next = { ...m };
      if (v) next[subsystem] = v as HarnessKind;
      else delete next[subsystem];
      return next;
    });

  const onSetSubsystemHarness = (
    subsystem: ModelSubsystem,
    v: string
  ): void => {
    const previous = harnessBySubsystem[subsystem] ?? "";
    applySubsystemHarness(subsystem, v);
    settle("Agent", setSubsystemHarness(subsystem, v as HarnessKind | ""), () =>
      applySubsystemHarness(subsystem, previous)
    );
  };

  const onSetSubsystemHarnessLadder = (
    subsystem: ModelSubsystem,
    kinds: HarnessKind[]
  ): void => {
    const previous = harnessLadders[subsystem] ?? [];
    setHarnessLadders((current) => ({ ...current, [subsystem]: kinds }));
    settle("Failover", setSubsystemHarnessLadder(subsystem, kinds), () =>
      setHarnessLadders((current) => ({ ...current, [subsystem]: previous }))
    );
  };

  const applyHarnessConfig = (
    kind: HarnessKind,
    category: string,
    value: string
  ): void =>
    setDefaultConfigByKind((current) => {
      const next = { ...current, [kind]: { ...current[kind] } };
      if (value) next[kind]![category] = value;
      else delete next[kind]![category];
      return next;
    });

  const onSetHarnessConfig = (
    kind: HarnessKind,
    category: string,
    value: string
  ): void => {
    const prev = defaultConfigByKind[kind]?.[category] ?? "";
    applyHarnessConfig(kind, category, value);
    settle("Level", setHarnessConfigPin(kind, category, value), () =>
      applyHarnessConfig(kind, category, prev)
    );
  };

  const applySubsystemConfig = (
    kind: HarnessKind,
    subsystem: ModelSubsystem,
    category: string,
    value: string
  ): void =>
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

  const onSetSubsystemConfig = (
    kind: HarnessKind,
    subsystem: ModelSubsystem,
    category: string,
    value: string
  ): void => {
    const prev = subsystemConfigByKind[kind]?.[subsystem]?.[category] ?? "";
    applySubsystemConfig(kind, subsystem, category, value);
    settle(
      "Level",
      setSubsystemConfigPin(kind, subsystem, category, value),
      () => applySubsystemConfig(kind, subsystem, category, prev)
    );
  };

  const cards = status?.cards ?? [];
  const cardFor = (kind: HarnessKind): HarnessCardDTO | undefined =>
    cards.find((c) => c.kind === kind);
  const defaultCard = cardFor(defaultKind);
  /** A lane's harness: its own override, else the default lane's. */
  const resolvedKind = (s: ModelSubsystem): HarnessKind =>
    harnessBySubsystem[s] ?? defaultKind;
  const usedBy = (kind: HarnessKind): string[] =>
    ALL_SUBSYSTEM_ROWS.filter((r) => resolvedKind(r.key) === kind).map(
      (r) => r.label
    );

  return (
    <>
      <DrawerGroup label="Routing">
        <div className={controlsCss.note}>
          Each surface picks its own agent and model; a lane left on “Use
          default” follows the default lane below.
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
                  harness={harnessBySubsystem[row.key] ?? ""}
                  model={subsystemByKind[kind]?.[row.key] ?? ""}
                  effort={
                    subsystemConfigByKind[kind]?.[row.key]?.thought_level ?? ""
                  }
                  resolvedCard={card}
                  resolvedHarnessDefault={savedByKind[kind] ?? ""}
                  resolvedHarnessDefaultEffort={
                    defaultConfigByKind[kind]?.thought_level ??
                    card?.configOptions?.find(
                      (option) => option.category === "thought_level"
                    )?.currentValue ??
                    ""
                  }
                  defaultCard={defaultCard}
                  ladder={harnessLadders[row.key] ?? []}
                  onSetHarness={(v) => onSetSubsystemHarness(row.key, v)}
                  onSetModel={(v) => onSetSubsystemModel(kind, row.key, v)}
                  onSetEffort={(v) =>
                    onSetSubsystemConfig(kind, row.key, "thought_level", v)
                  }
                  onSetLadder={(v) => onSetSubsystemHarnessLadder(row.key, v)}
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
              <HarnessEntry
                key={card.kind}
                card={card}
                usedBy={usedBy(card.kind)}
                isDefault={card.kind === defaultKind}
                saved={savedByKind[card.kind] ?? ""}
                effort={defaultConfigByKind[card.kind]?.thought_level ?? ""}
                onSetModel={(v) => onSetModel(card.kind, v)}
                onSetEffort={(v) =>
                  onSetHarnessConfig(card.kind, "thought_level", v)
                }
              />
            ))
          )}
        </div>
        <div className={styles.actionsRow}>
          <Button
            variant="secondary"
            size="sm"
            icon="Reset"
            disabled={busyModels}
            label="Refresh models & capabilities"
            onClick={() => doRefresh(refreshModels, setBusyModels)}
          />
          <Button
            variant="quiet"
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
