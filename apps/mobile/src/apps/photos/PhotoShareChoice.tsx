// THE QUESTION ASKED BEFORE A PHOTOGRAPH LEAVES (#816).
//
// One sheet, one question, one tap: how much of where this was taken goes with
// the copy. It is asked EVERY time rather than remembered as a setting —
// a remembered "exact" would send a location on some later share the member
// was not thinking about, and this decision is cheap enough to make each time.
//
// The rows come straight from `share-place.ts`, so the wording and the order
// are the product's, not this component's; the safe rung is first and carries
// the tick because it is where every share starts.
//
// It uses the kit's `OptionSheet` — the system action sheet on iOS, a bottom
// sheet on Android — so the question arrives the way every other single choice
// in this app arrives.

import React from "react";

import {
  SHARE_PLACE_DEFAULT,
  SHARE_PLACE_TITLE,
  sharePlaceOptions,
} from "@centraid/blueprints/apps/photos/share-place";
import type {
  SharePlaceInput,
  SharePlacePrecision,
} from "@centraid/blueprints/apps/photos/share-place";

import OptionSheet from "../../kit/components/OptionSheet";

export function PhotoShareChoice({
  visible,
  place,
  onChoose,
  onClose,
}: {
  visible: boolean;
  /** Where the photograph was taken, as the viewer already holds it. */
  place: SharePlaceInput;
  onChoose: (precision: SharePlacePrecision) => void;
  onClose: () => void;
}): React.JSX.Element {
  // Derived on every render, never remembered: a place renamed since the last
  // share changes what the sheet can offer, and nothing here can quietly send
  // a location on the strength of an older answer.
  const choices = sharePlaceOptions(place);
  return (
    <OptionSheet
      visible={visible}
      title={SHARE_PLACE_TITLE}
      selectedId={SHARE_PLACE_DEFAULT}
      options={choices.map((choice) => ({
        detail: choice.detail,
        id: choice.precision,
        label: choice.label,
      }))}
      onSelect={(id) => {
        // Chosen by identity from the offered rows, never cast from the id:
        // the sheet can only return a precision it actually offered.
        const chosen = choices.find((choice) => choice.precision === id);
        if (chosen) onChoose(chosen.precision);
      }}
      onClose={onClose}
    />
  );
}
