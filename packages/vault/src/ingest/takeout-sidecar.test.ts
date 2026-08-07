// Google Takeout's metadata layer, on its own (issue #721 A1). Every rule in
// takeout-sidecar.ts is a heuristic about undocumented behaviour, so each one
// is pinned here against the archive shapes Google has actually shipped.

import { describe, expect, test } from "vitest";

import {
  isMediaPath,
  parseTakeoutSidecar,
  planTakeout,
} from "./takeout-sidecar.js";

function sidecar(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const MOV = Buffer.from("ftypqt  ", "latin1");

describe("takeout sidecar parsing", () => {
  test("photoTakenTime is epoch SECONDS in a string", () => {
    const facts = parseTakeoutSidecar(
      JSON.stringify({ photoTakenTime: { timestamp: "1561234567" } })
    );
    expect(facts.capturedAt).toBe("2019-06-22T20:16:07.000Z");
  });

  test('"0", a missing time and an absurd one all mean NULL — never 1970', () => {
    const zero = parseTakeoutSidecar(
      JSON.stringify({ photoTakenTime: { timestamp: "0" } })
    );
    const missing = parseTakeoutSidecar(JSON.stringify({ description: "hi" }));
    const absurd = parseTakeoutSidecar(
      JSON.stringify({ photoTakenTime: { timestamp: "99999999999999" } })
    );
    expect([
      zero.capturedAt,
      missing.capturedAt,
      absurd.capturedAt,
    ]).toStrictEqual([null, null, null]);
  });

  test("exact (0, 0) geo is absence, not Null Island", () => {
    const zeros = parseTakeoutSidecar(
      JSON.stringify({ geoData: { latitude: 0, longitude: 0 } })
    );
    expect([zeros.latitude, zeros.longitude]).toStrictEqual([null, null]);
    const real = parseTakeoutSidecar(
      JSON.stringify({ geoData: { latitude: 48.8584, longitude: 2.2945 } })
    );
    expect([real.latitude, real.longitude]).toStrictEqual([48.8584, 2.2945]);
    // A zero on ONE axis is a real coordinate (the equator, the meridian).
    const equator = parseTakeoutSidecar(
      JSON.stringify({ geoData: { latitude: 0, longitude: 2.2945 } })
    );
    expect([equator.latitude, equator.longitude]).toStrictEqual([0, 2.2945]);
  });

  test("description becomes the caption; favorited becomes the star", () => {
    const facts = parseTakeoutSidecar(
      JSON.stringify({ description: "  Ferry to Elba  ", favorited: true })
    );
    expect(facts.caption).toBe("Ferry to Elba");
    expect(facts.favorite).toBe(true);
    const blank = parseTakeoutSidecar(JSON.stringify({ description: "   " }));
    expect(blank.caption).toBeNull();
    expect(blank.favorite).toBe(false);
  });

  test("a corrupt sidecar yields no facts rather than failing its photo", () => {
    expect(parseTakeoutSidecar("{not json")).toStrictEqual({
      capturedAt: null,
      latitude: null,
      longitude: null,
      caption: null,
      favorite: false,
    });
  });
});

describe("takeout sidecar pairing", () => {
  test("the classic and supplemental-metadata names both pair", () => {
    const plan = planTakeout([
      { name: "Google Photos/Trip/IMG_1.HEIC", data: JPEG },
      {
        name: "Google Photos/Trip/IMG_1.HEIC.json",
        data: sidecar({ description: "classic" }),
      },
      { name: "Google Photos/Trip/IMG_2.HEIC", data: JPEG },
      {
        name: "Google Photos/Trip/IMG_2.HEIC.supplemental-metadata.json",
        data: sidecar({ description: "supplemental" }),
      },
    ]);
    expect(plan.media.map((m) => m.sidecar.caption)).toStrictEqual([
      "classic",
      "supplemental",
    ]);
    expect(plan.metadata.size).toBe(2);
  });

  test("a duplicate's marker moves to the END of the sidecar name", () => {
    const plan = planTakeout([
      { name: "Google Photos/Trip/IMG_1(1).HEIC", data: JPEG },
      {
        name: "Google Photos/Trip/IMG_1.HEIC(1).json",
        data: sidecar({ description: "the copy" }),
      },
    ]);
    expect(plan.media[0]!.sidecar.caption).toBe("the copy");
  });

  test("an -edited image shares the original's sidecar", () => {
    const plan = planTakeout([
      { name: "Google Photos/Trip/IMG_1.jpg", data: JPEG },
      { name: "Google Photos/Trip/IMG_1-edited.jpg", data: JPEG },
      {
        name: "Google Photos/Trip/IMG_1.jpg.json",
        data: sidecar({ photoTakenTime: { timestamp: "1561234567" } }),
      },
    ]);
    expect(plan.media.map((m) => m.sidecar.capturedAt)).toStrictEqual([
      "2019-06-22T20:16:07.000Z",
      "2019-06-22T20:16:07.000Z",
    ]);
  });

  test("a truncated long sidecar name still pairs by prefix", () => {
    const long = `${"a".repeat(60)}.jpg`;
    const truncated = `${"a".repeat(46)}.json`;
    const plan = planTakeout([
      { name: `Google Photos/Trip/${long}`, data: JPEG },
      {
        name: `Google Photos/Trip/${truncated}`,
        data: sidecar({ description: "truncated" }),
      },
    ]);
    expect(plan.media[0]!.sidecar.caption).toBe("truncated");
  });

  test("a short shared opening is a coincidence, not a pairing", () => {
    const plan = planTakeout([
      { name: "Google Photos/Trip/IMG_1234.jpg", data: JPEG },
      {
        name: "Google Photos/Trip/IMG.json",
        data: sidecar({ description: "not mine" }),
      },
    ]);
    expect(plan.media[0]!.sidecarPath).toBeNull();
    expect(plan.media[0]!.sidecar.caption).toBeNull();
    // An unclaimed .json is NOT consumed — the spine reports it unrouted.
    expect(plan.metadata.has("Google Photos/Trip/IMG.json")).toBe(false);
  });
});

describe("takeout album reconstruction", () => {
  test("a folder is an album; metadata.json titles it", () => {
    const plan = planTakeout([
      { name: "Takeout/Google Photos/Elba 2019/IMG_1.jpg", data: JPEG },
      {
        name: "Takeout/Google Photos/Elba 2019/metadata.json",
        data: sidecar({ title: "Elba, summer" }),
      },
    ]);
    expect(plan.media[0]!.album).toBe("Elba, summer");
    expect(
      plan.metadata.has("Takeout/Google Photos/Elba 2019/metadata.json")
    ).toBe(true);
  });

  test("an album with no metadata.json keeps its folder name", () => {
    const plan = planTakeout([
      { name: "Takeout/Google Photos/Elba 2019/IMG_1.jpg", data: JPEG },
    ]);
    expect(plan.media[0]!.album).toBe("Elba 2019");
  });

  test("year folders, structural folders and the root are not albums", () => {
    const plan = planTakeout([
      { name: "Takeout/Google Photos/Photos from 2019/a.jpg", data: JPEG },
      { name: "Takeout/Google Photos/2019/b.jpg", data: JPEG },
      { name: "Takeout/Google Photos/c.jpg", data: JPEG },
      { name: "d.jpg", data: JPEG },
    ]);
    expect(plan.media.map((m) => m.album)).toStrictEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("a year folder stays a non-album even carrying a metadata.json", () => {
    const plan = planTakeout([
      { name: "Google Photos/Photos from 2019/a.jpg", data: JPEG },
      {
        name: "Google Photos/Photos from 2019/metadata.json",
        data: sidecar({ title: "Photos from 2019" }),
      },
    ]);
    expect(plan.media[0]!.album).toBeNull();
  });
});

describe("takeout live-photo pairing", () => {
  test("an image and a video sharing a basename share a capture group", () => {
    const plan = planTakeout([
      { name: "Google Photos/Trip/IMG_1.HEIC", data: JPEG },
      { name: "Google Photos/Trip/IMG_1.MOV", data: MOV },
      { name: "Google Photos/Trip/IMG_2.HEIC", data: JPEG },
    ]);
    const groups = plan.media.map((m) => m.captureGroupId);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[0]).toMatch(/^takeout:[0-9a-f]{32}$/u);
    // A photo with no motion half is not half a Live Photo.
    expect(groups[2]).toBeNull();
  });

  test("two videos alone never form a capture group", () => {
    const plan = planTakeout([
      { name: "Google Photos/Trip/clip.MOV", data: MOV },
      { name: "Google Photos/Trip/clip.mp4", data: MOV },
    ]);
    expect(plan.media.map((m) => m.captureGroupId)).toStrictEqual([null, null]);
  });

  test("the same basename in two albums is two different moments", () => {
    const plan = planTakeout([
      { name: "Google Photos/A/IMG_1.HEIC", data: JPEG },
      { name: "Google Photos/A/IMG_1.MOV", data: MOV },
      { name: "Google Photos/B/IMG_1.HEIC", data: JPEG },
      { name: "Google Photos/B/IMG_1.MOV", data: MOV },
    ]);
    const groups = plan.media.map((m) => m.captureGroupId);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[2]).toBe(groups[3]);
    expect(groups[0]).not.toBe(groups[2]);
  });

  test("the group id is derived from the path, so it is stable per archive", () => {
    const entries = [
      { name: "Google Photos/Trip/IMG_1.HEIC", data: JPEG },
      { name: "Google Photos/Trip/IMG_1.MOV", data: MOV },
    ];
    expect(planTakeout(entries).media[0]!.captureGroupId).toBe(
      planTakeout(entries).media[0]!.captureGroupId
    );
  });
});

describe("takeout media routing", () => {
  test("only formats the spool can sniff count as library media", () => {
    expect(
      ["a.jpg", "a.HEIC", "a.mp4", "a.MOV", "a.webp"].every(isMediaPath)
    ).toBe(true);
    expect(
      ["archive_browser.html", "a.tif", "a.psd", "a.json", "a"].some(
        isMediaPath
      )
    ).toBe(false);
  });
});
