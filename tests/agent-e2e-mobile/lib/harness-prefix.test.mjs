import { describe, expect, it } from "vitest";

import { countMaestroAssertions } from "./failure-class.mjs";
import {
  prependPrefix,
  restartCommands,
  reusePairedCommands,
} from "./harness.mjs";

const CHUNK = `appId: dev.centraid.mobile
---
- tapOn: "Open Notes"
- assertVisible: "New note"
`;

describe("prependPrefix", () => {
  it("leaves a chunk untouched when nothing is staged", () => {
    expect(prependPrefix("", CHUNK)).toBe(CHUNK);
  });

  it("inserts staged commands after `---` and before the chunk's own first", () => {
    const merged = prependPrefix(restartCommands(), CHUNK);
    expect(merged).toBe(`appId: dev.centraid.mobile
---
- stopApp
- launchApp:
    clearState: false
- tapOn: "Open Notes"
- assertVisible: "New note"
`);
    expect(merged.indexOf("- stopApp")).toBeGreaterThan(merged.indexOf("---"));
  });

  it("keeps two staged prefixes in the order they were staged", () => {
    const merged = prependPrefix(
      `${reusePairedCommands()}${restartCommands()}`,
      CHUNK
    );
    expect(merged.indexOf("- launchApp")).toBeLessThan(
      merged.indexOf("- stopApp")
    );
  });

  it("makes the staged commands the whole body of an empty chunk", () => {
    expect(prependPrefix(reusePairedCommands(), "appId: x\n---\n")).toBe(
      `appId: x\n---\n${reusePairedCommands()}`
    );
  });

  it("refuses a chunk with no document separator", () => {
    expect(() => prependPrefix(restartCommands(), "- tapOn: Home\n")).toThrow(
      /document separator/u
    );
  });
});

describe("the staged commands", () => {
  it("carries the reuse wait as an observation the merged chunk counts", () => {
    expect(countMaestroAssertions(reusePairedCommands())).toBe(1);
    expect(
      countMaestroAssertions(prependPrefix(reusePairedCommands(), CHUNK))
    ).toBe(countMaestroAssertions(CHUNK) + 1);
  });

  it("restarts without clearing state, and asserts nothing by itself", () => {
    expect(restartCommands()).toContain("- stopApp");
    expect(restartCommands()).toContain("clearState: false");
    expect(countMaestroAssertions(restartCommands())).toBe(0);
  });
});
