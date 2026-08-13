import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Does this kit actually DRAW every flag the shared contracts let a caller set?
//
// The twin of `packages/client/src/react/ui/blockParity.test.tsx`. Both files
// render the SAME fixtures from `@centraid/design/blocks`; each asserts its own
// marks, because only this kit knows that "destructive" here is a native border
// colour rather than a CSS class.
//
// The contracts stop the two kits DESCRIBING a block differently. They cannot
// stop a kit accepting `dangerous` and drawing the ordinary control — which is
// precisely what happened before #765: this kit took a row verb with nowhere to
// put its `hint`, and forced filled ink on a panel verb every error state
// wanted outlined. Neither was visible while each kit only checked itself
// against fixtures it wrote for itself.
// @vitest-environment jsdom
import {
  BUTTON_FIXTURE,
  CHIPS_FIXTURE,
  EMPTY_ROUTINE_FIXTURE,
  PANEL_COMMIT_FIXTURE,
  PANEL_DANGEROUS_FIXTURE,
  PANEL_FACTS_FIXTURE,
  ROW_ACTION_FIXTURE,
  ROW_FIXTURE,
  ROW_PLAIN_FIXTURE,
  SECTION_FIXTURE,
} from "@centraid/design/blocks";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import Button from "./Button";
import ChipsBlock from "./ChipsBlock";
import EmptyBlock from "./EmptyBlock";
import PanelBlock from "./PanelBlock";
import RowsBlock from "./RowsBlock";
import SectionBlock from "./SectionBlock";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;

describe("block parity — the phone draws every shared flag", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("marks a row that is net, dangerous and off, all at once", () => {
    const el = render(
      <RowsBlock
        rows={[
          {
            ...ROW_FIXTURE,
            action: { ...ROW_ACTION_FIXTURE, onPress: noop },
            key: "r",
          },
        ]}
      />
    );
    const texts = nodesOf(el, "span");
    // The TITLE stays disabled-ink (because `off`), never `net`: a row says
    // "this leaves" with its metadata, not by recolouring its subject.
    expect(styleOf(texts[0]).color).toBe(colors.textDisabled);
    expect(styleOf(texts[1]).color).toBe(colors.net);
    const verb = nodesOf(el, "button")[0];
    expect(verb?.getAttribute("aria-disabled")).toBe("true");
    // The hint is what tells ten identical verbs apart for a screen reader.
    // It is invisible on screen, so nothing but an assertion protects it.
    expect(verb?.dataset.hint).toBe(ROW_ACTION_FIXTURE.hint);
  });

  it("outlines a dangerous verb in net once the row is not also inert", () => {
    // `off` legitimately WINS over `dangerous` on the control above: a disabled
    // destructive button takes the disabled recipe. So the destructive mark is
    // asserted on the same fixture with the inert flag lifted, which keeps both
    // rules honest instead of asserting only the one that happens to show.
    const el = render(
      <RowsBlock
        rows={[
          {
            ...ROW_FIXTURE,
            action: { ...ROW_ACTION_FIXTURE, onPress: noop },
            key: "r",
            off: false,
          },
        ]}
      />
    );
    const verb = nodesOf(el, "button")[0];
    expect(String(styleOf(verb).borderColor).toLowerCase()).toBe(
      colors.net.toLowerCase()
    );
  });

  it("leaves a plain row unmarked, so the marks mean something", () => {
    const el = render(
      <RowsBlock rows={[{ ...ROW_PLAIN_FIXTURE, key: "r" }]} />
    );
    const texts = nodesOf(el, "span");
    expect(styleOf(texts[0]).color).toBe(colors.text);
    expect(styleOf(texts[1]).color).not.toBe(colors.net);
  });

  it("tones only the value of a net fact, and shows the key as the word", () => {
    const el = render(<PanelBlock facts={PANEL_FACTS_FIXTURE} />);
    const texts = nodesOf(el, "span");
    // key, value, key, value — the keys are the DISPLAYED words.
    expect(texts[0]?.textContent).toBe(PANEL_FACTS_FIXTURE[0]?.key);
    expect(styleOf(texts[1]).color).toBe(colors.text);
    expect(texts[2]?.textContent).toBe(PANEL_FACTS_FIXTURE[1]?.key);
    expect(styleOf(texts[3]).color).toBe(colors.net);
  });

  it("fills a panel's commit and outlines a panel's destructive verb", () => {
    const commit = render(
      <PanelBlock action={{ ...PANEL_COMMIT_FIXTURE, onPress: noop }} />
    );
    expect(styleOf(nodesOf(commit, "button")[0]).backgroundColor).toBe(
      colors.accentFill
    );
    dispose?.();
    dispose = undefined;
    const danger = render(
      <PanelBlock action={{ ...PANEL_DANGEROUS_FIXTURE, onPress: noop }} />
    );
    const verb = nodesOf(danger, "button")[0];
    expect(styleOf(verb).backgroundColor).toBe("transparent");
    expect(String(styleOf(verb).borderColor).toLowerCase()).toBe(
      colors.net.toLowerCase()
    );
  });

  it("states a chip's on-ness without spending colour on it", () => {
    const el = render(
      <ChipsBlock
        accessibilityLabel="Filter"
        chips={CHIPS_FIXTURE.map((chip) => ({ ...chip, onPress: noop }))}
      />
    );
    const chips = nodesOf(el, "button");
    expect(chips[0]?.getAttribute("aria-selected")).toBe("true");
    expect(chips[1]?.getAttribute("aria-selected")).toBe("false");
    // The active state is a border and a ground, never a hue.
    expect(styleOf(chips[0]).borderColor).toBe(colors.text);
  });

  it("draws the routine empty state quieter than a first meeting", () => {
    const el = render(<EmptyBlock {...EMPTY_ROUTINE_FIXTURE} />);
    const texts = nodesOf(el, "span");
    expect(texts[0]?.textContent).toBe(EMPTY_ROUTINE_FIXTURE.title);
    expect(texts[1]?.textContent).toBe(EMPTY_ROUTINE_FIXTURE.body);
  });

  it("names a section and its count", () => {
    const el = render(<SectionBlock {...SECTION_FIXTURE} />);
    const texts = nodesOf(el, "span");
    expect(texts[0]?.textContent).toBe(SECTION_FIXTURE.label);
    expect(texts[1]?.textContent).toBe(SECTION_FIXTURE.meta);
  });

  it("disables a button and still draws its icon", () => {
    const el = render(
      <Button {...BUTTON_FIXTURE} label="Re-authorize" onPress={noop} />
    );
    const button = nodesOf(el, "button")[0];
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.textContent).toContain("Re-authorize");
    expect(el.querySelector("[data-glyph]")).not.toBeNull();
  });
});
