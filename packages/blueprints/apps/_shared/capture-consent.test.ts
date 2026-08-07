// The capture-time OCR consent copy (issue #712 C3) — pinned the same way
// Photos' enrichment-consent.test.ts pins its copy, so a future edit that
// drops the caps, the egress flag, or the "not a separate choice" answer
// fails here rather than being noticed only in a screenshot review.
import { describe, expect, it } from "vitest";

import {
  OCR_CONSENT_NOTE,
  OCR_DECLINED_INLINE,
  OCR_GATEWAY_NOT_A_CHOICE,
  OCR_GATEWAY_PANEL,
  OCR_ON_DEVICE_PANEL,
} from "./capture-consent.ts";

describe("the on-device panel", () => {
  it("is the ONE filled answer, and states that nothing leaves the device", () => {
    expect(OCR_ON_DEVICE_PANEL.filled).toBe(true);
    expect(OCR_ON_DEVICE_PANEL.action).toBe("Extract on this phone");
    expect(OCR_ON_DEVICE_PANEL.action2).toBe("Not now");
    const leaves = OCR_ON_DEVICE_PANEL.facts.find(
      (fact) => fact.label === "what leaves the device"
    );
    expect(leaves?.value).toBe("nothing");
    expect(leaves?.net).toBeFalsy();
  });
});

describe("the gateway backstop panel", () => {
  it("is bordered in --net and states the #630 size caps", () => {
    expect(OCR_GATEWAY_PANEL.net).toBe(true);
    const caps = OCR_GATEWAY_PANEL.facts.find(
      (fact) => fact.label === "size caps"
    );
    expect(caps?.value).toBe("up to 20 megapixels or 25 MiB per scan");
  });

  it("flags exactly the egress fact, never the panel's whole action row", () => {
    const flagged = OCR_GATEWAY_PANEL.facts.filter((fact) => fact.net);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.label).toBe("what leaves the device");
  });

  it("is disclosed, not offered — it is never a second choice", () => {
    // Unlike Photos' cloud helper (a genuine second consent), the backstop is
    // the SAME on-device answer widened automatically — there is nothing to
    // click here, and the copy says so plainly rather than rendering a live
    // control that would fire nothing.
    expect(OCR_GATEWAY_PANEL.action).toBe("Not a separate choice");
    expect(OCR_GATEWAY_NOT_A_CHOICE).toContain("automatically");
  });
});

describe("the note and the declined state", () => {
  it("states that declining still saves the scan", () => {
    expect(OCR_CONSENT_NOTE).toContain("saves the scan without extracted text");
  });

  it("gives the declined scan an inline explanation, never a dead control", () => {
    expect(OCR_DECLINED_INLINE).toBe(
      "Text extraction declined — this scan saves without extracted text."
    );
  });
});
