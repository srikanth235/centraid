/*
 * Settings → Enrichment. The laws are about CONSENT, not layout: raising a
 * domain to the model tier is the moment photographs start leaving the
 * member's devices, so the question must be asked before the write and a
 * decline must leave the vault exactly as it was.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsEnrichmentScreen, {
  egressConsentCopy,
} from "./SettingsEnrichmentScreen.js";
import type { SettingsEnrichmentScreenProps } from "./SettingsEnrichmentScreen.js";

function makeProps(
  over: Partial<SettingsEnrichmentScreenProps> = {}
): SettingsEnrichmentScreenProps {
  return {
    confirmEgress: vi
      .fn<SettingsEnrichmentScreenProps["confirmEgress"]>()
      .mockResolvedValue(true),
    loadPolicy: vi
      .fn<SettingsEnrichmentScreenProps["loadPolicy"]>()
      .mockResolvedValue({ docs: "local", photos: "local" }),
    scopeLabel: "Shared",
    setTier: vi
      .fn<SettingsEnrichmentScreenProps["setTier"]>()
      .mockImplementation((domain, tier) =>
        Promise.resolve({ docs: "local", photos: "local", [domain]: tier })
      ),
    showToast: vi.fn<SettingsEnrichmentScreenProps["showToast"]>(),
    ...over,
  };
}

let root: Root | undefined;
let host: HTMLElement | undefined;

async function render(props: SettingsEnrichmentScreenProps): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<SettingsEnrichmentScreen {...props} />);
  });
}

function tierButton(domain: string, label: string): HTMLButtonElement {
  const group = host?.querySelector<HTMLElement>(
    `[aria-label*="${domain}"][role="tablist"]`
  );
  if (!group) throw new Error(`no segmented control for ${domain}`);
  const button = [...group.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label
  );
  if (!button) throw new Error(`no "${label}" option for ${domain}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

describe("Settings → Enrichment", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it("law: the vault's tier is rendered, never an optimistic default", async () => {
    const props = makeProps({
      loadPolicy: vi
        .fn<SettingsEnrichmentScreenProps["loadPolicy"]>()
        .mockResolvedValue({ docs: "off", photos: "model" }),
    });
    await render(props);

    expect(
      tierButton("photographs", "Model provider").getAttribute("aria-selected")
    ).toBe("true");
    expect(tierButton("documents", "Off").getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("law: raising a domain to the model tier asks BEFORE it writes", async () => {
    const props = makeProps();
    await render(props);

    await click(tierButton("photographs", "Model provider"));

    expect(props.confirmEgress).toHaveBeenCalledOnce();
    const asked = vi.mocked(props.confirmEgress).mock.calls[0]?.[0];
    expect(asked?.message).toContain("over the network");
    expect(props.setTier).toHaveBeenCalledWith("photos", "model");
    // The ask happened first: had the order been reversed, the write would
    // have landed even on a decline — which the next law pins.
    expect(
      vi.mocked(props.confirmEgress).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(props.setTier).mock.invocationCallOrder[0] ?? 0);
  });

  it("law: declining the question writes nothing at all", async () => {
    const props = makeProps({
      confirmEgress: vi
        .fn<SettingsEnrichmentScreenProps["confirmEgress"]>()
        .mockResolvedValue(false),
    });
    await render(props);

    await click(tierButton("photographs", "Model provider"));

    expect(props.setTier).not.toHaveBeenCalled();
    expect(
      tierButton("photographs", "On your devices").getAttribute("aria-selected")
    ).toBe("true");
  });

  it("law: lowering the tier needs no consent question — only egress does", async () => {
    const props = makeProps({
      loadPolicy: vi
        .fn<SettingsEnrichmentScreenProps["loadPolicy"]>()
        .mockResolvedValue({ docs: "local", photos: "model" }),
    });
    await render(props);

    await click(tierButton("photographs", "Off"));

    expect(props.confirmEgress).not.toHaveBeenCalled();
    expect(props.setTier).toHaveBeenCalledWith("photos", "off");
  });

  it("law: the control renders the tier the vault reports, not the one clicked", async () => {
    // A gateway that coerced the write must not leave the member looking at
    // the tier they asked for.
    const props = makeProps({
      setTier: vi
        .fn<SettingsEnrichmentScreenProps["setTier"]>()
        .mockResolvedValue({ docs: "local", photos: "local" }),
    });
    await render(props);

    await click(tierButton("photographs", "Model provider"));

    expect(
      tierButton("photographs", "On your devices").getAttribute("aria-selected")
    ).toBe("true");
  });

  it("law: the `local` tier is never described as running a model locally", async () => {
    await render(makeProps());
    const local = host?.querySelector('[data-testid="enrich-photos-local"]');

    expect(local?.textContent).toContain("Centraid has no on-device model");
    expect(local?.textContent).toContain("Nothing is sent to a model provider");
    expect(local?.textContent).not.toMatch(/local model|on-device model runs/u);
  });

  it("law: the consent question says the data leaves, in plain words", () => {
    const copy = egressConsentCopy("photos", "Shared");

    expect(copy.title).toContain("Shared");
    expect(copy.message).toContain("Centraid has no on-device model");
    expect(copy.message).toContain("sends the photograph itself");
    // Named by its own label, never "this vault" (#599 / decision S6).
    expect(`${copy.title} ${copy.message}`).not.toMatch(/this vault/iu);
  });
});
