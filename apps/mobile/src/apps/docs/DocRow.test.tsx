// The document row renders AT MOST ONE state (#821, handoff Part 2 §"The
// document row") — asserted against the rendered tree, not just the ladder.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import DocRow from "./DocRow";
import type { MobileDriveDoc } from "./docs-projection";

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

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;

function doc(overrides: Partial<MobileDriveDoc> = {}): MobileDriveDoc {
  return {
    document_id: "doc-1",
    content_id: "content-1",
    title: "Lease — 14 Sitwell Road.pdf",
    media_type: "application/pdf",
    byte_size: 120_000,
    poster_uri: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    folder_id: null,
    starred: false,
    trashed: false,
    purge_at: null,
    tags: [],
    custody_state: null,
    shared_with: null,
    folderGone: false,
    ...overrides,
  };
}

const texts = (container: HTMLElement): string[] =>
  nodesOf(container, "span").map((node) => node.textContent ?? "");

describe(DocRow, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("renders the title, no state, and the named ··· on an ordinary row", () => {
    const container = render(
      <DocRow doc={doc()} offline={false} onOpen={noop} onMenu={noop} />
    );
    expect(texts(container)).toContain("Lease — 14 Sitwell Road.pdf");
    expect(texts(container)).not.toContain("cannot be shown");
    expect(
      container.querySelector(
        '[aria-label="More for Lease — 14 Sitwell Road.pdf"]'
      )
    ).not.toBeNull();
  });

  it("renders exactly ONE state — 'cannot be shown' wins over the device mark", () => {
    const container = render(
      <DocRow
        doc={doc({
          media_type: "application/vnd.ms-excel",
          custody_state: "local-only",
        })}
        offline={false}
        onOpen={noop}
        onMenu={noop}
      />
    );
    expect(texts(container)).toContain("cannot be shown");
    // The custody glyph must NOT also render — two states in one row is a bug.
    expect(
      container.querySelector('[aria-label="on this device only"]')
    ).toBeNull();
  });

  it("renders the device mark as a glyph with an accessible name, never a sentence", () => {
    const container = render(
      <DocRow
        doc={doc({ custody_state: "local-only" })}
        offline={false}
        onOpen={noop}
        onMenu={noop}
      />
    );
    expect(
      container.querySelector('[aria-label="on this device only"]')
    ).not.toBeNull();
    expect(texts(container)).not.toContain("on this device only");
  });

  it("carries the matched passage as a second line on a search hit", () => {
    const container = render(
      <DocRow
        doc={doc()}
        offline={false}
        snippet="…this tenancy shall end on the twelfth day…"
        onOpen={noop}
        onMenu={noop}
      />
    );
    expect(texts(container)).toContain(
      "…this tenancy shall end on the twelfth day…"
    );
  });
});
