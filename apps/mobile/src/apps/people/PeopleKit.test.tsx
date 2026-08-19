// Does the People row actually DRAW the link ring and the consequence meta?
//
// The same harness as `kit/components/blockParity.test.tsx`: the shared
// react-native stub, the REAL lowered theme tokens, style read back off the
// serialized `data-style`. The ring is invisible to a type checker — only an
// assertion protects "solid ink where linked, dashed line where not, NOTHING
// where the sharing plane could not be read".
// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTheme } from "../../kit/theme";
import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import { PersonAvatar, PersonRow, StarButton } from "./PeopleKit";

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

const ana = { party_id: "p1", name: "Ana Whitcombe", avatar_color: null };

/** The ring wrapper is the avatar's outermost View. */
function ringStyle(el: HTMLElement): Record<string, unknown> {
  return styleOf(nodesOf(el, "div")[0]);
}

describe("[law:people-link-ring] the avatar ring states the link, and only the link", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("draws a solid ink ring where linked", () => {
    const el = render(<PersonAvatar person={ana} link="linked" />);
    const ring = ringStyle(el);
    expect(ring.borderColor).toBe(colors.text);
    expect(ring.borderStyle).toBe("solid");
  });

  it("draws a dashed line-colour ring where unlinked", () => {
    const el = render(<PersonAvatar person={ana} link="unlinked" />);
    const ring = ringStyle(el);
    expect(ring.borderColor).toBe(colors.line);
    expect(ring.borderStyle).toBe("dashed");
  });

  it("draws NOTHING where the sharing plane could not be read — and keeps the box", () => {
    const unknown = render(<PersonAvatar person={ana} link="unknown" />);
    const linked = render(<PersonAvatar person={ana} link="linked" />);
    const ring = ringStyle(unknown);
    expect(ring.borderColor).toBe("transparent");
    // The outer rectangle is identical in every state, so a row cannot
    // reflow when the link facts arrive.
    expect(ring.width).toBe(ringStyle(linked).width);
    expect(ring.height).toBe(ringStyle(linked).height);
  });

  it("keeps the row avatar box at 34 with the ring outside it", () => {
    const el = render(<PersonAvatar person={ana} link="linked" />);
    const disc = styleOf(nodesOf(el, "div")[1]);
    expect(disc.width).toBe(34);
    expect(disc.height).toBe(34);
  });
});

describe("[law:people-row-marks] the row's meta takes net only as a consequence", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("colours an overdue meta net and an ordinary one faint", () => {
    const overdue = render(
      <PersonRow name="Ana" meta="41 days" metaNet last />
    );
    const spans = nodesOf(overdue, "span");
    const meta = spans.find((node) => node.textContent === "41 days");
    expect(styleOf(meta).color).toBe(colors.net);

    const plain = render(<PersonRow name="Ana" meta="Today" last />);
    const plainMeta = nodesOf(plain, "span").find(
      (node) => node.textContent === "Today"
    );
    expect(styleOf(plainMeta).color).toBe(colors.textFaint);
  });

  it("names the open action after its person", () => {
    const el = render(<PersonRow name="Ana" onOpen={() => undefined} last />);
    const button = nodesOf(el, "button")[0];
    expect(button?.getAttribute("aria-label")).toBe("Open Ana");
  });
});

describe("[law:people-star-a11y] the star names its object and its direction", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("labels Star/Unstar and reports presses", () => {
    let toggled = 0;
    const el = render(
      <StarButton name="Ana" starred={false} onToggle={() => (toggled += 1)} />
    );
    const button = nodesOf(el, "button")[0];
    expect(button?.getAttribute("aria-label")).toBe("Star Ana");
    press(button);
    expect(toggled).toBe(1);

    const on = render(
      <StarButton name="Ana" starred onToggle={() => undefined} />
    );
    expect(nodesOf(on, "button")[0]?.getAttribute("aria-label")).toBe(
      "Unstar Ana"
    );
  });
});
