// @vitest-environment jsdom
// The album picker, on the Binding Layer (v4 handoff §C, §D, §E, §14, §18).
//
// Behaviour, not implementation: every assertion keys on packed geometry,
// aria state, the global kit control classes and visible copy — never on a
// CSS-module class name, which is hashed at build time and would make this a
// test of the bundler.
//
// The panel is rendered to static markup rather than driven in jsdom, like
// photos-tile: `PickerView` is a pure view over its props (its one piece of
// internal state is the measured grid width, which falls back cleanly where
// there is no layout), so the markup IS the behaviour.
//
// The commit (`submitPicker`) IS driven, because what it does is a sequence of
// writes and a sequence of status-line sentences — the determinate progress
// §14 asks for, and the Undo §3 asks for.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface Asset {
  asset_id: string;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  media_type?: string | null;
  content_uri?: string | null;
  taken_at?: string | null;
}
interface Album {
  album_id: string;
  title?: string | null;
}
interface PickerProps {
  album: Album;
  candidates: Asset[];
  picked: Set<string>;
  busy?: boolean;
  onToggle: (id: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

const { PickerView } = (await import(app("components/Picker.tsx"))) as {
  PickerView: ComponentType<PickerProps>;
};
const { submitPicker } = (await import(app("picker-actions.ts"))) as {
  submitPicker: (
    album: Album,
    ids: string[],
    deps: { refresh: () => Promise<void>; closePicker: () => void }
  ) => Promise<void>;
};
const { setStatusSink, setWriteTargetResolver } = (await import(
  app("outcomes.ts")
)) as {
  setStatusSink: (
    fn: ((note: { text: string; undo?: () => void } | null) => void) | null
  ) => void;
  setWriteTargetResolver: (fn: () => unknown) => void;
};

const photo = (over: Partial<Asset> = {}): Asset => ({
  asset_id: "a1",
  title: "Cove",
  width: 3000,
  height: 2000,
  media_type: "image/jpeg",
  content_uri: "data:image/jpeg;base64,AAAA",
  taken_at: "2026-08-14T10:00:00Z",
  ...over,
});

const album: Album = { album_id: "al1", title: "Coast" };

function picker(over: Partial<PickerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(PickerView, {
      album,
      candidates: [photo()],
      picked: new Set<string>(),
      onToggle: () => {},
      onCancel: () => {},
      onSubmit: () => {},
      ...over,
    })
  );
}

/** Every tile's packed box, in source order. */
function boxes(markup: string): { width: number; height: number }[] {
  return [
    ...markup.matchAll(
      /width:\s*(?<w>\d+(?:\.\d+)?)px;height:\s*(?<h>\d+(?:\.\d+)?)px/gu
    ),
  ].map((m) => ({
    width: Number(m.groups?.w),
    height: Number(m.groups?.h),
  }));
}

describe("the album picker panel", () => {
  it("says which album it is adding to, and what an album is", () => {
    const markup = picker();
    expect(markup).toContain("Add to “Coast”");
    expect(markup).toContain("nothing moves and nothing is copied");
  });

  it("packs justified rows from real aspect ratios, never squares", () => {
    const markup = picker({
      candidates: [
        photo({ asset_id: "wide", width: 3000, height: 2000 }),
        photo({ asset_id: "tall", width: 2000, height: 3000 }),
      ],
    });
    const packed = boxes(markup);
    expect(packed).toHaveLength(2);
    // One row height, two different widths — the landscape is wider than the
    // portrait, which is exactly what a square grid could not express.
    expect(packed[0]!.height).toBe(packed[1]!.height);
    expect(packed[0]!.width).toBeGreaterThan(packed[1]!.width);
    for (const box of packed) expect(box.width).not.toBe(box.height);
  });

  it("gives every tile its geometry before any bytes land", () => {
    // A row with nothing paintable on this device still occupies a packed box
    // and says so on its own state slot — it never collapses (§14).
    const markup = picker({
      candidates: [
        photo({
          asset_id: "gone",
          content_uri: "https://elsewhere.example/o.jpg",
        }),
      ],
    });
    expect(boxes(markup)).toHaveLength(1);
    expect(markup).toContain('data-tile-state="gateway"');
    expect(markup).toContain("on the gateway");
  });

  it("marks a picked tile pressed and labels the control both ways", () => {
    const markup = picker({ picked: new Set(["a1"]) });
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Deselect Cove");
    expect(picker()).toContain("Select Cove");
  });

  it("counts the picks in words that agree with the number", () => {
    expect(picker({ picked: new Set(["a1"]) })).toContain("photograph picked");
    expect(picker()).toContain("photographs picked");
  });

  it("fills Add only when it can fire, and only ever fills one thing", () => {
    const idle = picker();
    expect(idle).not.toContain("kit-btn primary");
    expect(idle).toContain("disabled");

    const ready = picker({ picked: new Set(["a1"]) });
    expect([...ready.matchAll(/kit-btn primary/gu)]).toHaveLength(1);
  });

  it("goes inert while the add runs, keeping the panel's geometry", () => {
    const markup = picker({ picked: new Set(["a1"]), busy: true });
    // Both controls refuse, neither becomes a progress bar or a spinner.
    expect([...markup.matchAll(/disabled/gu)].length).toBeGreaterThanOrEqual(2);
    expect(markup).not.toContain("kit-btn primary");
    expect(boxes(markup)).toHaveLength(1);
  });

  it("is empty on its own terms, and still shows head and foot", () => {
    const markup = picker({ candidates: [] });
    expect(markup).toContain(
      "Everything in your library is already in this album."
    );
    expect(markup).toContain("Add to “Coast”");
    expect(markup).toContain("Cancel");
    expect(boxes(markup)).toHaveLength(0);
  });
});

describe("the album picker commit", () => {
  let said: { text: string; undo?: () => void }[] = [];
  let writes: { action: string; input: Record<string, unknown> }[] = [];

  beforeEach(() => {
    said = [];
    writes = [];
    setStatusSink((note) => {
      if (note) said.push(note);
    });
    setWriteTargetResolver(() => ({
      disabled: false,
      scopeId: "",
      label: "Library",
    }));
    (
      globalThis as unknown as { window: Record<string, unknown> }
    ).window.centraid = {
      write: (cmd: { action: string; input: Record<string, unknown> }) => {
        writes.push(cmd);
        return Promise.resolve({ status: "executed" });
      },
    };
  });

  it("narrates determinate progress with exact counts, then the outcome", async () => {
    let refreshed = 0;
    let closed = 0;
    await submitPicker(album, ["a1", "a2", "a3"], {
      refresh: async () => {
        refreshed += 1;
      },
      closePicker: () => {
        closed += 1;
      },
    });
    const texts = said.map((s) => s.text);
    expect(texts.slice(0, 3)).toStrictEqual([
      "Adding 1 of 3…",
      "Adding 2 of 3…",
      "Adding 3 of 3…",
    ]);
    expect(texts.at(-1)).toBe("Added 3 to “Coast”");
    expect(closed).toBe(1);
    expect(refreshed).toBe(1);
    expect(writes.every((w) => w.action === "add-to-album")).toBe(true);
  });

  it("offers Undo, and undoing removes exactly what landed", async () => {
    await submitPicker(album, ["a1", "a2"], {
      refresh: async () => {},
      closePicker: () => {},
    });
    const outcome = said.at(-1)!;
    expect(outcome.undo).toBeTypeOf("function");
    writes = [];
    outcome.undo!();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(writes.map((w) => w.action)).toStrictEqual([
      "remove-from-album",
      "remove-from-album",
    ]);
    expect(writes.map((w) => w.input.asset_id)).toStrictEqual(["a1", "a2"]);
  });

  it("says why instead of firing a write it knows will be refused", async () => {
    setWriteTargetResolver(() => ({
      disabled: true,
      reason: "You can view Family but not add to it.",
    }));
    let closed = 0;
    await submitPicker(album, ["a1"], {
      refresh: async () => {},
      closePicker: () => {
        closed += 1;
      },
    });
    expect(said.map((s) => s.text)).toStrictEqual([
      "You can view Family but not add to it.",
    ]);
    expect(writes).toHaveLength(0);
    expect(closed).toBe(0);
  });
});
