// @vitest-environment jsdom
// The stage: the viewer, the slideshow and the editor (v4 handoff §7.1-§7.4).
//
// Five rules the handoff states as rules, asserted as rules — not as pixel
// snapshots, which would go stale the moment a padding moved:
//
//   1. the stage is `--stage` in BOTH themes, and nothing in these three
//      stylesheets can fork it per theme;
//   2. the spacer beside the flexible title does not flex;
//   3. the actions go icon-only below 840px OF BAR, not below a viewport;
//   4. the zoom readout is exact;
//   5. the editor's `Save as a new photograph` is the ONE filled element, and
//      a disabled commit is not filled.
//
// jsdom rather than the node environment because the app's own modules reach
// the kit (`fmtBytes`, staging) at import time, and the kit is a browser
// module. The components are rendered to STATIC markup all the same: they are
// pure views over their props here, so the markup is the behaviour, and a
// server render keeps the assertions free of act() scheduling noise.
//
// App sources are loaded by file URL, like every other blueprint-app fixture
// in this directory: `src/` is its own tsconfig rootDir, so the types the
// assertions need are declared locally rather than imported across it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType, FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { toBlueprintCss } from "@centraid/design";

const PHOTOS = path.resolve(import.meta.dirname, "../apps/photos");
const app = (rel: string): string => pathToFileURL(path.join(PHOTOS, rel)).href;
const css = (rel: string): string =>
  readFileSync(path.join(PHOTOS, rel), "utf8");

const LIGHTBOX_CSS = css("components/Lightbox.module.css");
const SLIDESHOW_CSS = css("components/Slideshow.module.css");
const EDITOR_CSS = css("components/Editor.module.css");

interface Asset {
  asset_id: string;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  content_uri?: string | null;
  custody_state?: string | null;
  duration_s?: number | null;
  media_type?: string | null;
  kind?: string | null;
  scope_id?: string | null;
}
interface ActionSpec {
  id: string;
  icon: FC<{ size?: number; filled?: boolean }>;
  label?: string;
  onRun?: () => void;
  disabled?: boolean;
  reason?: string;
  destructive?: boolean;
}

const {
  ACTION_LABELS,
  captureLine,
  centredCrop,
  clock,
  FIT,
  LABEL_BREAKPOINT,
  labelsVisible,
  originStatus,
  PHONE_ACTIONS,
  ratioValue,
  SAVE_AS_NEW,
  SAVE_AS_NEW_EXPLANATION,
  scopeMeaning,
  SLIDESHOW_STATUS,
  trackFraction,
  transportKind,
  videoKindLabel,
  VIEWER_ACTIONS,
  zoomIn,
  zoomOut,
  zoomReadout,
} = (await import(app("viewer.ts"))) as {
  ACTION_LABELS: Record<string, string>;
  captureLine: (asset: Asset) => string;
  centredCrop: (
    frameRatio: number,
    ratio: number
  ) => { x: number; y: number; w: number; h: number };
  clock: (seconds: number) => string;
  FIT: number;
  LABEL_BREAKPOINT: number;
  labelsVisible: (barWidth: number) => boolean;
  originStatus: (
    asset: Asset,
    gatewayName: string
  ) => { text: string; action?: string } | null;
  PHONE_ACTIONS: readonly string[];
  ratioValue: (name: string) => number | null;
  SAVE_AS_NEW: string;
  SAVE_AS_NEW_EXPLANATION: string;
  scopeMeaning: (personal: boolean | undefined) => string;
  SLIDESHOW_STATUS: string;
  trackFraction: (elapsed: number, duration: number) => number;
  transportKind: (asset: Asset) => string | null;
  videoKindLabel: (asset: Asset) => string;
  VIEWER_ACTIONS: readonly string[];
  zoomIn: (scale: number) => number;
  zoomOut: (scale: number) => number;
  zoomReadout: (scale: number) => string;
};

const { ViewerStage } = (await import(app("components/ViewerStage.tsx"))) as {
  ViewerStage: ComponentType<{
    asset: Asset;
    hasPrev: boolean;
    hasNext: boolean;
    onStep: (delta: number) => void;
    onDims: (w: number, h: number) => void;
    status: { text: string; action?: string } | null;
    onLoadOriginal: () => void;
  }>;
};

const { ViewerBarActions } = (await import(
  app("components/ViewerActions.tsx")
)) as {
  ViewerBarActions: ComponentType<{
    specs: readonly ActionSpec[];
    labelled: boolean;
  }>;
};

const { EditorView } = (await import(app("components/Editor.tsx"))) as {
  EditorView: ComponentType<{
    asset: Asset;
    onCancel: () => void;
    onSaved: () => void;
    refresh: () => Promise<void>;
  }>;
};

const Mark: FC<{ size?: number; filled?: boolean }> = () =>
  createElement("i", { "aria-hidden": "true" });

/** One declaration block, by class name, comments stripped. */
function rule(source: string, selector: string): string {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const at = stripped.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return stripped.slice(at, stripped.indexOf("}", at));
}

/** `:root` / dark-block declarations of one custom property in the emitted
 *  blueprint CSS — the two values the app actually resolves at runtime. */
function emitted(token: string): { light: string; dark: string } {
  const sheet = toBlueprintCss();
  const darkAt = sheet.indexOf("data-theme='dark'");
  const light = sheet.slice(0, darkAt < 0 ? sheet.length : darkAt);
  const dark = darkAt < 0 ? "" : sheet.slice(darkAt);
  const read = (block: string): string =>
    new RegExp(`${token}\\s*:\\s*(?<value>[^;]+);`, "u")
      .exec(block)
      ?.groups?.value?.trim() ?? "";
  return { light: read(light), dark: read(dark) };
}

describe("the stage stands on --stage, in both themes", () => {
  it("paints the viewer and the slideshow with the shared role, not a literal", () => {
    expect(rule(LIGHTBOX_CSS, ".lightbox")).toContain(
      "background: var(--stage)"
    );
    expect(rule(SLIDESHOW_CSS, ".stage")).toContain("background: var(--stage)");
    // Ink and hairlines come from the same family, so the ground is never
    // paired with page-ramp ink.
    expect(rule(LIGHTBOX_CSS, ".lightbox")).toContain("color: var(--on-stage)");
    expect(rule(SLIDESHOW_CSS, ".stage")).toContain("color: var(--on-stage)");
  });

  it("resolves --stage to the SAME value in light and dark", () => {
    const stage = emitted("--stage");
    expect(stage.light).toBe("#0B0B0B");
    expect(stage.dark).toBe(stage.light);
    const ink = emitted("--on-stage");
    expect(ink.light).toBe("#EDEDEC");
    expect(ink.dark).toBe(ink.light);
    expect(emitted("--stage-line").light).toBe("#2A2A29");
  });

  it("gives the three stage stylesheets no way to fork per theme", () => {
    // A `[data-theme]` or `prefers-color-scheme` selector in any of them would
    // reintroduce exactly the split the shared role exists to remove.
    for (const sheet of [LIGHTBOX_CSS, SLIDESHOW_CSS, EDITOR_CSS]) {
      expect(sheet).not.toContain("data-theme");
      expect(sheet).not.toContain("prefers-color-scheme");
    }
  });

  it("keeps focus visible on the stage, from the token and not from currentColor", () => {
    for (const [sheet, selector] of [
      [LIGHTBOX_CSS, ".lightbox :focus-visible"],
      [SLIDESHOW_CSS, ".stage :focus-visible"],
    ] as const) {
      const ring = rule(sheet, selector);
      expect(ring).toContain("var(--focus-ring-color)");
      // The inner gap opens on the stage, not on `--bg` (paper), which is
      // what the contract's own --focus-ring would have used.
      expect(ring).toContain("var(--stage)");
      expect(ring).not.toContain("currentColor");
    }
  });
});

describe("the top bar's flexible title", () => {
  it("gives the heading the slack and the spacer none of it", () => {
    const heading = rule(LIGHTBOX_CSS, ".heading");
    expect(heading).toContain("flex: 1");
    expect(heading).toContain("min-inline-size: 0");
    // THE RULE: a growable spacer beside a `flex: 1` heading splits the slack
    // with it, and the title then truncates with empty space beside it.
    const spacer = rule(LIGHTBOX_CSS, ".spacer");
    expect(spacer).toContain("flex: none");
    expect(spacer).not.toMatch(/flex:\s*1/u);
  });

  it("clamps the title and the capture line rather than clipping them", () => {
    for (const selector of [".title", ".captureLine"]) {
      expect(rule(LIGHTBOX_CSS, selector)).toContain("line-clamp: 1");
    }
  });
});

describe("labels are a function of bar width, not of surface", () => {
  // The copy action's caption is per-destination (issue #726): the caller
  // resolves the sole other writable scope and hands `Copy to ⟨label⟩` in.
  const specs: ActionSpec[] = [
    { id: "favorite", icon: Mark },
    { id: "copy", icon: Mark, label: "Copy to Family" },
  ];
  const bar = (labelled: boolean): string =>
    renderToStaticMarkup(createElement(ViewerBarActions, { specs, labelled }));

  it("draws labels at 840px of bar and none at 839", () => {
    expect(LABEL_BREAKPOINT).toBe(840);
    expect(labelsVisible(840)).toBe(true);
    expect(labelsVisible(1420)).toBe(true);
    expect(labelsVisible(839)).toBe(false);
    expect(labelsVisible(390)).toBe(false);
    // Zero is "not measured yet"; an unmeasured bar starts icon-only rather
    // than flashing six labels and taking them away.
    expect(labelsVisible(0)).toBe(false);
  });

  it("carries the label as text above the breakpoint", () => {
    const html = bar(true);
    expect(html).toContain(ACTION_LABELS.favorite);
    expect(html).toContain("Copy to Family");
  });

  it("keeps every icon-only control named below it", () => {
    const html = bar(false);
    // No visible text at all…
    expect(html).not.toContain(">Copy to Family<");
    // …but both names still reach a screen reader AND a hovering pointer.
    expect(html).toContain('aria-label="Copy to Family"');
    expect(html).toContain('title="Copy to Family"');
    expect([...html.matchAll(/aria-label="/gu)]).toHaveLength(2);
    expect([...html.matchAll(/title="/gu)]).toHaveLength(2);
  });

  it("states the reason a disabled action cannot fire, on the control", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerBarActions, {
        labelled: true,
        specs: [
          {
            id: "favorite",
            icon: Mark,
            disabled: true,
            reason: "This library is read-only for you.",
          },
        ],
      })
    );
    expect(html).toContain('title="This library is read-only for you."');
    expect(html).toContain("disabled");
  });

  it("names the copy action as a destination, never as a bare verb (#726)", () => {
    // The resting caption; Lightbox overrides it with `Copy to ⟨label⟩` when
    // exactly one other writable scope is mounted (sharing.ts).
    expect(ACTION_LABELS.copy).toBe("Copy to another place");
    expect(VIEWER_ACTIONS).toStrictEqual([
      "favorite",
      "edit",
      "info",
      "copy",
      "download",
      "slideshow",
    ]);
    expect(PHONE_ACTIONS).toStrictEqual([
      "copy",
      "favorite",
      "info",
      "edit",
      "trash",
    ]);
  });
});

describe("zoom", () => {
  it("reads out the exact factor, and names the gesture", () => {
    expect(zoomReadout(2.4)).toBe("240% · drag to pan");
    expect(zoomReadout(1.5)).toBe("150% · drag to pan");
    expect(zoomReadout(4)).toBe("400% · drag to pan");
  });

  it("walks a ladder that always terminates", () => {
    expect(zoomIn(FIT)).toBe(1.5);
    expect(zoomIn(2)).toBe(2.4);
    expect(zoomIn(4)).toBe(4);
    expect(zoomOut(1.5)).toBe(FIT);
    expect(zoomOut(FIT)).toBe(FIT);
  });

  it("drops the maxima and clips the wrap only while zoomed", () => {
    expect(rule(LIGHTBOX_CSS, ".media")).toContain("max-inline-size: 100%");
    expect(rule(LIGHTBOX_CSS, ".media")).toContain("max-block-size: 100%");
    expect(rule(LIGHTBOX_CSS, ".zoomed")).toContain("max-inline-size: none");
    expect(rule(LIGHTBOX_CSS, ".zoomed")).toContain("max-block-size: none");
    expect(rule(LIGHTBOX_CSS, ".clipping")).toContain("overflow: hidden");
  });

  it("keeps the readout in the numeric register", () => {
    const readout = rule(LIGHTBOX_CSS, ".zoomReadout");
    expect(readout).toContain("font: var(--t-mono)");
    expect(readout).toContain("var(--t-mono-numeric)");
  });
});

describe("the editor's commit", () => {
  const asset: Asset = {
    asset_id: "a1",
    title: "Lyme Regis",
    width: 4000,
    height: 3000,
    content_uri: "data:image/png;base64,iVBORw0KGgo=",
  };
  const html = renderToStaticMarkup(
    createElement(EditorView, {
      asset,
      onCancel: () => {},
      onSaved: () => {},
      refresh: async () => {},
    })
  );

  it("is worded as what it does, and explains itself at the point of decision", () => {
    expect(SAVE_AS_NEW).toBe("Save as a new photograph");
    expect(html).toContain(SAVE_AS_NEW);
    expect(html).toContain(SAVE_AS_NEW_EXPLANATION);
    // BESIDE the control, not in a confirmation afterwards — and now in the
    // SAME wrapping bar as the tools (proto 4617-4630), with the explanation
    // between the tools and the commit, so the sentence is the last thing read
    // before the press. Cancel stands before Save (proto 2891-2906).
    expect(html.indexOf(SAVE_AS_NEW_EXPLANATION)).toBeLessThan(
      html.indexOf(SAVE_AS_NEW)
    );
    expect(html.indexOf("Rotate 90°")).toBeLessThan(
      html.indexOf(SAVE_AS_NEW_EXPLANATION)
    );
    expect(html.indexOf(">Cancel<")).toBeLessThan(html.indexOf(SAVE_AS_NEW));
  });

  it("is the ONE element in the view that carries the filled class", () => {
    // Find the class the commit wears, then count every element wearing it.
    const before = html.slice(0, html.indexOf(SAVE_AS_NEW));
    const commitClass = [...before.matchAll(/class="(?<name>[^"]+)"/gu)].at(-1)
      ?.groups?.name;
    expect(commitClass).toBeTruthy();
    expect([
      ...html.matchAll(new RegExp(`class="${commitClass}"`, "gu")),
    ]).toHaveLength(1);
  });

  it("fills exactly one class in the stylesheet, and never a disabled one", () => {
    const filled = [
      ...EDITOR_CSS.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(
        /background:\s*var\(--on-stage\)/gu
      ),
    ];
    expect(filled).toHaveLength(1);
    expect(rule(EDITOR_CSS, ".commit")).toContain(
      "background: var(--on-stage)"
    );
    // A DISABLED COMMIT IS NOT FILLED (§18).
    expect(rule(EDITOR_CSS, ".commit:disabled")).toContain(
      "background: transparent"
    );
  });

  it("offers crop and rotate only, in the handoff's words", () => {
    for (const label of [
      "Crop",
      "Rotate 90°",
      "Straighten −1°",
      "Original",
      "Square",
      // Spaced, and in the mono face, exactly as the handoff writes it
      // (proto 4621, 4624).
      "3 : 2",
      "Reset",
    ]) {
      expect(html).toContain(label);
    }
    // Nothing that would touch the original's bytes, and nothing that trashes
    // it in the same gesture as the save.
    expect(html).not.toContain("trash");
  });

  it("snaps a named ratio to the largest centred crop that fits", () => {
    expect(ratioValue("Original")).toBeNull();
    expect(ratioValue("Square")).toBe(1);
    expect(ratioValue("3:2")).toBe(1.5);
    // A square out of a 2:1 frame takes the full height and half the width.
    expect(centredCrop(2, 1)).toStrictEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    // …and out of a 1:2 frame, the full width and half the height.
    expect(centredCrop(0.5, 1)).toStrictEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
  });
});

describe("what the stage says about the bytes", () => {
  it("offers the original as an explicit choice, never as a background fetch", () => {
    const status = originStatus(
      { asset_id: "a", custody_state: "remote-only" },
      "home-gateway"
    );
    expect(status?.text).toBe(
      "Original on home-gateway · a full-quality copy has not been fetched"
    );
    expect(status?.action).toBe("Load the original");
  });

  it("says nothing about a photograph whose bytes are already here", () => {
    expect(
      originStatus(
        { asset_id: "a", custody_state: "replicated", content_uri: "data:," },
        "home-gateway"
      )
    ).toBeNull();
  });

  it("tells the slideshow's member what leaving costs them", () => {
    expect(SLIDESHOW_STATUS).toBe(
      "Esc leaves · the viewer keeps the photograph you stopped on"
    );
  });
});

describe("the transport, one slot and three variants", () => {
  it("names each kind from the record, never from a filename", () => {
    expect(transportKind({ asset_id: "a", media_type: "video/mp4" })).toBe(
      "video"
    );
    expect(transportKind({ asset_id: "a", media_type: "audio/mpeg" })).toBe(
      "audio"
    );
    expect(transportKind({ asset_id: "a", kind: "live" })).toBe("live");
    expect(
      transportKind({ asset_id: "a", media_type: "image/jpeg" })
    ).toBeNull();
  });

  it("keeps the track determinate and inside its own bounds", () => {
    expect(clock(8)).toBe("0:08");
    expect(clock(24)).toBe("0:24");
    expect(trackFraction(0, 0)).toBe(0);
    expect(trackFraction(12, 24)).toBe(0.5);
    expect(trackFraction(99, 24)).toBe(1);
  });
});

describe("what the info panel says a photograph's place means", () => {
  it("derives the consequence from the record, never from a name", () => {
    expect(scopeMeaning(true)).toBe(
      "reachable by nothing. Copy it somewhere shared to let someone see it."
    );
    // There are two consequences, not three: where a share GOES is a pointer
    // the member owns, never a third kind of place, so a photograph sitting
    // in the destination reads like a photograph in any other shared place.
    expect(scopeMeaning(false)).toContain("stops being shared");
    // A solo mount says nothing, and the member's-own meaning is the truthful
    // default there — one library is reachable by nothing.
    expect(scopeMeaning(undefined)).toBe(scopeMeaning(true));
  });

  it("says nothing when a photograph carries no capture time", () => {
    expect(captureLine({ asset_id: "a" })).toBe("");
    expect(captureLine({ asset_id: "a", title: "x" })).toBe("");
  });
});

describe("video playback is honest, not double-transported", () => {
  const video: Asset = {
    asset_id: "v1",
    title: "Ana on the sea wall",
    width: 3840,
    height: 2160,
    duration_s: 24,
    content_uri: "data:video/mp4;base64,AAAA",
    media_type: "video/mp4",
    custody_state: "replicated",
  };

  it("composes the kind label from the record: kind, resolution, duration", () => {
    expect(videoKindLabel(video)).toBe("video · 4K · 0:24");
  });

  it("omits a field the record does not carry, rather than inventing one", () => {
    expect(videoKindLabel({ ...video, height: null })).toBe("video · 0:24");
    expect(videoKindLabel({ ...video, duration_s: null })).toBe("video · 4K");
    expect(videoKindLabel({ ...video, height: null, duration_s: null })).toBe(
      "video"
    );
  });

  it("names the video status line ahead of the custody story", () => {
    // Video takes precedence even over remote-only custody: the native
    // transport is already streaming the display copy, which is what is
    // actually true on screen right now.
    expect(originStatus(video, "home-gateway")?.text).toBe(
      "Video · playing from the display copy on this device"
    );
    expect(
      originStatus({ ...video, custody_state: "remote-only" }, "home-gateway")
        ?.text
    ).toBe("Video · playing from the display copy on this device");
    expect(originStatus(video, "home-gateway")?.action).toBeUndefined();
  });

  it("renders exactly ONE transport in the video DOM: the native <video controls>", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerStage, {
        asset: video,
        hasPrev: false,
        hasNext: false,
        onStep: () => {},
        onDims: () => {},
        status: originStatus(video, "home-gateway"),
        onLoadOriginal: () => {},
      })
    );
    // The platform transport: exactly one <video>, carrying `controls`.
    const videoTags = [...html.matchAll(/<video\b[^>]*>/gu)];
    expect(videoTags).toHaveLength(1);
    expect(videoTags[0]?.[0]).toContain("controls");
    // No hand-rolled second transport riding along beside it — no play
    // button and no determinate `<progress>` track over the native
    // scrubber, for video specifically.
    expect(html).not.toContain('aria-label="Play"');
    expect(html).not.toContain("<progress");
    // The kind label still reaches the member, composed from the record.
    expect(html).toContain("video · 4K · 0:24");
  });

  it("still gives audio its own transport — only video lost the hand-rolled one", () => {
    const audio: Asset = {
      asset_id: "a1",
      duration_s: 8,
      content_uri: "data:audio/mpeg;base64,AAAA",
      media_type: "audio/mpeg",
    };
    const html = renderToStaticMarkup(
      createElement(ViewerStage, {
        asset: audio,
        hasPrev: false,
        hasNext: false,
        onStep: () => {},
        onDims: () => {},
        status: null,
        onLoadOriginal: () => {},
      })
    );
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain("<progress");
  });
});
