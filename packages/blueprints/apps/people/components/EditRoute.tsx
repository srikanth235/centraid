// Edit / New person (v12 handoff § 8) — one form, written as one commit.
//
// `new` and `edit` DRAW THE SAME FORM. The mode only names the screen and
// decides which write `app-root.tsx` sends; a screen that grew a second layout
// for a draft with no `party_id` would be two forms to keep in step.
//
// THE HANDOFF'S `Vaults` SECTION IS ABSENT, along with its composer and its
// empty line: no People query returns a vault link, so there is nothing here to
// list or to write (people-copy.ts holds the whole withheld set). The handoff's
// `Never` cadence chip is absent for the reason CADENCE_CHIPS gives: the vault
// types `cadence_days` with a minimum of 1.
//
// THE SWATCHES WRITE WHAT THE AVATAR READS. `PersonAvatar` resolves a person
// with no stored colour to `var(--c-<hue>)`, so a chosen swatch stores that
// same expression rather than a hex: a hex is one theme's ring frozen into the
// vault, and the ring moves between light and dark (`identityInk` in
// `@centraid/design` exists because of exactly that). A person carrying a
// legacy hex therefore matches no swatch — honest, rather than a swatch
// claiming a colour it did not write.
import type { ReactNode } from "react";

import { IDENTITY_HUE_KEYS } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { agoLabel } from "../format.ts";
import { CADENCE_CHIPS, FIELDS, LABELS, VERBS } from "../people-copy.ts";
import type { EditRouteProps } from "../types.ts";
import { ChipRow, Commits, Field, SkeletonBlock } from "./Shared.tsx";

import styles from "./EditRoute.module.css";
import shared from "./shared.module.css";

// The eight identity hues in wheel order, from the design system rather than
// a local wheel — the same list every avatar draws from.
const HUE_KEYS = IDENTITY_HUE_KEYS;

/** The stored value for a hue, and the fill the swatch paints: one expression,
 *  so the disc on this screen and the disc in every row cannot disagree. */
function hueValue(key: ColorKey): string {
  return `var(--c-${key})`;
}

/** `7 days` · `14 days` · … — the chip labels come from `format.ts`, so the
 *  cadence reads the same word here as it does on the person screen. */
const CADENCE_OPTIONS = CADENCE_CHIPS.map((days) => ({
  id: String(days),
  label: agoLabel(days),
}));

export function EditRoute(props: EditRouteProps): ReactNode {
  const draft = props.draft;
  // A draft the orchestrator has not built yet is the same state as a read in
  // flight: the skeleton, never an empty form that could be saved over.
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
      {/* A `<fieldset>` rather than a div carrying `role="group"`, the same way
          `ChipRow` groups its own choice: the grouping is native. */}
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
