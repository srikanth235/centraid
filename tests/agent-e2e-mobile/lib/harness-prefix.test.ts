// Spec for the deferred chunk prefix (#905).
//
// `ctx.restart()` and reuse-mode `ctx.configureGateway()` used to spawn
// `maestro test` for a launch that every caller immediately followed with more
// commands — ~9-15s of JVM start and driver connect each, six times across the
// PR gate. They now stage their commands and the next `ctx.run()` folds them in.
// The fold is where that can go wrong silently: commands inserted before the
// `---` separator are read as document header, and commands appended after the
// chunk's own would relaunch the app AFTER the assertions that need it.

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
    // The shape `ctx.flush()` builds: a header and nothing else, so a flow that
    // must keep a staged launch out of a timed window gets exactly that launch.
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
    // The reuse prefix's `extendedWaitUntil` is the whole evidence that Home
    // came back, so `assertionsRun` must see it once folded — counting the
    // caller's YAML alone would silently drop it.
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
