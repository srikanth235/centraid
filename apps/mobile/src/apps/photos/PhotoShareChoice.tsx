// How much place detail travels with the copy (#816); asked EVERY time.

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
  place: SharePlaceInput;
  onChoose: (precision: SharePlacePrecision) => void;
  onClose: () => void;
}): React.JSX.Element {
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
        // Chosen by identity from the offered rows, never cast from the id.
        const chosen = choices.find((choice) => choice.precision === id);
        if (chosen) onChoose(chosen.precision);
      }}
      onClose={onClose}
    />
  );
}
