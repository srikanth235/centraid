import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  HarnessCardDTO,
  HarnessKind,
  HarnessesStatusDTO,
  ModelSubsystem,
  SettingsHarnessesBridgeProps,
} from "../screen-contracts.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import HarnessEntry from "./SettingsHarnessEntries.js";
import {
  ConfigSelect,
  Select,
  clampEffort,
  effortLabel,
  modelLabel,
} from "./SettingsHarnessesSelects.js";
import RouteRow, {
  ALL_SUBSYSTEM_ROWS,
  ROUTING_ROWS,
} from "./SettingsHarnessLanes.js";
import PickRow from "./SettingsPickRow.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./SettingsHarnessesScreen.module.css";

const POLL_MS = 800;
const POLL_WINDOW_MS = 30_000;
const COPIED_ACK_MS = 2000;
const LEVEL = "thought_level";

function schedulePoll(
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  deadlineRef: { current: number },
  loadStatus: () => Promise<HarnessesStatusDTO>,
  onStatus: (s: HarnessesStatusDTO) => void
): void {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    void loadStatus().then((s) => {
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

function pinCategories(card: HarnessCardDTO): string[] {
  return (card.configOptions ?? [])
    .filter((option) => option.category !== LEVEL && option.values.length > 0)
    .map((option) => option.category);
}

function categoryWords(category: string): string {
  return category.replaceAll("_", " ");
}

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
  const [pinsOpen, setPinsOpen] = useState(false);
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

  const clampHarnessEffort = (kind: HarnessKind): void => {
    const card = cardFor(kind);
    const saved = defaultConfigByKind[kind]?.[LEVEL] ?? "";
    if (!card || !saved || clampEffort(card, saved) === saved) return;
    onSetHarnessConfig(kind, LEVEL, "");
  };

  const clampSubsystemEffort = (
    kind: HarnessKind,
    subsystem: ModelSubsystem
  ): void => {
    const card = cardFor(kind);
    const saved = subsystemConfigByKind[kind]?.[subsystem]?.[LEVEL] ?? "";
    if (!card || !saved || clampEffort(card, saved) === saved) return;
    onSetSubsystemConfig(kind, subsystem, LEVEL, "");
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
    settle(
      category === LEVEL ? "Level" : categoryWords(category),
      setHarnessConfigPin(kind, category, value),
      () => applyHarnessConfig(kind, category, prev)
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
  const resolvedKind = (s: ModelSubsystem): HarnessKind =>
    harnessBySubsystem[s] ?? defaultKind;
  const usedBy = (kind: HarnessKind): string[] =>
    ALL_SUBSYSTEM_ROWS.filter((r) => resolvedKind(r.key) === kind).map(
      (r) => r.label
    );
  const harnessLevel = (kind: HarnessKind): string =>
    defaultConfigByKind[kind]?.[LEVEL] ??
    cardFor(kind)?.configOptions?.find((option) => option.category === LEVEL)
      ?.currentValue ??
    "";
  const defaultAnswer = `${modelLabel(
    defaultCard,
    savedByKind[defaultKind] ?? ""
  )} · ${effortLabel(defaultCard, harnessLevel(defaultKind)).toLowerCase()}`;

  const pinnable = cards
    .map((card) => ({ card, categories: pinCategories(card) }))
    .filter((entry) => entry.categories.length > 0);
  const pinnedCount = pinnable.reduce(
    (total, entry) =>
      total +
      entry.categories.filter(
        (category) => defaultConfigByKind[entry.card.kind]?.[category]
      ).length,
    0
  );
  const pinWords = [
    ...new Set(pinnable.flatMap((entry) => entry.categories)),
  ].map(categoryWords);

  const rows: RowDef[] = [
    {
      id: "pins",
      title: "Configuration pins",
      sub: pinWords.length
        ? pinWords.join(" · ")
        : "These agents offer no options beyond their level",
      meta: pinnable.length ? `${pinnedCount} pinned` : "none offered",
      ...(pinnable.length
        ? {
            action: {
              label: pinsOpen ? "Hide" : "Open",
              onClick: () => setPinsOpen((open) => !open),
            },
          }
        : {}),
      ...(pinsOpen && pinnable.length
        ? {
            children: pinnable.flatMap((entry) =>
              entry.categories.map((category, index) => (
                <PickRow
                  key={`${entry.card.kind}/${category}`}
                  first={index === 0}
                  label={`${entry.card.title} · ${categoryWords(category)}`}
                  caption={
                    entry.card.connected
                      ? undefined
                      : "Not connected — the pin is stored, not applied"
                  }
                  captionNet={!entry.card.connected}
                >
                  <ConfigSelect
                    card={entry.card}
                    category={category}
                    saved={
                      defaultConfigByKind[entry.card.kind]?.[category] ?? ""
                    }
                    onChange={(v) =>
                      onSetHarnessConfig(entry.card.kind, category, v)
                    }
                    emptyLabel="Agent default"
                    ariaLabel={`${categoryWords(category)} for ${entry.card.title}`}
                  />
                </PickRow>
              ))
            ),
          }
        : {}),
    },
    {
      id: "diagnostics",
      title: "Copy diagnostics",
      sub: "Versions, lanes, capability evidence",
      ...(status
        ? {
            action: {
              label: diagnosticsCopied ? "Copied" : "Copy",
              onClick: () => {
                void navigator.clipboard?.writeText(status.diagnosticsJson);
                setDiagnosticsCopied(true);
                if (copiedTimerRef.current)
                  clearTimeout(copiedTimerRef.current);
                copiedTimerRef.current = setTimeout(
                  () => setDiagnosticsCopied(false),
                  COPIED_ACK_MS
                );
              },
            },
          }
        : {}),
    },
  ];

  return (
    <>
      <SectionBlock
        label="Harnesses"
        meta="model · reasoning level"
        action={{
          label: "Refresh",
          hint: "Re-read every agent's models and capabilities",
          onClick: () => doRefresh(refreshModels, setBusyModels),
          ...(busyModels ? { off: true } : {}),
        }}
      />
      {status === null ? (
        <div className={controlsCss.note}>Reading agent status…</div>
      ) : (
        <div className={styles.rows}>
          {cards.map((card, index) => (
            <HarnessEntry
              key={card.kind}
              card={card}
              first={index === 0}
              usedBy={usedBy(card.kind)}
              isDefault={card.kind === defaultKind}
              saved={savedByKind[card.kind] ?? ""}
              effort={defaultConfigByKind[card.kind]?.[LEVEL] ?? ""}
              onSetModel={(v) => onSetModel(card.kind, v)}
              onSetEffort={(v) => onSetHarnessConfig(card.kind, LEVEL, v)}
            />
          ))}
        </div>
      )}
      <RowsBlock ariaLabel="Agent machinery" rows={rows} />

      <SectionBlock label="Lanes" meta="harness · model · level" />
      {status === null ? null : (
        <div className={styles.rows}>
          <PickRow
            first
            label="Default"
            caption={`Every lane left inheriting lands here · ${defaultAnswer}`}
          >
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
          </PickRow>
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
                effort={subsystemConfigByKind[kind]?.[row.key]?.[LEVEL] ?? ""}
                resolvedCard={card}
                resolvedHarnessDefault={savedByKind[kind] ?? ""}
                resolvedHarnessDefaultEffort={harnessLevel(kind)}
                defaultCard={defaultCard}
                ladder={harnessLadders[row.key] ?? []}
                onSetHarness={(v) => onSetSubsystemHarness(row.key, v)}
                onSetModel={(v) => onSetSubsystemModel(kind, row.key, v)}
                onSetEffort={(v) =>
                  onSetSubsystemConfig(kind, row.key, LEVEL, v)
                }
                onSetLadder={(v) => onSetSubsystemHarnessLadder(row.key, v)}
                unattended={row.key === "automations"}
              />
            );
          })}
        </div>
      )}
      <NoteBlock>
        The Builder lane is withheld while builder entry points are hidden. Your
        pick stays while it commits.
      </NoteBlock>
    </>
  );
}
