// Settings → Enrichment, rendered (#807). Three states and one law.
//
// What this pins is what a future edit is likeliest to undo quietly:
//
//  - the section is READ-ONLY: it renders no button, switch or text field, so
//    a later "just one toggle" has to delete a test rather than add a control
//  - a capability's line names its engine profile and WHERE the work happens,
//    in member-facing words, never the registry's contract ids
//  - `effective: null` — the gateway's fail-closed answer — is reported as
//    such and never dressed up as an ordinary "off"
//  - an unreachable gateway yields an unavailable state carrying the real
//    reason, with NO policy rows: the phone keeps no copy of the policy
//    (docs/mobile-offline.md), so there is nothing honest to show
//  - the wire asks the one resolver per capability and lists profiles; both
//    calls are GETs, which is the read-only rule at the transport
//
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOBILE_ENRICH_CAPABILITIES,
  readEnrichmentPolicy,
} from "../../lib/enrichment";
import type { EnrichCapabilityState } from "../../lib/enrichment";
import { mountBlock, nodesOf } from "../../test/react-native-stub";
import EnrichmentSection from "./EnrichmentSection";

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

// The wire's own test half: the transport is mocked at `lib/gateway`, so the
// endpoints and methods below are the real ones `readEnrichmentPolicy` builds.
const wire = vi.hoisted(() => ({
  fetchJson: vi.fn<(href: string, init?: RequestInit) => Promise<unknown>>(),
}));
vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      apiHeaders: () => ({ "x-centraid-vault": "v1" }),
      authHeader: () => ({}),
      fetchJson: wire.fetchJson,
      requireGatewayBase: () => Promise.resolve("http://127.0.0.1:7777"),
    }) as unknown as typeof import("../../lib/gateway")
);

let dispose: (() => void) | undefined;

/** Let the mount effect's read — and the render it schedules — finish. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function render(
  read: () => Promise<EnrichCapabilityState[]>
): Promise<HTMLElement> {
  const mounted = mountBlock(<EnrichmentSection read={read} />);
  dispose = mounted.unmount;
  await settle();
  return mounted.container;
}

function textOf(container: HTMLElement): string {
  return nodesOf(container, "span")
    .map((node) => node.textContent ?? "")
    .join(" | ");
}

function state(
  over: Partial<EnrichCapabilityState> = {}
): EnrichCapabilityState {
  return {
    capability: "ocr",
    domain: "photos",
    effective: {
      capability: "ocr",
      egressCeiling: "gateway",
      enabled: true,
      profileId: "built-in",
      trigger: "on-ingest",
    },
    profile: {
      builtIn: true,
      capability: "ocr",
      egress: "on-device",
      id: "built-in",
      label: "Built-in",
    },
    ...over,
  };
}

describe(EnrichmentSection, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("names the engine and where its work happens, in the member's words", async () => {
    const container = await render(() => Promise.resolve([state()]));
    const text = textOf(container);
    expect(text).toContain("Text in photos");
    expect(text).toContain("Built-in · on this device · as items arrive");
    // The contract id is a key, not copy.
    expect(text).not.toContain("ocr ");
  });

  it("says a provider is a provider", async () => {
    const container = await render(() =>
      Promise.resolve([
        state({
          profile: {
            builtIn: false,
            capability: "ocr",
            egress: "provider",
            id: "careful-ocr",
            label: "Careful OCR",
          },
        }),
      ])
    );
    expect(textOf(container)).toContain("Careful OCR · sent to a provider");
  });

  it("reports a disabled capability as off, and a fail-closed one as unhonourable", async () => {
    const container = await render(() =>
      Promise.resolve([
        state({
          effective: {
            capability: "ocr",
            egressCeiling: "off",
            enabled: false,
            profileId: "built-in",
            trigger: "on-ingest",
          },
        }),
        state({ capability: "faces", effective: null, profile: undefined }),
      ])
    );
    const text = textOf(container);
    expect(text).toContain("Off");
    expect(text).toContain("No policy your gateway can honour");
  });

  it("says the gateway is unreachable rather than showing a policy", async () => {
    const container = await render(() =>
      Promise.reject(new Error("Could not reach the gateway: offline"))
    );
    const text = textOf(container);
    expect(text).toContain("Could not reach the gateway: offline");
    expect(text).toContain("this phone does not keep its own copy");
    expect(text).not.toContain("Text in photos");
  });

  // READ ONLY. Editing the cascade is a desktop act in this wave; nothing on
  // this section may accept a press or a keystroke.
  it("renders no control at all", async () => {
    const container = await render(() => Promise.resolve([state()]));
    expect(nodesOf(container, "button")).toHaveLength(0);
    expect(nodesOf(container, "input")).toHaveLength(0);
  });

  it("asks the one resolver per capability, and only ever GETs", async () => {
    wire.fetchJson.mockImplementation((href: string) =>
      Promise.resolve(
        href.includes("/_enrich/profiles")
          ? { profiles: [] }
          : { effective: null }
      )
    );
    const states = await readEnrichmentPolicy();
    const asked = wire.fetchJson.mock.calls.map(([href]) => href);
    expect(asked).toContain("http://127.0.0.1:7777/centraid/_enrich/profiles");
    for (const capability of MOBILE_ENRICH_CAPABILITIES.photos) {
      expect(asked).toContain(
        `http://127.0.0.1:7777/centraid/_vault/enrich/effective?capability=${encodeURIComponent(capability)}&domain=photos`
      );
    }
    for (const [, init] of wire.fetchJson.mock.calls)
      expect(init?.method).toBe("GET");
    expect(states).toHaveLength(
      MOBILE_ENRICH_CAPABILITIES.photos.length +
        MOBILE_ENRICH_CAPABILITIES.docs.length
    );
  });
});
