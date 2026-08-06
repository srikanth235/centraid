// @vitest-environment jsdom
// THE ENRICHMENT CONSENT MOMENT (v4 handoff §8, prototype `s==='enrich'`).
//
// Two rules are load-bearing here, and both were BROKEN before this suite
// existed — this is a privacy regression net, not a styling snapshot:
//
//   1. NO ENRICHMENT WRITE MAY BE ISSUED WITHOUT AN EXPLICIT ANSWER. The
//      previous surface was a popover with a `Detect faces now` button: one
//      click, one write, no facts. Mounting, opening the question, reading the
//      policy, declining and closing must all write nothing, and only the
//      `Run on this device` answer may reach `window.centraid.write`.
//   2. THE EGRESS DISCLOSURE MUST BE ON SCREEN. The cloud panel is the only
//      place in Photos where the product says a downscaled copy of every
//      photograph would leave the device. It renders even though this repo
//      has no cloud helper to choose — an unwired action is a stated fact, not
//      a reason to delete a disclosure.
//
// The copy assertions read from the shared consent module rather than
// re-typing its strings, because the same module is what the native client
// renders (apps/mobile/src/apps/photos/EnrichmentConsent.tsx) — a drift there
// is a drift here.
//
// jsdom for the whole file: the panel view is asserted through
// `renderToStaticMarkup` (it is a pure view over its props, so the markup IS
// the behaviour), while the GATE is driven for real with `createRoot`,
// because "did a click write" is a question only a driven DOM can answer.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { act, createElement } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, ".", rel)).href;

interface AnswerAvailability {
  available: boolean;
  reason?: string;
}
interface ConsentProps {
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  busy?: boolean;
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  onChooseCloud?: () => void;
}
interface PanelProps {
  photographCount?: number | null;
}
interface ConsentCopy {
  ON_DEVICE_PANEL: {
    eyebrow: string;
    body: string;
    facts: readonly { label: string; value: string; net?: boolean }[];
    action: string;
    action2?: string;
  };
  CLOUD_PANEL: {
    eyebrow: string;
    title: string;
    body: string;
    facts: readonly { label: string; value: string; net?: boolean }[];
    action: string;
  };
  CLOUD_EGRESS_DISCLOSURE: string;
  ENRICHMENT_NOTE: string;
  ENRICHMENT_STATUS_LINE: string;
  ENRICHMENT_UNAVAILABLE: Record<string, string>;
  onDeviceTitle: (count: number) => string;
  deviceAnswerFor: (
    tier: string | null | undefined,
    denied?: boolean
  ) => AnswerAvailability;
  CLOUD_ANSWER: AnswerAvailability;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const copy = (await import(app("enrichment-consent.ts"))) as ConsentCopy;
const { EnrichmentConsent } = (await import(
  app("components/EnrichmentConsent.tsx")
)) as { EnrichmentConsent: ComponentType<ConsentProps> };
const { EnrichmentPanel } = (await import(
  app("components/Enrichment.tsx")
)) as { EnrichmentPanel: ComponentType<PanelProps> };

/** Every fact the two panels must state — the handoff's nine, verbatim. */
const NINE_FACTS: readonly [string, string][] = [
  ["where it would run", "on this device"],
  ["what leaves the device", "nothing"],
  ["how long", "about 40 minutes, resumable"],
  ["what it writes", "a faces column in your library"],
  ["undo", "delete the faces column; photographs are untouched"],
  ["where it would run", "a cloud helper you have named"],
  ["what leaves the device", "a downscaled copy of every photograph"],
  ["how long", "about 6 minutes"],
  ["receipt", "one per batch, in the grants ledger"],
];

function markup(props: Partial<ConsentProps> = {}): string {
  return renderToStaticMarkup(
    createElement(EnrichmentConsent, {
      count: 6214,
      onDevice: { available: true },
      cloud: copy.CLOUD_ANSWER,
      onRunOnDevice: () => undefined,
      onDecline: () => undefined,
      ...props,
    })
  );
}

describe("the enrichment consent surface", () => {
  it("asks the question over the live count, before anything runs", () => {
    expect(markup()).toContain("Run face detection over 6,214 photographs?");
    // A library of one is still a sentence, not `1 photographs`.
    expect(copy.onDeviceTitle(1)).toBe("Run face detection over 1 photograph?");
  });

  it("states all nine facts, in both panels", () => {
    const html = markup();
    for (const [label, value] of NINE_FACTS) {
      expect(html).toContain(label);
      expect(html).toContain(value);
    }
  });

  it("carries the egress disclosure in the cloud panel, flagged", () => {
    const html = markup();
    // THE line. Its absence is the defect this file exists to catch.
    expect(html).toContain(copy.CLOUD_EGRESS_DISCLOSURE);
    expect(html).toContain("a downscaled copy of every photograph");
    // Flagged as egress — `data-net` is what the stylesheet turns into the 2px
    // `--net` rule, so this pins the mark and not a class name.
    expect(html).toMatch(
      /data-net="true"[^]*?a downscaled copy of every photograph/u
    );
    expect(html).toContain("Faster, and the photographs leave this device.");
  });

  it("renders the cloud panel even though no cloud helper can be chosen", () => {
    // The action is present and unavailable, with the reason stated — never
    // omitted, because omitting it removes the disclosure above with it.
    const html = markup();
    expect(html).toContain(copy.CLOUD_PANEL.action);
    expect(html).toContain(copy.ENRICHMENT_UNAVAILABLE.cloudUnavailable);
    expect(html).toMatch(/Choose the cloud helper[^]*?<\/button>/u);
    expect(html).toMatch(/disabled=""[^]*?Choose the cloud helper/u);
  });

  it("says it is not a settings toggle", () => {
    expect(markup()).toContain(
      "This is not a settings toggle. It is asked once, answered once, and receipted — and the answer is visible in Privacy afterwards."
    );
    expect(copy.ENRICHMENT_NOTE).toContain("asked once, answered once");
  });

  it("offers both answers, one filled and one plain", () => {
    const html = markup();
    expect(html).toContain("Run on this device");
    expect(html).toContain("Not now");
    // The ONE filled element on the surface is the run answer (§18); the cloud
    // answer is outlined destructive, never a fill.
    expect(html).toMatch(/class="kit-btn primary"[^]*?Run on this device/u);
    expect(html).toMatch(
      /class="kit-btn destructive"[^]*?Choose the cloud helper/u
    );
  });

  it("withholds the device answer when the library points at the gateway tier", () => {
    // "what leaves the device: nothing" is FALSE for such a library, so the
    // answer is not offered and the reason is named.
    expect(copy.deviceAnswerFor("gateway").available).toBe(false);
    expect(copy.deviceAnswerFor("gateway").reason).toBe(
      copy.ENRICHMENT_UNAVAILABLE.modelTier
    );
    expect(copy.deviceAnswerFor("off").available).toBe(false);
    expect(copy.deviceAnswerFor("device").available).toBe(true);
    expect(copy.deviceAnswerFor(null).available).toBe(false);
    expect(copy.deviceAnswerFor("device", true).available).toBe(false);
  });

  it("[C5] also accepts the pre-rename 'local'/'model' spellings, the same way", () => {
    // A raw `enrich.policy` row can reach this module without going through
    // packages/vault's own normalizing read (queries/enrichment-status.ts
    // reads the table directly) — see this file's C5 COMPAT comment.
    expect(copy.deviceAnswerFor("local").available).toBe(true);
    expect(copy.deviceAnswerFor("model").available).toBe(false);
    expect(copy.deviceAnswerFor("model").reason).toBe(
      copy.ENRICHMENT_UNAVAILABLE.modelTier
    );
  });
});

describe("the enrichment gate", () => {
  let host: HTMLDivElement;
  let root: Root;
  const write = vi.fn<(intent: unknown) => Promise<{ status: string }>>(
    async () => ({ status: "executed" })
  );
  const read = vi.fn<(query: unknown) => Promise<{ tier: string }>>(
    async () => ({
      tier: "device",
    })
  );

  beforeEach(() => {
    write.mockClear();
    read.mockClear();
    (window as unknown as { centraid: unknown }).centraid = { read, write };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(createElement(EnrichmentPanel, { photographCount: 6214 }));
    });
  }

  function click(label: string): Promise<void> {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label || b.ariaLabel === label
    );
    expect(button, `no control labelled ${label}`).toBeTruthy();
    return act(async () => {
      button?.click();
    });
  }

  it("writes nothing on mount, and nothing on opening the question", async () => {
    await mount();
    expect(write).not.toHaveBeenCalled();
    await click("Enrichment");
    expect(host.textContent).toContain("Run face detection over 6,214");
    // Opening reads the policy; it does not write.
    expect(write).not.toHaveBeenCalled();
  });

  it("writes nothing when the member declines", async () => {
    await mount();
    await click("Enrichment");
    await click("Not now");
    expect(write).not.toHaveBeenCalled();
    // Declining closes the question rather than leaving a half-answered one up.
    expect(host.textContent).not.toContain("Run face detection over");
  });

  it("issues the request only from the explicit on-device answer", async () => {
    await mount();
    await click("Enrichment");
    expect(write).not.toHaveBeenCalled();
    await click("Run on this device");
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "request-enrichment",
        input: { entity_type: "media.media_asset" },
      })
    );
  });

  it("takes one answer, not two — a second click writes nothing more", async () => {
    await mount();
    await click("Enrichment");
    await click("Run on this device");
    await click("Run on this device");
    expect(write).toHaveBeenCalledOnce();
  });

  it("refuses the answer outright when the library's tier cannot honour it", async () => {
    read.mockResolvedValueOnce({ tier: "gateway" });
    await mount();
    await click("Enrichment");
    expect(host.textContent).toContain(copy.ENRICHMENT_UNAVAILABLE.modelTier);
    await click("Run on this device");
    expect(write).not.toHaveBeenCalled();
  });
});
