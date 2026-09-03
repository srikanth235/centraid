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
    modelByHarness: { codex: "gpt-5" },
    effortByHarness: { codex: "high" },
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
    setEngineModel: vi
      .fn<SettingsEnrichmentScreenProps["setEngineModel"]>()
      .mockResolvedValue(null),
    setEngineEffort: vi
      .fn<SettingsEnrichmentScreenProps["setEngineEffort"]>()
      .mockResolvedValue(null),
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

function pill(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith(label)
  );
  if (!found) throw new Error(`no pill reading "${label}"`);
  return found;
}

function chip(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll(".capChip")].find(
    (button) => button.textContent === label
  );
  if (!found) throw new Error(`no engine chip "${label}"`);
  return found as HTMLButtonElement;
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

  it("renders a capability as its plain name and what it gets you, under a head that counts", async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain("Text in photos");
    expect(el.textContent).toContain("receipts, signs, whiteboards");
    expect(el.textContent).toContain("2 of 2 on");
    expect(el.textContent).toContain("Declined · built-in engine only");
  });

  it("offers no ceiling control — where enrichment runs is not a member's choice", async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('[aria-label="Enrichment for Photos"]')).toBeNull();
    expect(el.textContent).not.toContain("On this device");
    expect(el.textContent).not.toContain("How far your photos may go");
  });

  it("states only the egress that matters — a provider, and nothing otherwise", async () => {
    const el = await mount(makeProps());
    expect(el.textContent).not.toContain("on your gateway");
    expect(el.textContent).not.toContain("at a provider");
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

  it("says at the row when a stored ceiling will refuse it", async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain(
      "Stopped by a stored ceiling: no further than this device."
    );
  });

  it("does not call an agent-backed row refused — provider egress is a consent question, not a ceiling one", async () => {
    const el = await mount(
      makeProps({
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue(
          makeData({
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
    expect(el.textContent).toContain("at a provider");
    expect(el.textContent).not.toContain("Stopped by a stored ceiling");
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

  it("offers no engine on a row that is switched off — nothing reads it yet", async () => {
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
    expect(el.querySelector("[aria-expanded]")).toBeNull();
    expect(el.textContent).not.toContain("Built in");
  });

  it("offers faces no engine to pick, and carries its reassurance in its own description", async () => {
    const el = await mount(makeProps());
    expect(el.querySelector("[data-open]")?.textContent).not.toContain("Faces");
    expect(el.textContent).toContain(
      "Named only by you, and never sent to a provider."
    );
  });

  it("renders a capability this build has no words for as un-switchable", async () => {
    const el = await mount(
      makeProps({
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue(
          makeData({
            effective: { ...makeData().effective, faces: null },
          })
        ),
      })
    );
    expect(el.querySelector('[aria-label="Faces"]')).toBeNull();
    expect(el.textContent).toContain("no vocabulary");
  });

  it("creates the engine profile behind the row rather than asking for a name", async () => {
    const saveProfile = vi
      .fn<SettingsEnrichmentScreenProps["saveProfile"]>()
      .mockResolvedValue(undefined);
    const setRule = vi
      .fn<SettingsEnrichmentScreenProps["setRule"]>()
      .mockResolvedValue(undefined);
    const el = await mount(makeProps({ saveProfile, setRule }));
    await act(async () => {
      pill(el, "Built in").click();
    });
    await act(async () => {
      chip(el, "Codex").click();
    });
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

  it("writes the Agents page's own model pin from the engine's model row", async () => {
    const setEngineModel = vi
      .fn<SettingsEnrichmentScreenProps["setEngineModel"]>()
      .mockResolvedValue(null);
    const el = await mount(
      makeProps({
        setEngineModel,
        load: vi.fn<SettingsEnrichmentScreenProps["load"]>().mockResolvedValue(
          makeData({
            effective: {
              ...makeData().effective,
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
    await act(async () => {
      pill(el, "Codex · high").click();
    });
    await pick(
      control(el, "Model for Text in photos") as HTMLSelectElement,
      "gpt-5"
    );
    expect(setEngineModel.mock.lastCall).toStrictEqual(["codex", "gpt-5"]);
  });

  it("returns the gateway's own words when a switch is refused", async () => {
    const showToast = vi.fn<SettingsEnrichmentScreenProps["showToast"]>();
    const el = await mount(
      makeProps({
        showToast,
        setRule: vi
          .fn<SettingsEnrichmentScreenProps["setRule"]>()
          .mockRejectedValue(
            new Error(
              "enrich.policy.write refused: filing requires the entity reader"
            )
          ),
      })
    );
    const faces = control(el, "Faces") as HTMLInputElement;
    await act(async () => {
      faces.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(showToast.mock.lastCall?.[0]).toContain(
      "enrich.policy.write refused"
    );
    expect((control(el, "Faces") as HTMLInputElement).checked).toBe(true);
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
