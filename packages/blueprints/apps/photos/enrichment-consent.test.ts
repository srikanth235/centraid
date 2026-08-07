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
// the behaviour), while the GATE (`enrichment-gate.ts`) is a plain closure
// over `window.centraid` — driven directly, because "did a call write" is a
// question the closure's own return value answers without a mounted DOM.
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

describe("the enrichment gate (issue #712 C2, re-homed into People's empty state)", () => {
  // `enrichment-gate.ts` is the retired toolbar dialog's state machine,
  // lifted so it can drive `PeopleShelf`'s `gate` prop instead — a plain
  // closure over `window.centraid`, so these tests drive it directly rather
  // than through a mounted component. THE LOAD-BEARING RULE is unchanged:
  // no enrichment write without an explicit answer.
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
    expect(gate.props(6214)?.onDevice.available).toBe(true);
  });

  it("writes nothing when the member declines", async () => {
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    gate.props(6214)?.onDecline();
    expect(write).not.toHaveBeenCalled();
    // Declining answers the question — the caller falls back to its own
    // plain empty copy rather than leaving a half-answered gate up.
    expect(gate.props(6214)).toBeNull();
  });

  it("issues the request only from the explicit on-device answer", async () => {
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    expect(write).not.toHaveBeenCalled();
    gate.props(6214)?.onRunOnDevice();
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "request-enrichment",
        input: { entity_type: "media.media_asset" },
      })
    );
  });

  it("takes one answer, not two — a second call writes nothing more", async () => {
    const gate = createEnrichmentGate({ onData });
    gate.ensurePolicyLoaded();
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith());
    gate.props(6214)?.onRunOnDevice();
    gate.props(6214)?.onRunOnDevice();
    expect(write).toHaveBeenCalledOnce();
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
