// Edit / New person (v12 § 8): `new`/`edit` draw the SAME form; mode only names
// the screen. Vaults section withheld (people-copy.ts) — People reads sharing,
// writes none. `Never` chip writes zero (floored everywhere); swatches store
// `var(--c-<hue>)`, never hex: legacy hexes match no swatch.
import type { ReactNode } from "react";

import { IDENTITY_HUE_KEYS } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { agoLabel } from "../format.ts";
import {
  CADENCE_CHIPS,
  CADENCE_NEVER,
  FIELDS,
  LABELS,
  VERBS,
} from "../people-copy.ts";
import type { EditRouteProps } from "../types.ts";
import { ChipRow, Commits, Field, SkeletonBlock } from "./Shared.tsx";

import styles from "./EditRoute.module.css";
import shared from "./shared.module.css";

const HUE_KEYS = IDENTITY_HUE_KEYS;

function hueValue(key: ColorKey): string {
  return `var(--c-${key})`;
}

/** Labels from format.ts: cadence reads the same word as the person screen. */
const CADENCE_OPTIONS = CADENCE_CHIPS.map((days) => ({
  id: String(days),
  label: days === 0 ? CADENCE_NEVER : agoLabel(days),
}));

export function EditRoute(props: EditRouteProps): ReactNode {
  const draft = props.draft;
  // Unbuilt draft == read in flight: skeleton, never a saveable empty form.
  if (props.loading || !draft) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={5} />
      </SkeletonBlock>
    );
  }

  return (
    <>
      <Field
        label={FIELDS.name}
        value={draft.name}
        onChange={(name) => props.onChange({ name })}
      />
      <Field
        label={FIELDS.role}
        value={draft.role}
        placeholder={FIELDS.rolePlaceholder}
        onChange={(role) => props.onChange({ role })}
      />

      <span className={shared.fieldLabel}>{FIELDS.colour}</span>
      {/* Native `<fieldset>` grouping, like ChipRow's own choice. */}
      <fieldset className={styles.swatches} aria-label={FIELDS.colour}>
        {HUE_KEYS.map((key) => {
          const value = hueValue(key);
          return (
            <button
              key={key}
              type="button"
              className={styles.swatch}
              style={{ background: value }}
              aria-label={LABELS.colour(key)}
              aria-pressed={draft.avatar_color === value}
              onClick={() => props.onChange({ avatar_color: value })}
            />
          );
        })}
      </fieldset>

      <span className={shared.fieldLabel}>{FIELDS.cadence}</span>
      <ChipRow
        label={FIELDS.cadence}
        options={CADENCE_OPTIONS}
        active={String(draft.cadence_days)}
        onSelect={(id) => props.onChange({ cadence_days: Number(id) })}
      />

      <Commits narrow={props.narrow}>
        <button
          type="button"
          className="kit-btn primary"
          onClick={props.onSave}
        >
          {VERBS.save}
        </button>
        <button
          type="button"
          className="kit-btn quiet"
          onClick={props.onCancel}
        >
          {VERBS.cancel}
        </button>
      </Commits>
    </>
  );
}
