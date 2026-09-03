import { describe, expect, it } from "vitest";

import { PLACE_NO_NAME, placePhrase, relativePhrase } from "./place-phrase.ts";
import type { NamedPlace } from "./place-phrase.ts";
import {
  SHARE_PLACE_DEFAULT,
  sharePlaceMessage,
  sharePlaceName,
  sharePlaceOptions,
  sharePlaceReceipt,
  sharePlaceStripsLocation,
  sharedPlacePhrase,
} from "./share-place.ts";
import type { SharePlaceInput, SharePlacePrecision } from "./share-place.ts";

const HOME: NamedPlace = {
  key: "home",
  name: "Home",
  lat: 37.4419,
  lng: -122.143,
  isHome: true,
};

const UP_THE_VALLEY: SharePlaceInput = {
  lat: 37.4635,
  lng: -122.1145,
  namedPlaces: [HOME],
};

const PRECISIONS: readonly SharePlacePrecision[] = ["none", "name", "exact"];

const INPUTS: readonly SharePlaceInput[] = [
  {},
  UP_THE_VALLEY,
  { ...UP_THE_VALLEY, placeName: "Emerald Bay" },
  { ...UP_THE_VALLEY, gazetteerName: "Truckee, CA" },
  { ...UP_THE_VALLEY, placeName: "37.46350, -122.11450" },
  { lat: 37.4419, lng: -122.143, namedPlaces: [HOME] },
  { lat: Number.NaN, lng: Number.NaN, namedPlaces: [HOME] },
];

const RELATIVE_SHAPE = /\d\s?(?:m|km)\s(?:N|NE|E|SE|S|SW|W|NW)\sof\s/u;

function everySentence(input: SharePlaceInput): string[] {
  return [
    ...sharePlaceOptions(input).flatMap((option) => [
      option.label,
      option.detail,
    ]),
    ...PRECISIONS.flatMap((precision) => [
      sharePlaceMessage(precision, input) ?? "",
      sharePlaceReceipt(precision, input),
    ]),
  ];
}

describe("the choice a member is offered", () => {
  it("starts on the rung that discloses nothing", () => {
    expect(SHARE_PLACE_DEFAULT).toBe("none");
    expect(sharePlaceOptions(UP_THE_VALLEY)[0]?.precision).toBe("none");
  });

  it("offers the name only when the ladder has a name to offer", () => {
    expect(
      sharePlaceOptions({ ...UP_THE_VALLEY, placeName: "Emerald Bay" }).map(
        (option) => option.precision
      )
    ).toStrictEqual(["none", "name", "exact"]);
    expect(
      sharePlaceOptions(UP_THE_VALLEY).map((option) => option.precision)
    ).toStrictEqual(["none", "exact"]);
  });

  it("still offers the exact rung for a photograph with no known coordinate — the file may carry one anyway", () => {
    expect(
      sharePlaceOptions({}).map((option) => option.precision)
    ).toStrictEqual(["none", "exact"]);
    expect(sharePlaceOptions({}).at(-1)?.detail).toBe(
      "The original file, with whatever the camera recorded."
    );
    expect(sharePlaceOptions(UP_THE_VALLEY).at(-1)?.detail).toBe(
      "The original file, with the spot it was taken."
    );
  });

  it("carries a name the member typed, and a settlement name with its hedge", () => {
    expect(
      sharePlaceName({ ...UP_THE_VALLEY, placeName: "Grandma's house" })
    ).toBe("Grandma's house");
    expect(
      sharePlaceName({ ...UP_THE_VALLEY, gazetteerName: "Truckee, CA" })
    ).toBe("near Truckee, CA");
  });

  it("never offers a coordinate wearing a name's clothes", () => {
    expect(
      sharePlaceName({ ...UP_THE_VALLEY, placeName: "37.46350, -122.11450" })
    ).toBeNull();
  });
});

describe("the Home-relative rung never leaves the device", () => {
  it("is exactly what the member's own screen would have said", () => {
    expect(relativePhrase(UP_THE_VALLEY.lat!, UP_THE_VALLEY.lng!, [HOME])).toBe(
      "3.5 km NE of Home"
    );
    expect(placePhrase({ ...UP_THE_VALLEY, context: "private" }).text).toBe(
      "3.5 km NE of Home"
    );
  });

  it("falls to the honest fallback in a shared context, and offers no name", () => {
    expect(sharedPlacePhrase(UP_THE_VALLEY)).toStrictEqual({
      text: PLACE_NO_NAME,
      source: "none",
    });
    expect(sharePlaceName(UP_THE_VALLEY)).toBeNull();
    expect(sharePlaceMessage("name", UP_THE_VALLEY)).toBeUndefined();
  });

  it("appears in no label, no detail, no message and no receipt, for any input", () => {
    const offending = INPUTS.flatMap((input) =>
      everySentence(input).filter((sentence) => RELATIVE_SHAPE.test(sentence))
    );
    expect(offending).toStrictEqual([]);
  });

  it("is never what a message says, even where the private ladder had one", () => {
    const leaked = INPUTS.flatMap((input) => {
      const relative =
        input.lat == null || input.lng == null
          ? null
          : relativePhrase(input.lat, input.lng, input.namedPlaces ?? []);
      const message = sharePlaceMessage("name", input);
      return relative !== null && message === relative ? [relative] : [];
    });
    expect(leaked).toStrictEqual([]);
  });
});

describe("what the precision owes the caller", () => {
  it("makes everything below the exact pin strip the file", () => {
    expect(
      PRECISIONS.map((precision) => [
        precision,
        sharePlaceStripsLocation(precision),
      ])
    ).toStrictEqual([
      ["none", true],
      ["name", true],
      ["exact", false],
    ]);
  });

  it("sends words only at the name rung", () => {
    const named = { ...UP_THE_VALLEY, gazetteerName: "Truckee, CA" };
    expect(
      PRECISIONS.map((precision) => sharePlaceMessage(precision, named))
    ).toStrictEqual([undefined, "near Truckee, CA", undefined]);
  });

  it("says what left every time, including when nothing about the place did", () => {
    const named = { ...UP_THE_VALLEY, gazetteerName: "Truckee, CA" };
    expect(
      PRECISIONS.map((precision) => sharePlaceReceipt(precision, named))
    ).toStrictEqual([
      "Sent with no location.",
      "Sent with the place name only — near Truckee, CA.",
      "Sent with the exact location.",
    ]);
  });
});
