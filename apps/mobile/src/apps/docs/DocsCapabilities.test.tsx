// What Docs may read (#821, spec §12), asserted against the rendered tree:
// four capabilities, four separate consents, ALL off, the switch withheld
// with the withholding said out loud, and the status sentence built from the
// real on-count (zero on this wave — there is no consent record to read).
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DCAPS } from "@centraid/blueprints/apps/docs/capabilities";

import type { DocsScreenProps } from "../../navigation";
import { mountBlock, nodesOf } from "../../test/react-native-stub";
import { CAPABILITY_SWITCH_WITHHELD, capabilitiesStatus } from "./docs-copy";
import DocsCapabilities from "./DocsCapabilities";

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
// The shell and the head need a navigation tree; this test is about the
// screen's own honesty, so both collapse to their content.
vi.mock(import("./DocsScreen"), () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock(import("./DocsShelfHeader"), () => ({
  default: () => <></>,
}));

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const texts = (container: HTMLElement): string[] =>
  nodesOf(container, "span").map((node) => node.textContent ?? "");

function props(): DocsScreenProps<"DocsCapabilities"> {
  return {
    navigation: { navigate: vi.fn<() => void>() },
    route: { key: "k", name: "DocsCapabilities", params: undefined },
  } as unknown as DocsScreenProps<"DocsCapabilities">;
}

describe(DocsCapabilities, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("renders all four capabilities, each Off, each with what-leaves = nothing", () => {
    const container = render(<DocsCapabilities {...props()} />);
    const rendered = texts(container);
    for (const capability of DCAPS) {
      expect(rendered).toContain(capability.name);
      expect(rendered).toContain(capability.writes);
    }
    expect(rendered.filter((text) => text === "Off")).toHaveLength(4);
    expect(rendered.filter((text) => text === "nothing")).toHaveLength(4);
    expect(rendered).not.toContain("On");
  });

  it("states the withheld switch and the real-count status line", () => {
    const container = render(<DocsCapabilities {...props()} />);
    const rendered = texts(container);
    expect(rendered).toContain(CAPABILITY_SWITCH_WITHHELD);
    expect(rendered).toContain(capabilitiesStatus(0));
    expect(capabilitiesStatus(0)).toBe(
      "Nothing is running · each capability is a separate consent"
    );
  });
});
