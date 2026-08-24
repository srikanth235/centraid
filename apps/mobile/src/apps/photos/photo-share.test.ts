// THE CALL SITE, not the ladder (#816).
//
// `share-place.test.ts` proves the phrase module suppresses the Home-relative
// rung. That is a claim about a function; the acceptance criterion is a claim
// about what leaves the phone. So this file drives the real share path with
// the real seams mocked at the edge — the file system, the system sheet, React
// Native's `Share` — and asserts on the payload the operating system was
// actually handed.
//
// It fails if a future caller builds the message with the private ladder
// (the phrase would come back as "3.5 km NE of Home"), if the strip is skipped
// for any precision below `exact` (the payload would point at the original
// file), or if a container that cannot be scrubbed is sent anyway.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { placePhrase } from "@centraid/blueprints/apps/photos/place-phrase";
import type { NamedPlace } from "@centraid/blueprints/apps/photos/place-phrase";
import type {
  SharePlaceInput,
  SharePlacePrecision,
} from "@centraid/blueprints/apps/photos/share-place";

import { stripJpegLocation } from "./exif-location-strip";

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  reEncoded: "file:///cache/re-encoded.jpg",
  share: vi.fn<() => Promise<{ action: string }>>(async () => ({
    action: "sharedAction",
  })),
  shareAsync: vi.fn<() => Promise<void>>(async () => undefined),
  sheetAvailable: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock(import("expo-file-system"), () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .join("/");
    }
    async bytes(): Promise<Uint8Array> {
      const found = mocks.files.get(this.uri);
      if (!found) throw new Error(`no bytes at ${this.uri}`);
      return found;
    }
    create(): void {
      mocks.files.set(this.uri, new Uint8Array());
    }
    write(bytes: Uint8Array): void {
      mocks.files.set(this.uri, bytes);
    }
  }
  return { File, Paths: { cache: "file:///cache" } } as never;
});

vi.mock(
  import("expo-image-manipulator"),
  () =>
    ({
      ImageManipulator: {
        manipulate: () => ({
          renderAsync: async () => ({
            saveAsync: async () => ({ uri: mocks.reEncoded }),
          }),
        }),
      },
      SaveFormat: { JPEG: "jpeg" },
    }) as never
);

vi.mock(
  import("expo-sharing"),
  () =>
    ({
      isAvailableAsync: mocks.sheetAvailable,
      shareAsync: mocks.shareAsync,
    }) as never
);

vi.mock(
  import("react-native"),
  () =>
    ({
      Share: { share: mocks.share },
    }) as never
);

const { LocationNotRemovableError, shareOriginal } =
  await import("./photo-share");

/** A NUL without a literal zero byte in the source. */
const NUL = String.fromCharCode(0);

const ORIGINAL = "file:///photos/IMG_4021.jpg";
const HEIC = "file:///photos/IMG_4022.heic";

/** A JPEG whose XMP packet names the coordinate in plain ASCII. */
function locatedJpeg(): Uint8Array {
  const packet = `http://ns.adobe.com/xap/1.0/${NUL}<x:xmpmeta exif:GPSLatitude="37,26.514000N"/>`;
  const payload = [...packet].map((character) => character.charCodeAt(0));
  const length = payload.length + 2;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    (length >> 8) & 0xff,
    length & 0xff,
    ...payload,
    0xff,
    0xda,
    0x00,
    0x02,
    0x11,
    0x22,
    0xff,
    0xd9,
  ]);
}

/** Not a JPEG: the first bytes of an ISO base-media file, as HEIC opens. */
const NOT_A_JPEG = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101]);

const HOME: NamedPlace = {
  key: "home",
  name: "Home",
  lat: 37.4419,
  lng: -122.143,
  isHome: true,
};

/** Up the valley from Home, and nobody has named it. */
const UNNAMED_NEAR_HOME: SharePlaceInput = {
  lat: 37.4635,
  lng: -122.1145,
  namedPlaces: [HOME],
};

const RELATIVE_SHAPE = /\d\s?(?:m|km)\s(?:N|NE|E|SE|S|SW|W|NW)\sof\s/u;

/** What the copy the OS was handed actually contains. */
function handedBytes(uri: string): Uint8Array {
  return mocks.files.get(uri) ?? new Uint8Array();
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** A cache holding one original, one HEIC and one re-encode, and no calls. */
function freshDevice(): void {
  mocks.files.clear();
  mocks.files.set(ORIGINAL, locatedJpeg());
  mocks.files.set(HEIC, NOT_A_JPEG);
  mocks.files.set(mocks.reEncoded, locatedJpeg());
  mocks.share.mockClear();
  mocks.shareAsync.mockClear();
  mocks.sheetAvailable.mockClear();
}

const request = (
  precision: SharePlacePrecision,
  place: SharePlaceInput = {},
  overrides: { uri?: string; kind?: "photo" | "video" } = {}
): Parameters<typeof shareOriginal>[0] => ({
  filename: "IMG_4021.jpg",
  kind: overrides.kind ?? "photo",
  place,
  precision,
  uri: overrides.uri ?? ORIGINAL,
});

describe("what the operating system is handed", () => {
  beforeEach(freshDevice);

  it("gets a scrubbed copy at the default precision, never the original file", async () => {
    const payload = await shareOriginal(request("none"));
    expect(payload).toStrictEqual({
      uri: "file:///cache/shared-copies/IMG_4021.jpg",
    });
    expect([...handedBytes(payload.uri)]).toStrictEqual([
      ...stripJpegLocation(locatedJpeg())!.bytes,
    ]);
    expect(text(handedBytes(payload.uri))).not.toContain("GPSLatitude");
    // The file on disk is untouched: a share is a copy, not an edit.
    expect([...handedBytes(ORIGINAL)]).toStrictEqual([...locatedJpeg()]);
  });

  it("gets the original only when the member asked for the exact location", async () => {
    const payload = await shareOriginal(request("exact"));
    expect(payload).toStrictEqual({ uri: ORIGINAL });
    expect(text(handedBytes(payload.uri))).toContain("GPSLatitude");
  });

  it("gets the name as words, and a scrubbed file underneath them", async () => {
    const payload = await shareOriginal(
      request("name", { gazetteerName: "Truckee, CA" })
    );
    expect(payload).toStrictEqual({
      message: "near Truckee, CA",
      uri: "file:///cache/shared-copies/IMG_4021.jpg",
    });
    expect(text(handedBytes(payload.uri))).not.toContain("GPSLatitude");
  });

  it("goes through the system sheet without words, and React Native's Share with them", async () => {
    await shareOriginal(request("none"));
    expect(mocks.shareAsync.mock.calls).toStrictEqual([
      ["file:///cache/shared-copies/IMG_4021.jpg"],
    ]);
    expect(mocks.share.mock.calls).toStrictEqual([]);
    await shareOriginal(request("name", { placeName: "Emerald Bay" }));
    expect(mocks.share.mock.calls).toStrictEqual([
      [
        {
          message: "Emerald Bay",
          url: "file:///cache/shared-copies/IMG_4021.jpg",
        },
      ],
    ]);
  });
});

describe("a photograph taken near a place the member named", () => {
  beforeEach(freshDevice);

  it("would have been phrased against Home on the member's own screen", () => {
    // Keeps the assertion below honest: it is only evidence of suppression
    // while the private ladder still produces the phrase for this input.
    expect(placePhrase({ ...UNNAMED_NEAR_HOME, context: "private" }).text).toBe(
      "3.5 km NE of Home"
    );
  });

  it("leaves with no phrase at all, at every precision", async () => {
    // One at a time, in the order the sheet offers them — a share is a
    // deliberate act and the mocked cache holds one copy at a time.
    const payloads = [
      await shareOriginal(request("none", UNNAMED_NEAR_HOME)),
      await shareOriginal(request("name", UNNAMED_NEAR_HOME)),
      await shareOriginal(request("exact", UNNAMED_NEAR_HOME)),
    ];
    expect(payloads.map((payload) => payload.message)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const offending = payloads
      .map((payload) => payload.message ?? "")
      .filter((message) => RELATIVE_SHAPE.test(message));
    expect(offending).toStrictEqual([]);
  });
});

describe("bytes this device cannot scrub", () => {
  beforeEach(freshDevice);

  it("re-encodes a photograph that is not a JPEG, then scrubs the result", async () => {
    const payload = await shareOriginal(
      request("none", {}, { kind: "photo", uri: HEIC })
    );
    expect(payload.uri).toBe("file:///cache/shared-copies/IMG_4021.jpg");
    expect(text(handedBytes(payload.uri))).not.toContain("GPSLatitude");
  });

  it("refuses a video rather than sending one with its location intact", async () => {
    await expect(
      shareOriginal(request("none", {}, { kind: "video", uri: HEIC }))
    ).rejects.toBeInstanceOf(LocationNotRemovableError);
    expect(mocks.share.mock.calls).toStrictEqual([]);
    expect(mocks.shareAsync.mock.calls).toStrictEqual([]);
  });

  it("sends a video the member chose to send at the exact location", async () => {
    const payload = await shareOriginal(
      request("exact", {}, { kind: "video", uri: HEIC })
    );
    expect(payload).toStrictEqual({ uri: HEIC });
  });
});
