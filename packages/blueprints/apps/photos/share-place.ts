// WHAT A SHARED PHOTOGRAPH SAYS ABOUT WHERE IT WAS TAKEN, and at what
// precision — the choice a member makes once, per share, before any bytes
// leave (issue #816).
//
// A photograph on the member's own screen and the same photograph in somebody
// else's hands are two different disclosures. The screen may say "3.4 km NE of
// Home" because the reader IS the person who named Home; the copy that leaves
// may not, because the reader is a stranger holding a bearing and a distance
// to where the member lives. `place-phrase.ts` already knows this — its
// `"shared"` context skips the relative rung — but knowing it is not the same
// as being unable to forget it. This module is where a share's place is
// decided, so there is exactly one call site to audit and one default to read.
//
// THREE PRECISIONS, and no more. The granularity a share can carry is the
// granularity the phrase ladder already has, which is why there is no separate
// "city" rung: rung 2 IS the settlement name ("near Truckee, CA"), rung 1 is
// the name the member typed ("Grandma's house"), and asking a member to choose
// between "place name" and "city" would ask them to distinguish two rungs of a
// ladder they never see.
//
//   none  — the copy leaves with no location in it. THE DEFAULT.
//   name  — the phrase travels as words; the file's own fix is still removed.
//   exact — the original file, fix and all, because the member said so.
//
// WHY `none` IS THE DEFAULT. The leaky option must be the one a member reaches
// for on purpose. A share that carries a location because nobody changed a
// setting is a location nobody chose to disclose, and "they could have turned
// it off" is not consent.
//
// WHAT THIS MODULE DOES NOT DO. It never touches bytes. Removing the fix from
// the file is the caller's half of the bargain — on the phone that is
// `apps/mobile/src/apps/photos/exif-location-strip.ts`, and
// `sharePlaceStripsLocation` is the one predicate that says when it is owed.
// Splitting it this way is what lets both surfaces agree on the CHOICE while
// each strips with the primitive it actually has.
//
// WHY THIS ONE IMPORTS. `place-map.ts`, `place-phrase.ts` and `trips.ts` link
// nothing at all and duplicate small helpers with a comment. This module
// deliberately imports `placePhrase` instead of copying it: a copy of the
// ladder is a second answer to "what do we say about this place", and the
// whole point here is that the shared phrase is the SAME function the private
// one came from, with one argument different. Metro resolves the explicit
// `.ts` specifier for the native bundle (see `apps/mobile/metro.config.js`),
// which is why the import is safe in a file the Expo client also compiles.

import { placePhrase } from "./place-phrase.ts";
import type { NamedPlace, PlacePhrase } from "./place-phrase.ts";

/** How much of where a photograph was taken travels with a copy of it. */
export type SharePlacePrecision = "none" | "name" | "exact";

/**
 * The rung every share starts on. Nothing about the place rides along until
 * the member picks something else — see WHY `none` IS THE DEFAULT above.
 */
export const SHARE_PLACE_DEFAULT: SharePlacePrecision = "none";

/** The question the sheet asks, in the words of the action that raised it. */
export const SHARE_PLACE_TITLE = "Send a copy — how much of the place?";

/**
 * What a member is told when the location cannot be taken out of the bytes.
 *
 * A refusal, not a downgrade: the alternative to "we could not remove it" is
 * sending it anyway, which is the one outcome this whole module exists to make
 * impossible.
 *
 * One sentence, and it does not spell out the way through (U4, DESIGN.md
 * § Copy). A member who genuinely wants to send a video of somewhere they were
 * is still allowed to — the exact rung is on the sheet the next attempt opens,
 * which is a control rather than a sentence about a control.
 */
export const SHARE_PLACE_NOT_REMOVABLE =
  "The location could not be taken out of this file, so nothing was sent.";

/** Where the photograph was taken, as the caller already holds it. */
export interface SharePlaceInput {
  /** The linked place's stored name. Coordinate-shaped labels fall through. */
  placeName?: string | null;
  /** A settlement name from the opt-in gazetteer automation, when enabled. */
  gazetteerName?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** The member's named places. Anchors for a relative phrase — which is
   *  exactly what a shared context refuses to print, and they are passed
   *  through anyway so the suppression happens in one audited place. */
  namedPlaces?: readonly NamedPlace[];
}

/** One row of the choice, as a sheet renders it. */
export interface SharePlaceOption {
  precision: SharePlacePrecision;
  /** The choice, in three or four words. */
  label: string;
  /** What it does to the copy that leaves. */
  detail: string;
}

/**
 * The ONLY phrase allowed to leave the device.
 *
 * Hard-wires `context: "shared"`, which is what makes the suppression a
 * property of the module rather than of every caller's memory. Callers that
 * want the private phrase call `placePhrase` directly and say so.
 */
export function sharedPlacePhrase(input: SharePlaceInput): PlacePhrase {
  return placePhrase({ ...input, context: "shared" });
}

/**
 * The name a share may carry, or null when the ladder has none to give.
 *
 * Rung 4 ("A place with no name yet") is a sentence for a panel, not a thing
 * to send somebody: it tells a reader nothing, so the option is simply not
 * offered rather than offered and useless.
 */
export function sharePlaceName(input: SharePlaceInput): string | null {
  const phrase = sharedPlacePhrase(input);
  return phrase.source === "none" ? null : phrase.text;
}

/** Does this coordinate exist as a number? */
function located(input: SharePlaceInput): boolean {
  return (
    input.lat != null &&
    input.lng != null &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng)
  );
}

/**
 * The choices to put in front of a member, safest first.
 *
 * `exact` is offered even for a photograph the ledger knows no coordinate for:
 * a camera writes a fix into the file whether or not this app ever read it, so
 * "we know of no place" is not the same claim as "these bytes carry none", and
 * only the second one would justify hiding the choice.
 */
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

/**
 * The words that ride along with the copy, or nothing.
 *
 * Only the `name` precision has any, and even then only when the ladder still
 * answers — a choice made before the place was renamed to a coordinate cannot
 * resurrect a name that no longer exists.
 */
export function sharePlaceMessage(
  precision: SharePlacePrecision,
  input: SharePlaceInput
): string | undefined {
  if (precision !== "name") return undefined;
  return sharePlaceName(input) ?? undefined;
}

/**
 * Does this precision owe the caller a strip of the file's own location?
 *
 * Everything but `exact` does — including `name`, which is the point: the
 * words a member chose to send are not a licence to send the metre-accurate
 * fix underneath them.
 */
export function sharePlaceStripsLocation(
  precision: SharePlacePrecision
): boolean {
  return precision !== "exact";
}

/**
 * What the member is told AFTER the share, so what left is never a guess.
 *
 * Stated every time, including for `none`: a receipt that only appears when
 * something leaked teaches a member to read silence as safety.
 */
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
