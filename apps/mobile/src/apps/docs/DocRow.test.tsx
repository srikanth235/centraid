// The document row renders AT MOST ONE state (#821, handoff Part 2 §"The
// document row") — asserted against the rendered tree, not just the ladder.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachPendingSidecar,
  enrichPendingSidecar,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingOverlayFacts } from "@centraid/blueprints/apps/_shared/pending-overlay";

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

/** A row as a read hands it over: the ONE pending column plus that read's
 *  sidecar, optionally moved on by what a later source knows (#922 G3). */
function pendingRow(
  intentId: string,
  facts: PendingOverlayFacts,
  enrichments: Parameters<typeof enrichPendingSidecar>[1] = []
): Record<string, unknown> {
  return attachPendingSidecar(
    { __centraid_pending_key: intentId },
    enrichPendingSidecar({ [intentId]: facts }, enrichments)
  );
}

function doc(overrides: Partial<MobileDriveDoc> = {}): MobileDriveDoc {
  return {
    document_id: "doc-1",
    content_id: "content-1",
    title: "Lease — 14 Sitwell Road.pdf",
    media_type: "application/pdf",
    byte_size: 120_000,
    poster_uri: null,
    shared_from: null,
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
    canWrite: true,
    scopeLabels: ["Home"],
    raw: {},
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

  // Stub tier: this owns the PROP and the absence of the sentence. Whether
  // React Native publishes an accessibility node from that label is
  // `DocsHome.test.tsx`'s claim, on the real tree (#890 W5).
  it("hands the device mark an accessibilityLabel and draws no sentence", () => {
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

  it("carries the lead line — a matched passage — in place of the facts", () => {
    const container = render(
      <DocRow
        doc={doc()}
        offline={false}
        reason="…this tenancy shall end on the twelfth day…"
        onOpen={noop}
        onMenu={noop}
      />
    );
    expect(texts(container)).toContain(
      "…this tenancy shall end on the twelfth day…"
    );
  });

  it("says nothing about a pending change on a settled row", () => {
    const container = render(
      <DocRow doc={doc()} offline={false} onOpen={noop} onMenu={noop} />
    );
    expect(
      texts(container).some((text) => text.startsWith("Pending change:"))
    ).toBe(false);
  });

  it("names the connection a queued row is waiting for", () => {
    const queued = pendingRow("intent-1", {
      status: "queued",
      action: "rename",
    });
    const container = render(
      <DocRow
        doc={doc({ raw: queued })}
        offline={false}
        onOpen={noop}
        onMenu={noop}
      />
    );
    expect(texts(container)).toContain(
      "Pending change: Waiting for a connection."
    );
  });

  it("names the STEWARD a parked row is waiting for, not a generic hold", () => {
    const parked = pendingRow(
      "intent-2",
      { status: "queued", action: "trash" },
      [{ intentId: "intent-2", status: "parked", stewardLabel: "Ravi" }]
    );
    const container = render(
      <DocRow
        doc={doc({ raw: parked })}
        offline={false}
        onOpen={noop}
        onMenu={noop}
      />
    );
    expect(texts(container)).toContain("Pending change: Waiting for Ravi.");
  });
});
