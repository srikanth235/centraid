import type { JSX } from "react";

import type {
  AssistantCompanionSurface,
  AssistantHarnessOption,
  AssistantSelection,
  ResolvedAssistantSelection,
} from "./assistantCompanionModel.js";
import {
  selectionForHarness,
  selectionForModel,
} from "./assistantCompanionModel.js";

import css from "./AssistantCompanionPicker.module.css";

export interface AssistantCompanionPickerProps {
  surface: AssistantCompanionSurface;
  catalog: readonly AssistantHarnessOption[];
  selection: AssistantSelection;
  resolved: ResolvedAssistantSelection;
  onChange: (selection: AssistantSelection) => void;
}

export default function AssistantCompanionPicker({
  catalog,
  surface,
  selection,
  resolved,
  onChange,
}: AssistantCompanionPickerProps): JSX.Element {
  return (
    <dialog
      open
      className={css.picker}
      data-surface={surface}
      aria-label="Harness, model and effort"
    >
      <section
        className={css.pickerSection}
        aria-labelledby="companion-harness-label"
      >
        <h3 className={css.pickerLabel} id="companion-harness-label">
          Harness
        </h3>
        <div className={css.optionList}>
          {catalog.map((harness) => {
            const selected = harness.id === selection.harnessId;
            return (
              <button
                className={css.option}
                data-selected={selected ? "true" : undefined}
                key={harness.id}
                type="button"
                onClick={() => onChange(selectionForHarness(harness))}
              >
                <span className={css.optionMark}>{selected ? "●" : null}</span>
                <span className={css.optionBody}>
                  <span className={css.optionName}>{harness.label}</span>
                  <span className={css.optionMeta}>
                    {harness.vendorLabel} · {harness.statusLabel}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        className={css.pickerSection}
        aria-labelledby="companion-model-label"
      >
        <h3 className={css.pickerLabel} id="companion-model-label">
          Model
        </h3>
        <div className={css.optionList}>
          {resolved.harness.models.map((model) => {
            const selected = model.id === selection.modelId;
            return (
              <button
                className={css.option}
                data-selected={selected ? "true" : undefined}
                key={model.id}
                type="button"
                onClick={() => onChange(selectionForModel(selection, model))}
              >
                <span className={css.optionMark}>{selected ? "●" : null}</span>
                <span className={css.optionName}>{model.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        className={css.pickerSection}
        aria-labelledby="companion-effort-label"
      >
        <h3 className={css.pickerLabel} id="companion-effort-label">
          Effort
        </h3>
        {resolved.model.efforts.length > 0 ? (
          <>
            <div className={css.effortTrack}>
              {resolved.model.efforts.map((effort) => {
                const selected = effort.id === selection.effortId;
                return (
                  <button
                    className={css.effort}
                    data-selected={selected ? "true" : undefined}
                    key={effort.id}
                    type="button"
                    onClick={() =>
                      onChange({ ...selection, effortId: effort.id })
                    }
                  >
                    {effort.label}
                  </button>
                );
              })}
            </div>
            <p className={css.effortNote}>{resolved.effort?.note}</p>
          </>
        ) : (
          <p className={css.effortNote}>
            {resolved.model.noEffortReason ??
              `${resolved.model.label} does not expose a thinking budget.`}
          </p>
        )}
      </section>
    </dialog>
  );
}
