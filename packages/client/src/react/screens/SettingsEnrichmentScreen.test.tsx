import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnrichPolicy } from "../../enrich-policy.js";
import type { HarnessCardDTO } from "../screen-contracts.js";
import SettingsEnrichmentScreen from "./SettingsEnrichmentScreen.js";
import type {
  EnrichmentSettingsData,
  SettingsEnrichmentScreenProps,
} from "./SettingsEnrichmentScreen.js";

/*
 * Settings → Enrichment (issue #807). The behaviour that matters is that this
 * page is a PROJECTION: every control writes through the store that owns its
 * path and renders what came back, the resolver's answer is what a row shows
 * rather than a fold done here, a ceiling that will refuse a row says so at the
 * row, and the faces capability is offered no delegate at all.
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
        id: "ocr-codex",
        label: "Codex",
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
    effective: {
      faces: {
        capability: "faces",
        enabled: true,
        profileId: "built-in",
        trigger: "on-ingest",
        egressCeiling: "on-device",
      },
      ocr: {
        capability: "ocr",
        enabled: true,
        profileId: "built-in",
        trigger: "on-view",
        egressCeiling: "on-device",
      },
    },
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

  it("renders a capability as its plain name, what it gets you, and where it runs", async () => {
    const el = await mount(makeProps());
    const photos = control(el, "Enrichment for Photos");
    expect(
      photos.querySelector<HTMLElement>('[data-active="true"]')?.dataset.value
    ).toBe("device");
    expect(el.textContent).toContain("Text in photos");
    expect(el.textContent).toContain("receipts, signs, whiteboards");
    expect(el.textContent).toContain("on your gateway");
    // The recorded answer reads as a sentence about the member, not a decision
    // enum beside an egress class.
    expect(el.textContent).toContain("You declined");
  });

  it("shows the resolver's answer on the switch, not a fold of its own", async () => {
    const el = await mount(
      makeProps({
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue(
          makeData({
            effective: {
              ...makeData().effective,
              ocr: {
                capability: "ocr",
                enabled: false,
                profileId: "built-in",
                trigger: "on-view",
                egressCeiling: "on-device",
              },
            },
          })
        ),
      })
    );
    expect((control(el, "Text in photos") as HTMLInputElement).checked).toBe(
      false
    );
    expect((control(el, "Faces") as HTMLInputElement).checked).toBe(true);
  });

  it("says at the row when the ceiling will refuse it", async () => {
    // Photos is capped at `on-device`; the bundled OCR engine is gateway-lane,
    // so it does not run — which used to happen with nothing on screen saying so.
    const el = await mount(makeProps());
    expect(el.textContent).toContain("Won’t run — needs “On your gateway”.");
  });

  it("does not call an agent-backed row refused — provider egress is a consent question, not a tier one", async () => {
    // `provider` outranks every tier ceiling, so measuring the delegate's class
    // against the ceiling would mark every agent row dead. The tier gate
    // compares the enricher's LANE, which is the built-in profile's class.
    const el = await mount(
      makeProps({
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue(
          makeData({
            policy: { photos: "gateway", docs: "off" },
            effective: {
              faces: {
                capability: "faces",
                enabled: true,
                profileId: "built-in",
                trigger: "on-ingest",
                egressCeiling: "gateway",
              },
              ocr: {
                capability: "ocr",
                enabled: true,
                profileId: "ocr-codex",
                trigger: "on-view",
                egressCeiling: "gateway",
              },
            },
          })
        ),
      })
    );
    expect(el.textContent).toContain("sent to a provider");
    expect(el.textContent).not.toContain("Won’t run");
  });

  it("writes one vault-scope rule when a switch is flipped, keeping what it isn't changing", async () => {
    const setRule = vi
      .fn<SettingsEnrichmentScreenProps["setRule"]>()
      .mockResolvedValue(undefined);
    const el = await mount(makeProps({ setRule }));
    await act(async () => {
      (control(el, "Faces") as HTMLInputElement).click();
    });
    expect(setRule.mock.lastCall?.[0]).toStrictEqual({
      scope: "vault",
      ref: "",
      capability: "faces",
      enabled: false,
      profile: null,
      trigger: null,
    });
  });

  it("offers faces no engine to pick, and says why", async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('[aria-label="Engine for Faces"]')).toBeNull();
    expect(el.textContent).toContain(
      "Face imagery never leaves for a provider"
    );
  });

  it("creates the engine profile behind the row rather than asking for a name", async () => {
    const saveProfile = vi
      .fn<SettingsEnrichmentScreenProps["saveProfile"]>()
      .mockResolvedValue(undefined);
    const setRule = vi
      .fn<SettingsEnrichmentScreenProps["setRule"]>()
      .mockResolvedValue(undefined);
    const el = await mount(makeProps({ saveProfile, setRule }));
    await pick(
      control(el, "Engine for Text in photos") as HTMLSelectElement,
      "codex"
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(saveProfile.mock.lastCall?.[0]).toStrictEqual({
      id: "ocr-codex",
      label: "Codex",
      capability: "ocr",
      harness: "codex",
    });
    expect(setRule.mock.lastCall?.[0]?.profile).toBe("ocr-codex");
  });

  it("renders the tier the vault answered with, not the one that was clicked", async () => {
    // The vault coerces the click to `off`. Both the write's answer and the
    // re-read that follows it report the store, so the two agree — and neither
    // is the `gateway` that was pressed.
    let held: EnrichPolicy = { photos: "device", docs: "off" };
    const setTier = vi
      .fn<SettingsEnrichmentScreenProps["setTier"]>()
      .mockImplementation(async () => {
        held = { photos: "off", docs: "off" };
        return held;
      });
    const el = await mount(
      makeProps({
        load: vi
          .fn<SettingsEnrichmentScreenProps["load"]>()
          .mockImplementation(async () => makeData({ policy: held })),
        setTier,
      })
    );
    await act(async () => {
      control(el, "Enrichment for Photos")
        .querySelector<HTMLButtonElement>('[data-value="gateway"]')
        ?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(setTier.mock.lastCall).toStrictEqual(["photos", "gateway"]);
    expect(
      control(el, "Enrichment for Photos").querySelector<HTMLElement>(
        '[data-active="true"]'
      )?.dataset.value
    ).toBe("off");
  });

  it("lists a deeper scope as an exception", async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain("Exceptions");
    expect(el.textContent).toContain("domain · photos");
  });

  it("has no exceptions group when every decision is a vault-scope switch", async () => {
    const el = await mount(
      makeProps({
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue(
          makeData({
            rules: [
              {
                scope: { type: "vault", ref: "" },
                capability: "ocr",
                enabled: false,
                profile: null,
                trigger: null,
                updatedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          })
        ),
      })
    );
    expect(el.textContent).not.toContain("Exceptions");
  });

  it("says so when the gateway does not answer", async () => {
    const load = vi
      .fn<SettingsEnrichmentScreenProps["load"]>()
      .mockRejectedValue(new Error("gateway unreachable"));
    const el = await mount(makeProps({ load }));
    expect(el.textContent).toContain("gateway unreachable");
  });
});
