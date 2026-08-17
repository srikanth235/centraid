import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessCardDTO } from "../screen-contracts.js";
import SettingsEnrichmentScreen from "./SettingsEnrichmentScreen.js";
import type {
  EnrichmentSettingsData,
  SettingsEnrichmentScreenProps,
} from "./SettingsEnrichmentScreen.js";

/*
 * Settings → Enrichment (issue #807). The behaviour that matters is that this
 * page is a PROJECTION: every control writes through the store that owns its
 * path and renders what came back, and the faces capability is refused a
 * delegate rather than merely defaulted away from one.
 */

const CARD: HarnessCardDTO = {
  kind: "codex",
  title: "Codex",
  accent: "#10b981",
  subtitle: "codex 1.2.3",
  connected: true,
  sessionReady: true,
  modelsLoading: false,
  models: [{ id: "gpt-5", name: "GPT-5", default: true }],
};

function makeData(
  over: Partial<EnrichmentSettingsData> = {}
): EnrichmentSettingsData {
  return {
    policy: { photos: "device", docs: "off" },
    rules: [
      {
        scope: { type: "domain", ref: "photos" },
        capability: "ocr",
        enabled: true,
        profile: null,
        trigger: "on-view",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    profiles: [
      {
        id: "built-in",
        label: "Built-in (ocr)",
        capability: "ocr",
        engine: { kind: "built-in" },
        egress: "gateway",
        builtIn: true,
        delegateCapable: true,
      },
      {
        id: "built-in",
        label: "Built-in (faces)",
        capability: "faces",
        engine: { kind: "built-in" },
        egress: "on-device",
        builtIn: true,
        delegateCapable: false,
      },
      {
        id: "sharp-ocr",
        label: "Sharp OCR",
        capability: "ocr",
        engine: { kind: "delegate", harness: "codex" },
        egress: "provider",
        builtIn: false,
        delegateCapable: true,
      },
    ],
    consent: [
      {
        capability: "ocr",
        egress: "provider",
        scopeRef: "",
        decision: "declined",
        decidedAt: new Date().toISOString(),
        receiptId: null,
      },
    ],
    cards: [CARD],
    ...over,
  };
}

function makeProps(
  over: Partial<SettingsEnrichmentScreenProps> = {}
): SettingsEnrichmentScreenProps {
  return {
    load: vi
      .fn<SettingsEnrichmentScreenProps["load"]>()
      .mockResolvedValue(makeData()),
    setTier: vi
      .fn<SettingsEnrichmentScreenProps["setTier"]>()
      .mockResolvedValue({ photos: "gateway", docs: "off" }),
    saveProfile: vi
      .fn<SettingsEnrichmentScreenProps["saveProfile"]>()
      .mockResolvedValue(undefined),
    deleteProfile: vi
      .fn<SettingsEnrichmentScreenProps["deleteProfile"]>()
      .mockResolvedValue(undefined),
    setRule: vi
      .fn<SettingsEnrichmentScreenProps["setRule"]>()
      .mockResolvedValue(undefined),
    deleteRule: vi
      .fn<SettingsEnrichmentScreenProps["deleteRule"]>()
      .mockResolvedValue(undefined),
    showToast: vi.fn<SettingsEnrichmentScreenProps["showToast"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(
  props: SettingsEnrichmentScreenProps
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsEnrichmentScreen {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function control(el: HTMLElement, label: string): HTMLElement {
  const found = el.querySelector(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no control labelled "${label}"`);
  return found as HTMLElement;
}

/** The one button whose visible label is `text`. */
function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button labelled "${text}"`);
  return found;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLSelectElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe(SettingsEnrichmentScreen, () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("renders each domain's standing tier, the engines, the rules and the answers", async () => {
    const el = await mount(makeProps());
    const photos = control(el, "Enrichment for Photos");
    expect(
      photos.querySelector<HTMLElement>('[data-active="true"]')?.dataset.value
    ).toBe("device");
    // A profile states where its work goes, in the phone's words.
    expect(el.textContent).toContain("Sharp OCR");
    expect(el.textContent).toContain("sent to a provider");
    // The stored rule and the recorded answer both render as facts.
    expect(el.textContent).toContain("Text in photos");
    expect(el.textContent).toContain("declined");
  });

  it("renders the tier the vault answered with, not the one that was clicked", async () => {
    const setTier = vi
      .fn<SettingsEnrichmentScreenProps["setTier"]>()
      .mockResolvedValue({ photos: "off", docs: "off" });
    const el = await mount(makeProps({ setTier }));
    const photos = control(el, "Enrichment for Photos");
    const gateway = photos.querySelector<HTMLButtonElement>(
      '[data-value="gateway"]'
    );
    await act(async () => {
      gateway?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(setTier.mock.lastCall).toStrictEqual(["photos", "gateway"]);
    expect(
      photos.querySelector<HTMLElement>('[data-active="true"]')?.dataset.value
    ).toBe("off");
  });

  it("refuses a delegate engine for faces", async () => {
    const el = await mount(makeProps());
    const capability = control(
      el,
      "Capability for the new engine"
    ) as HTMLSelectElement;
    const faces = [...capability.options].find(
      (option) => option.value === "faces"
    );
    expect(faces?.disabled).toBe(true);
    expect(el.textContent).toContain("Faces has no delegate engine");
  });

  it("writes a member engine as a slugged profile with its capability and agent", async () => {
    const saveProfile = vi
      .fn<SettingsEnrichmentScreenProps["saveProfile"]>()
      .mockResolvedValue(undefined);
    const el = await mount(makeProps({ saveProfile }));
    await type(control(el, "New engine name") as HTMLInputElement, "Fast OCR");
    await pick(
      control(el, "Capability for the new engine") as HTMLSelectElement,
      "ocr"
    );
    await pick(
      control(el, "Agent for the new engine") as HTMLSelectElement,
      "codex"
    );
    await act(async () => {
      button(el, "Add engine").click();
    });
    expect(saveProfile.mock.lastCall?.[0]).toStrictEqual({
      id: "fast-ocr",
      label: "Fast OCR",
      capability: "ocr",
      harness: "codex",
    });
  });

  it("says a member engine is inert when its capability ships no delegate variant", async () => {
    const data = makeData();
    const el = await mount(
      makeProps({
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue({
          ...data,
          profiles: [
            ...data.profiles,
            {
              id: "my-embedder",
              label: "My embedder",
              capability: "embed-text",
              engine: { kind: "delegate", harness: "codex" },
              egress: "provider",
              builtIn: false,
              delegateCapable: false,
            },
          ],
        }),
      })
    );

    expect(el.textContent).toContain(
      "No agent engine ships for this capability"
    );
    // And the profile that DOES have one is not labelled inert: the note is a
    // fact about the capability, not decoration on every member engine.
    expect(el.textContent?.match(/No agent engine ships/gu)).toHaveLength(1);
  });

  it("says so when the gateway does not answer", async () => {
    const load = vi
      .fn<SettingsEnrichmentScreenProps["load"]>()
      .mockRejectedValue(new Error("gateway unreachable"));
    const el = await mount(makeProps({ load }));
    expect(el.textContent).toContain("gateway unreachable");
  });
});
