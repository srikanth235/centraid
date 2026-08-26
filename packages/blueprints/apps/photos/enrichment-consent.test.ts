// @vitest-environment jsdom
// THE ENRICHMENT CONSENT MOMENT (v4 handoff §8) — a privacy regression net.
//   1. NO ENRICHMENT WRITE WITHOUT AN EXPLICIT ANSWER: mounting, opening,
//      reading the policy, declining, closing all write nothing. No
//      device-side faces producer exists here; that answer cannot reach
//      `window.centraid.write`.
//   2. THE EGRESS DISCLOSURE STAYS ON SCREEN: the cloud panel is the only
//      place Photos says photographs would leave the device; it renders even
//      though no cloud helper can be chosen.
// Copy asserted via the shared consent module (the native client renders the
// same one). Views via renderToStaticMarkup; gate driven directly.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
interface EnrichmentGate {
  ensurePolicyLoaded: () => void;
  props: (count: number) => ConsentProps | null;
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
const { createEnrichmentGate } = (await import(app("enrichment-gate.ts"))) as {
  createEnrichmentGate: (opts: { onData: () => void }) => EnrichmentGate;
};

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
    // Flagged as egress: `data-net` is what the stylesheet turns into the
    // 2px `--net` rule, so this pins the mark, not a class name.
    expect(html).toMatch(
      /data-net="true"[^]*?a downscaled copy of every photograph/u
    );
    expect(html).toContain("Faster, and the photographs leave this device.");
  });

  it("renders the cloud panel even though no cloud helper can be chosen", () => {
    // Present and unavailable, with the reason stated — never omitted;
    // omitting it removes the disclosure above with it.
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
    // The ONE filled element is the run answer (§18); the cloud answer is
    // outlined destructive, never a fill.
    expect(html).toMatch(/class="kit-btn primary"[^]*?Run on this device/u);
    expect(html).toMatch(
      /class="kit-btn destructive"[^]*?Choose the cloud helper/u
    );
  });

  it("withholds the device answer when the library points at the gateway tier", () => {
    // "what leaves the device: nothing" is FALSE there, so no answer; name it.
    expect(copy.deviceAnswerFor("gateway").available).toBe(false);
    expect(copy.deviceAnswerFor("gateway").reason).toBe(
      copy.ENRICHMENT_UNAVAILABLE.modelTier
    );
    expect(copy.deviceAnswerFor("off").available).toBe(false);
    expect(copy.deviceAnswerFor("device")).toStrictEqual({
      available: false,
      reason: copy.ENRICHMENT_UNAVAILABLE.deviceUnavailable,
    });
    expect(copy.deviceAnswerFor(null).available).toBe(false);
    expect(copy.deviceAnswerFor("device", true).available).toBe(false);
  });

  it("[C5] also accepts the pre-rename 'local'/'model' spellings, the same way", () => {
    // A raw `enrich.policy` row can bypass vault's normalizing read — see
    // this file's C5 COMPAT comment.
    expect(copy.deviceAnswerFor("local")).toStrictEqual({
      available: false,
      reason: copy.ENRICHMENT_UNAVAILABLE.deviceUnavailable,
    });
    expect(copy.deviceAnswerFor("model").available).toBe(false);
    expect(copy.deviceAnswerFor("model").reason).toBe(
      copy.ENRICHMENT_UNAVAILABLE.modelTier
    );
  });
});

describe("the enrichment gate (issue #712 C2, re-homed into People's empty state)", () => {
  // `enrichment-gate.ts` drives `PeopleShelf`'s `gate` prop — a plain closure
  // over `window.centraid`, driven directly. LOAD-BEARING: no enrichment write
  // without an explicit answer.
  const write = vi.fn<(intent: unknown) => Promise<{ status: string }>>(
    async () => ({ status: "executed" })
  );
  const read = vi.fn<(query: unknown) => Promise<{ tier: string }>>(
    async () => ({
      tier: "device",
    })
  );
  const onData = vi.fn<() => void>();

  beforeEach(() => {
    write.mockClear();
    read.mockClear();
    onData.mockClear();
    (window as unknown as { centraid: unknown }).centraid = { read, write };
  });

  it("writes nothing on creation, and nothing on reading the policy", async () => {
    const gate = createEnrichmentGate({ onData });
    expect(write).not.toHaveBeenCalled();
    gate.ensurePolicyLoaded();
    expect(write).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    expect(gate.props(6214)?.onDevice).toStrictEqual({
      available: false,
      reason: copy.ENRICHMENT_UNAVAILABLE.deviceUnavailable,
    });
  });

  it("writes nothing when the member declines", async () => {
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    gate.props(6214)?.onDecline();
    expect(write).not.toHaveBeenCalled();
    // Declining answers the question — the caller falls back to its own copy
    // rather than leaving a half-answered gate up.
    expect(gate.props(6214)).toBeNull();
  });

  it("does not issue a request when no device-side faces producer exists", async () => {
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    expect(write).not.toHaveBeenCalled();
    gate.props(6214)?.onRunOnDevice();
    expect(write).not.toHaveBeenCalled();
  });

  it("repeated unavailable on-device answers remain write-free", async () => {
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    gate.props(6214)?.onRunOnDevice();
    gate.props(6214)?.onRunOnDevice();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses the answer outright when the library's tier cannot honour it", async () => {
    read.mockResolvedValueOnce({ tier: "gateway" });
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    const props = gate.props(6214);
    expect(props?.onDevice.available).toBe(false);
    expect(props?.onDevice.reason).toBe(copy.ENRICHMENT_UNAVAILABLE.modelTier);
    props?.onRunOnDevice();
    expect(write).not.toHaveBeenCalled();
  });
});
