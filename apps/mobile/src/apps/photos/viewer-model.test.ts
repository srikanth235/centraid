import { describe, expect, test } from "vitest";

import {
  assetAspectRatio,
  fitMedia,
  FILMSTRIP,
  formatMediaClock,
  GESTURE_POINTER_EQUIVALENTS,
  infoSheetHeight,
  INFO_SHEET,
  LOAD_THE_ORIGINAL,
  marksAsElsewhere,
  originalStatus,
  originalWhereabouts,
  resolveOriginalPlacement,
  SLIDESHOW,
  SLIDESHOW_ACTION,
  SLIDESHOW_INTERVAL_MS,
  captureStamp,
  isZoomed,
  slideshowMeta,
  slideshowPosition,
  videoKindLabel,
  viewerStatus,
  viewerTitle,
  transportSpec,
  ZOOM_FIT,
  ZOOM_MAX,
  ZOOM_RUNG,
  zoomIn,
  zoomOut,
  VIEWER_ACTION_TARGET,
  VIEWER_BOTTOM_ACTIONS,
  VIEWER_BOTTOM_GROUPS,
  VIEWER_CHROME_CHIP,
  VIEWER_CHROME_INSET,
  VIEWER_TOP_CHROME,
  vaultLine,
  viewerAction,
  viewerChromeHeight,
  zoomReadout,
} from "./viewer-model";

describe("the phone's bottom row", () => {
  test("carries the same five actions, in the desktop bar's order", () => {
    expect(VIEWER_BOTTOM_ACTIONS.map((action) => action.id)).toStrictEqual([
      "copy",
      "favorite",
      "info",
      "edit",
      "trash",
    ]);
  });

  test("only Trash takes the destructive tone", () => {
    const net = VIEWER_BOTTOM_ACTIONS.filter(
      (action) => action.tone === "net"
    ).map((action) => action.id);
    expect(net).toStrictEqual(["trash"]);
  });

  test("every action is labelled, so no icon-only control is unreadable", () => {
    for (const action of VIEWER_BOTTOM_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.icon.length).toBeGreaterThan(0);
    }
  });

  test("the labels are the phone's short forms — the accessible name of every target", () => {
    // The row does not DRAW these, but every target takes its
    // `accessibilityLabel` from this field.
    expect(VIEWER_BOTTOM_ACTIONS.map((action) => action.label)).toStrictEqual([
      "Copy to another place",
      "Favorite",
      "Info",
      "Edit",
      "Trash",
    ]);
  });

  test("targets inside the capsule are 56, comfortably above the 44 floor", () => {
    expect(VIEWER_ACTION_TARGET).toBe(56);
    expect(VIEWER_ACTION_TARGET).toBeGreaterThanOrEqual(44);
  });
});

describe("the bottom row's anatomy: chip · capsule · chip", () => {
  test("is a lone leading chip, a capsule of three, and a lone trailing chip", () => {
    expect(
      VIEWER_BOTTOM_GROUPS.map((group) => [group.shape, ...group.actions])
    ).toStrictEqual([
      ["chip", "copy"],
      ["capsule", "favorite", "info", "edit"],
      ["chip", "trash"],
    ]);
  });

  test("the two ends are exactly the actions with consequences outside the photograph", () => {
    // The ends reach outside this photograph; the middle does not. That is
    // what the grouping is FOR, so it is asserted, not left to the eye.
    const ends = VIEWER_BOTTOM_GROUPS.filter(
      (group) => group.shape === "chip"
    ).flatMap((group) => [...group.actions]);
    expect(ends).toStrictEqual(["copy", "trash"]);
  });

  test("flattening the groups reproduces the desktop bar's five, in order", () => {
    // The phone REARRANGES the viewer; it does not drop or reorder an action.
    expect(
      VIEWER_BOTTOM_GROUPS.flatMap((group) => [...group.actions])
    ).toStrictEqual(VIEWER_BOTTOM_ACTIONS.map((action) => action.id));
  });

  test("every grouped id resolves to a real action, and an invented one throws", () => {
    for (const group of VIEWER_BOTTOM_GROUPS)
      for (const id of group.actions) expect(viewerAction(id).id).toBe(id);
    // A group naming an id the list does not carry is a wiring bug, not a
    // state to render an empty target for.
    // @ts-expect-error — the point of the assertion is the unlisted id (#712).
    expect(() => viewerAction("slideshow")).toThrow(
      "No viewer action named slideshow"
    );
  });
});

describe("the floating chrome at the head of the stage", () => {
  test("is three elements, not a bar — back, stamp, overflow", () => {
    expect(VIEWER_TOP_CHROME).toStrictEqual(["back", "stamp", "overflow"]);
  });

  test("the stamp is the middle one, so the two controls are the reachable ends", () => {
    expect(VIEWER_TOP_CHROME[1]).toBe("stamp");
  });

  test("a chip is 44 — the touch floor exactly, and not the bar's 56", () => {
    expect(VIEWER_CHROME_CHIP).toBe(44);
    expect(VIEWER_CHROME_CHIP).toBeLessThan(VIEWER_ACTION_TARGET);
  });

  test("the height it claims is its chip plus the inset above and below it", () => {
    // Only the editor subtracts this; the stage runs under the chrome, which
    // is the whole point of floating.
    expect(viewerChromeHeight(0)).toBe(
      VIEWER_CHROME_CHIP + VIEWER_CHROME_INSET * 2
    );
    expect(viewerChromeHeight(59)).toBe(59 + viewerChromeHeight(0));
  });
});

describe("the filmstrip", () => {
  test("survives on the phone at 58px", () => {
    // Dropping it would make the phone a slideshow — swipe and the strip are
    // the same control approached from two directions.
    expect(FILMSTRIP.height).toBe(58);
    expect(FILMSTRIP.current).toBe(58);
  });

  test("neighbours are 40 and the current one is outlined 2px", () => {
    expect(FILMSTRIP.neighbour).toBe(40);
    expect(FILMSTRIP.currentOutlineWidth).toBe(2);
    expect(FILMSTRIP.current).toBeGreaterThan(FILMSTRIP.neighbour);
  });
});

describe("the info sheet", () => {
  test("stands at 64% of the screen with a grabber", () => {
    expect(INFO_SHEET.heightFraction).toBeCloseTo(0.64);
    expect(INFO_SHEET.grabber).toBe(true);
  });

  test("64% of a 390x844 phone is a real height, not a fraction", () => {
    expect(infoSheetHeight(844)).toBe(540);
  });
});

describe("the vault a photograph is in", () => {
  test("the meaning derives from the record, never from the name", () => {
    const named = vaultLine(true, "Sharing");
    const plain = vaultLine(true, "My vault");
    // A member who called their OWN vault "Sharing" has not shared it.
    expect(named.meaning).toBe(plain.meaning);
    expect(named.meaning).toContain("Reachable by nothing");
  });

  test("the member's own vault is reachable by nothing", () => {
    expect(vaultLine(true, "My vault")).toStrictEqual({
      meaning:
        "Reachable by nothing — copy it somewhere shared to let someone see it.",
      value: "My vault",
    });
  });

  test("a shared vault is a place, so leaving it stops the sharing", () => {
    // One sentence for EVERY shared vault: the place a copy lands is the
    // recipient's vault, not a third kind of place, so a destination reads
    // exactly like any other shared vault the member can reach (§H).
    const line = vaultLine(false, "Ana + Sam");
    expect(line.value).toBe("Ana + Sam");
    expect(line.meaning).toContain("Ana + Sam");
    expect(line.meaning).toContain("stops being shared");
  });

  test("the marker fires for any vault but the member's own", () => {
    expect(marksAsElsewhere(true)).toBe(false);
    expect(marksAsElsewhere(false)).toBe(true);
  });
});

describe("zoom", () => {
  test("un-zoomed offers fit rather than a number", () => {
    expect(zoomReadout(1)).toStrictEqual({ label: "fit", mode: "fit" });
  });

  test("zoomed reads exactly, and says what the drag does", () => {
    expect(zoomReadout(2.4).label).toBe("240% · drag to pan");
    expect(zoomReadout(2.4).mode).toBe("zoomed");
  });

  test("only a zoomed photograph is offered a drag", () => {
    // The words `drag to pan` are a promise the transform has to keep. At fit
    // there is no overflow to pan into, so the readout must not offer one.
    expect(zoomReadout(1).label).not.toContain("drag to pan");
    expect(zoomReadout(ZOOM_FIT).label).toBe("fit");
  });

  test("a pinch that settles a hair over 1 is not a zoom", () => {
    expect(isZoomed(1.0005)).toBe(false);
    expect(isZoomed(1.2)).toBe(true);
  });

  test("every way in lands on ONE rung", () => {
    // A double tap at 2.5 and a chip at 2.4 make the same photograph read
    // 250% or 240% depending on which control you used.
    expect(zoomIn(ZOOM_FIT)).toBe(ZOOM_RUNG);
    expect(zoomReadout(zoomIn(ZOOM_FIT)).label).toBe("250% · drag to pan");
  });

  test("the ladder climbs to a ceiling and walks back down to fit", () => {
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomIn(ZOOM_RUNG)).toBeGreaterThan(ZOOM_RUNG);
    expect(zoomOut(ZOOM_FIT)).toBe(ZOOM_FIT);
    expect(zoomOut(zoomIn(ZOOM_RUNG))).toBeCloseTo(ZOOM_RUNG);
  });
});

describe("what the stage's one line says", () => {
  const onDevice = originalStatus(
    resolveOriginalPlacement({ hasDeviceOriginal: true }),
    "home-gateway"
  );
  const onGateway = originalStatus(
    resolveOriginalPlacement({ hasDeviceOriginal: false, networkType: "WIFI" }),
    "home-gateway"
  );

  test("a phone with nothing to fetch teaches the gestures", () => {
    // None of these gestures are discoverable by looking, and nothing else
    // says them.
    expect(
      viewerStatus({ bytes: onDevice, kind: "photo", scale: 1 })
    ).toStrictEqual({
      text: "Swipe for the next · pinch or double tap to zoom · swipe up for info",
    });
  });

  test("zoomed, it reads the live percentage and the way back", () => {
    const status = viewerStatus({ bytes: onDevice, kind: "photo", scale: 2.4 });
    expect(status.text).toBe("240% · drag to pan · double tap returns to fit");
    // No inline fetch while zoomed: a reflow under a pinched finger is a
    // control firing into a moving target.
    expect(status.action).toBeUndefined();
  });

  test("a zoom outranks even an original that could be fetched", () => {
    const status = viewerStatus({ bytes: onGateway, kind: "photo", scale: 3 });
    expect(status.text).toBe("300% · drag to pan · double tap returns to fit");
    expect(status.action).toBeUndefined();
  });

  test("an offer to spend bytes outranks the lesson", () => {
    const status = viewerStatus({ bytes: onGateway, kind: "photo", scale: 1 });
    expect(status.text).toBe(onGateway.text);
    expect(status.action).toBe(LOAD_THE_ORIGINAL);
  });

  test("a video says which copy is playing", () => {
    expect(
      viewerStatus({ bytes: onDevice, kind: "video", scale: 1 }).text
    ).toBe("Video · playing from the display copy on this device");
  });
});

describe("what a video IS", () => {
  test("kind, resolution and duration, in that order", () => {
    expect(videoKindLabel({ durationS: 24, height: 2160 })).toBe(
      "video · 4K · 0:24"
    );
  });

  test("resolution is named from the record's own pixel height", () => {
    expect(videoKindLabel({ height: 1440 })).toBe("video · 1440p");
    expect(videoKindLabel({ height: 1080 })).toBe("video · 1080p");
    expect(videoKindLabel({ height: 720 })).toBe("video · 720p");
    // Between the named rungs it is honest rather than promoted.
    expect(videoKindLabel({ height: 480 })).toBe("video · 480p");
  });

  test("a field the record does not carry is omitted, never invented", () => {
    expect(videoKindLabel({ durationS: 24 })).toBe("video · 0:24");
    expect(videoKindLabel({ height: 2160 })).toBe("video · 4K");
    expect(videoKindLabel({})).toBe("video");
    // Not a fabricated `0:00` for a recording of unknown length.
    expect(videoKindLabel({ durationS: 0, height: 2160 })).toBe("video · 4K");
  });
});

describe("fit on a 390px portrait screen", () => {
  test("a landscape photograph is bound by the width", () => {
    expect(fitMedia(1.5, { height: 600, width: 390 })).toStrictEqual({
      height: 260,
      width: 390,
    });
  });

  test("a tall photograph is bound by the height, not cropped", () => {
    expect(fitMedia(0.5, { height: 600, width: 390 })).toStrictEqual({
      height: 600,
      width: 300,
    });
  });

  test("a record with no dimensions still has a shape before its bytes", () => {
    expect(assetAspectRatio({})).toBe(1.5);
    expect(assetAspectRatio({ height: 2000, width: 3000 })).toBe(1.5);
  });
});

describe("transports", () => {
  test("video, audio and a live photo are three variants of one slot", () => {
    expect(transportSpec("video")?.kindLabel).toBe("video");
    expect(transportSpec("audio")?.kindLabel).toBe("audio");
    expect(transportSpec("photo", true)?.kindLabel).toBe("live photo");
  });

  test("a still photograph carries no transport", () => {
    expect(transportSpec("photo")).toBeNull();
  });

  test("every transport is determinate — there is no spinner", () => {
    for (const kind of ["video", "audio"]) {
      expect(transportSpec(kind)?.determinate).toBe(true);
    }
  });

  test("durations read as a clock", () => {
    expect(formatMediaClock(8)).toBe("0:08");
    expect(formatMediaClock(24)).toBe("0:24");
    expect(formatMediaClock(605.4)).toBe("10:05");
  });

  test("a duration rounds the way the web's clock rounds", () => {
    // One recording, one length: the browser prints `0:25` for this video, so
    // truncating here would give the same file two durations.
    expect(formatMediaClock(24.6)).toBe("0:25");
    expect(formatMediaClock(-3)).toBe("0:00");
  });

  test("past an hour it says hours — `90:00` is not an hour (#883 B5)", () => {
    // One file, one screen, one length: both the transport and the tile read
    // this from `_shared/format-kit.ts`.
    expect(formatMediaClock(3700)).toBe("1:01:40");
    expect(formatMediaClock(3_904)).toBe("1:05:04");
    expect(formatMediaClock(5400)).toBe("1:30:00");
  });
});

describe("where the original is", () => {
  test("a device copy needs no fetch and offers no action", () => {
    const status = originalStatus(
      resolveOriginalPlacement({ hasDeviceOriginal: true }),
      "home-gateway"
    );
    expect(status.placement).toBe("on-device");
    expect(status.action).toBeUndefined();
  });

  test("an OS-offloaded original is a truthful state, not a broken image", () => {
    const placement = resolveOriginalPlacement({
      hasDeviceOriginal: true,
      offloaded: true,
    });
    expect(originalStatus(placement, "home-gateway").text).toContain(
      "offloaded by this device"
    );
  });

  test("on wifi the gateway copy names the gateway and offers the fetch", () => {
    const status = originalStatus(
      resolveOriginalPlacement({
        hasDeviceOriginal: false,
        networkType: "WIFI",
      }),
      "home-gateway"
    );
    expect(status.text).toBe(
      "Original on home-gateway · a full-quality copy has not been fetched"
    );
    expect(status.action).toBe(LOAD_THE_ORIGINAL);
  });

  test("a metered connection is its own state and stays an explicit choice", () => {
    const placement = resolveOriginalPlacement({
      hasDeviceOriginal: false,
      networkType: "CELLULAR",
    });
    expect(placement).toBe("metered");
    const status = originalStatus(placement, "home-gateway");
    expect(status.text).toContain("spends mobile data");
    // The bytes never move on their own: the action is the only way through.
    expect(status.action).toBe(LOAD_THE_ORIGINAL);
    expect(originalWhereabouts(status)).toContain("your choice");
  });

  test("the tap is consent for this photograph, and it holds", () => {
    expect(
      resolveOriginalPlacement({
        hasDeviceOriginal: false,
        networkType: "CELLULAR",
        unlocked: true,
      })
    ).toBe("on-gateway");
  });
});

describe("slideshow is a different mode", () => {
  test("it drops the filmstrip and the info sheet", () => {
    expect(SLIDESHOW.filmstrip).toBe(false);
    expect(SLIDESHOW.info).toBe(false);
  });

  // THE MODEL MUST NOT DESCRIBE CONTROLS THAT DO NOT RENDER: the phone draws
  // no transport and no pause in slideshow.
  test("it claims no transport and no pause, because it draws neither", () => {
    expect(SLIDESHOW.transports).toBe(0);
    expect(SLIDESHOW.pause).toBe(false);
  });

  test("its one action's label and its effect are the same value", () => {
    expect(SLIDESHOW_ACTION).toStrictEqual({ effect: "leave", label: "Leave" });
  });

  test("the interval is the number the meta line promises", () => {
    expect(SLIDESHOW_INTERVAL_MS).toBe(4000);
    expect(slideshowMeta(11, 184)).toBe("12 of 184 · 4 seconds a photograph");
  });

  test("position is determinate, both halves", () => {
    expect(slideshowPosition(11, 184)).toStrictEqual({
      position: "12",
      total: "184",
    });
  });
});

describe("the viewer's floating stamp", () => {
  test("says what the photograph IS, not what it is called", () => {
    expect(
      viewerTitle({
        caption: "Ana on the sea wall, before the rain",
        filename: "IMG_4913.HEIC",
      })
    ).toBe("Ana on the sea wall, before the rain");
  });

  test("an uncaptioned photograph falls back to its file name", () => {
    expect(
      viewerTitle({ caption: "IMG_4913.HEIC", filename: "IMG_4913.HEIC" })
    ).toBe("IMG_4913.HEIC");
    expect(viewerTitle({})).toBe("Photograph");
  });

  test("the date takes the first line and the clock the second, never the position", () => {
    const stamp = captureStamp({
      capturedAt: "2026-07-30T17:42:00Z",
      placeName: "Lyme Regis",
    });
    // The date is a date and nothing else — the clock lives on the second line.
    expect(stamp.date).toContain("2026");
    expect(stamp.date).not.toContain(":");
    expect(stamp.date).not.toContain("Lyme Regis");
    expect(stamp.time).toContain(":");
    expect(stamp.time.endsWith("· Lyme Regis")).toBe(true);
    expect(stamp.time).not.toContain("of");
  });

  test("a photograph with no place stops after the clock — no dangling separator", () => {
    const stamp = captureStamp({ capturedAt: "2026-07-30T17:42:00Z" });
    expect(stamp.time).not.toContain("·");
    expect(stamp.time).toContain(":");
  });

  test("a photograph with no capture time invents nothing", () => {
    // Both lines come back empty, which is the caller's signal to show the
    // photograph's NAME on the first line instead of an empty stamp.
    expect(captureStamp({})).toStrictEqual({ date: "", time: "" });
    expect(captureStamp({ placeName: "Lyme Regis" })).toStrictEqual({
      date: "",
      time: "Lyme Regis",
    });
  });
});

describe("gestures", () => {
  test("every phone gesture has a control that does the same job", () => {
    const gestures = [
      "pinch",
      "double tap",
      // The pan the zoomed readout promises — a gesture the viewer did not
      // have until now, and therefore one that needed an equivalent.
      "drag",
      "swipe left",
      "swipe right",
      "swipe up",
    ];
    for (const gesture of gestures) {
      expect(GESTURE_POINTER_EQUIVALENTS[gesture]).toBeTruthy();
    }
  });
});
