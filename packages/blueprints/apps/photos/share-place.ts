// A share's place precision, decided once before bytes leave (#816). `none` is
// the default; `sharePlaceStripsLocation` says when a caller owes a strip.

import { placePhrase } from "./place-phrase.ts";
import type { NamedPlace, PlacePhrase } from "./place-phrase.ts";

export type SharePlacePrecision = "none" | "name" | "exact";

export const SHARE_PLACE_DEFAULT: SharePlacePrecision = "none";

export const SHARE_PLACE_TITLE = "Send a copy — how much of the place?";

export const SHARE_PLACE_NOT_REMOVABLE =
  "The location could not be taken out of this file, so nothing was sent.";

export interface SharePlaceInput {
  placeName?: string | null;
  gazetteerName?: string | null;
  lat?: number | null;
  lng?: number | null;
  namedPlaces?: readonly NamedPlace[];
}

export interface SharePlaceOption {
  precision: SharePlacePrecision;
  label: string;
  detail: string;
}

// The only phrase allowed off-device: hard-wires `context: "shared"`.
export function sharedPlacePhrase(input: SharePlaceInput): PlacePhrase {
  return placePhrase({ ...input, context: "shared" });
}

export function sharePlaceName(input: SharePlaceInput): string | null {
  const phrase = sharedPlacePhrase(input);
  return phrase.source === "none" ? null : phrase.text;
}

function located(input: SharePlaceInput): boolean {
  return (
    input.lat != null &&
    input.lng != null &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng)
  );
}

// `exact` is offered with no known coordinate — the camera wrote one.
export function sharePlaceOptions(
  input: SharePlaceInput
): readonly SharePlaceOption[] {
  const name = sharePlaceName(input);
  return [
    {
      precision: "none",
      label: "No place",
      detail: "The copy leaves with no location in it.",
    },
    ...(name === null
      ? []
      : [
          {
            precision: "name" as const,
            label: "Place name only",
            detail: `${name} travels as words; the location still comes out of the file.`,
          },
        ]),
    {
      precision: "exact",
      label: "Exact location",
      detail: located(input)
        ? "The original file, with the spot it was taken."
        : "The original file, with whatever the camera recorded.",
    },
  ];
}

export function sharePlaceMessage(
  precision: SharePlacePrecision,
  input: SharePlaceInput
): string | undefined {
  if (precision !== "name") return undefined;
  return sharePlaceName(input) ?? undefined;
}

// `name` strips too: words are no licence for the fix underneath.
export function sharePlaceStripsLocation(
  precision: SharePlacePrecision
): boolean {
  return precision !== "exact";
}

// Stated every time, `none` included; silence reads as safety.
export function sharePlaceReceipt(
  precision: SharePlacePrecision,
  input: SharePlaceInput
): string {
  if (precision === "exact") return "Sent with the exact location.";
  const name =
    precision === "name" ? sharePlaceMessage(precision, input) : undefined;
  return name === undefined
    ? "Sent with no location."
    : `Sent with the place name only — ${name}.`;
}
