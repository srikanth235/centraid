import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { AutomationEditorData } from "../screen-contracts.js";
import { Icon } from "../ui/index.js";

import styles from "./AutomationEditorScreen.module.css";

type RunnerOption = NonNullable<AutomationEditorData["agentRunners"]>[number];

export function AutomationEditorAgentPicker({
  runners,
  runner,
  model,
  defaultRunnerKind,
  defaultModel,
  onChange,
}: {
  runners: RunnerOption[];
  runner: string | null | undefined;
  model: string | null | undefined;
  defaultRunnerKind: string | undefined;
  defaultModel: string | null | undefined;
  onChange: (next: { runner: string | null; model: string | null }) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const effectiveRunner = runner ?? defaultRunnerKind ?? runners[0]?.kind ?? "";
  const selected = runners.find((option) => option.kind === effectiveRunner);
  const effectiveDefaultModel =
    selected?.defaultModel ??
    (effectiveRunner === defaultRunnerKind ? defaultModel : null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node | null))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.agentPickerWrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.instrChip}
        data-open={String(open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Choose the coding agent and model for this automation"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="Cpu" size={14} />
        <span>Agent</span>
        <span className={styles.agentChipValue}>
          {(selected?.label ?? effectiveRunner) || "Default"}
        </span>
        <Icon name="ChevronDown" size={12} />
      </button>
      {open ? (
        <dialog
          open
          className={styles.agentPicker}
          aria-label="Automation agent"
        >
          <div>
            <strong className={styles.agentPickerTitle}>Agent</strong>
            <p className={styles.agentPickerHint}>
              Pin a harness and model for compile, replies, and every run.
            </p>
          </div>
          <label className={styles.agentPickerField}>
            <span>Runner</span>
            <select
              value={runner ?? ""}
              onChange={(event) =>
                onChange({ runner: event.target.value || null, model: null })
              }
            >
              <option value="">
                Use default{defaultRunnerKind ? ` (${defaultRunnerKind})` : ""}
              </option>
              {runners.map((option) => (
                <option key={option.kind} value={option.kind}>
                  {option.label}
                  {option.connected ? "" : " · unavailable"}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.agentPickerField}>
            <span>Model</span>
            <select
              value={model ?? ""}
              onChange={(event) =>
                onChange({
                  runner: runner ?? null,
                  model: event.target.value || null,
                })
              }
            >
              <option value="">
                Use default
                {effectiveDefaultModel ? ` (${effectiveDefaultModel})` : ""}
              </option>
              {model &&
              !selected?.models.some((option) => option.id === model) ? (
                <option value={model}>{model}</option>
              ) : null}
              {(selected?.models ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name ?? option.id}
                </option>
              ))}
            </select>
          </label>
        </dialog>
      ) : null}
    </div>
  );
}
