// A placement's answer, told as it was (#880).
//
// `session.place()` settles at one of six statuses and only ONE of them —
// `queued` — is "waiting for the network". The viewer used to print the queued
// sentence for every status that was not `executed`, so a `denied` (permission
// changed, gateway right there) and a `failed` were both announced as work
// that would resume later. Nothing resumes; the answer already arrived.
//
// Read as source text because `placementLine` is private to the viewer, whose
// module graph reaches the gesture handler and Expo runtimes — the assertion
// is about which words that file contains, and does not need the screen.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const VIEWER = path.join(import.meta.dirname, "PhotoLightbox.tsx");
const source = await readFile(VIEWER, "utf8");

/** The Pending-changes sheet's own vocabulary, which lives in the pure copy
 *  module the sheet renders from (#880 W2.3 moved it out of the status bar). */
const STATUS_BAR = path.join(
  import.meta.dirname,
  "../../kit/replica/pending-copy.ts"
);

describe("what the viewer says a placement did", () => {
  it("answers every status the placement record can hold", () => {
    for (const status of [
      "executed",
      "denied",
      "failed",
      "parked",
      "in-flight",
      "queued",
    ])
      expect(source, status).toContain(`case "${status}":`);
  });

  it("keeps the network sentence for the one status that is about the network", () => {
    const queued = "it will resume when the gateway is reachable";
    expect(source.split(queued)).toHaveLength(2);
    // The old collapse: everything that was not `executed` read as queued.
    expect(source).not.toContain('result.status === "executed"');
  });

  it("names a refusal a refusal and a failure a failure", () => {
    expect(source).toContain("Placement denied");
    expect(source).toContain("Placement could not be applied");
    expect(source).toContain("Placement needs attention");
  });

  it("borrows the Pending-changes sheet's words rather than minting rivals", async () => {
    const statusBar = await readFile(STATUS_BAR, "utf8");
    // One act, one vocabulary: the sheet says "permission changed" and
    // "needs attention", so the viewer's sentences say the same things.
    expect(statusBar).toContain("permission changed");
    expect(statusBar).toContain("needs attention");
    expect(source).toContain("permission changed");
    expect(source).toContain("needs attention");
  });
});
