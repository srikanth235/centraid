import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AppEnrichmentSurface from "./AppEnrichmentSurface.js";
import type { AppEnrichmentSurfaceProps } from "./AppEnrichmentSurface.js";

/*
 * The app popover's Enrichment surface (issue #807). It is a projection: every
 * line is the gateway's effective answer, the deep link is the only route to a
 * change, and the one-shot states plainly when nothing can enqueue it.
 */

function makeProps(
  over: Partial<AppEnrichmentSurfaceProps> = {}
): AppEnrichmentSurfaceProps {
  return {
    load: vi.fn<AppEnrichmentSurfaceProps["load"]>().mockResolvedValue([
      {
        capability: "ocr",
        effective: {
          capability: "ocr",
          enabled: true,
          profileId: "sharp-ocr",
          trigger: "on-view",
          egressCeiling: "provider",
        },
        profile: {
          id: "sharp-ocr",
          label: "Sharp OCR",
          capability: "ocr",
          engine: { kind: "delegate", harness: "codex" },
          egress: "provider",
          builtIn: false,
        },
      },
      { capability: "faces", effective: null, profile: undefined },
    ]),
    loadProfiles: vi
      .fn<AppEnrichmentSurfaceProps["loadProfiles"]>()
      .mockResolvedValue([
        {
          id: "sharp-ocr",
          label: "Sharp OCR",
          capability: "ocr",
          engine: { kind: "delegate", harness: "codex" },
          egress: "provider",
          builtIn: false,
        },
      ]),
    onOpenSettings: vi.fn<AppEnrichmentSurfaceProps["onOpenSettings"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(
  props: AppEnrichmentSurfaceProps
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AppEnrichmentSurface {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe(AppEnrichmentSurface, () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("states the effective answer per capability, in the phone's words", async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain("Sharp OCR · sent to a provider");
    expect(el.textContent).toContain("when you open an item");
    // Fail-closed is reported as such, never as "off by default".
    expect(el.textContent).toContain("No policy your gateway can honour");
  });

  it("offers the one-shot picker only when something can enqueue it", async () => {
    const el = await mount(makeProps());
    const picker = el.querySelector<HTMLSelectElement>(
      '[aria-label="Engine for a one-off run"]'
    );
    expect(picker?.disabled).toBe(true);
    expect(el.textContent).toContain("One-off runs aren’t wired");

    const onEnrichOnce = vi.fn<(profile: { id: string }) => void>();
    act(() => root?.unmount());
    container?.remove();
    const wired = await mount(makeProps({ onEnrichOnce }));
    expect(
      wired.querySelector<HTMLSelectElement>(
        '[aria-label="Engine for a one-off run"]'
      )?.disabled
    ).toBe(false);
  });

  it("sends the picked profile once, and nothing else", async () => {
    const onEnrichOnce = vi.fn<(profile: { id: string }) => void>();
    const el = await mount(makeProps({ onEnrichOnce }));
    const picker = el.querySelector<HTMLSelectElement>(
      '[aria-label="Engine for a one-off run"]'
    ) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLSelectElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setter?.call(picker, "ocr/sharp-ocr");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.trim() === "Run once")
        ?.click();
    });
    expect(onEnrichOnce.mock.lastCall?.[0]?.id).toBe("sharp-ocr");
  });

  it("deep-links to the page where the policy is authored", async () => {
    // A counter rather than a spy: the outcome under test is that the deep
    // link fires exactly once, not that a mock was called.
    let opened = 0;
    const el = await mount(
      makeProps({
        onOpenSettings: () => {
          opened += 1;
        },
      })
    );
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((candidate) =>
          candidate.textContent?.includes("Open Enrichment settings")
        )
        ?.click();
    });
    expect(opened).toBe(1);
  });
});
