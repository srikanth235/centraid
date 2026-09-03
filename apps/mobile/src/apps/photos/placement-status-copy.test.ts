import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const VIEWER = path.join(import.meta.dirname, "PhotoLightbox.tsx");
const source = await readFile(VIEWER, "utf8");

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
    expect(source).not.toContain('result.status === "executed"');
  });

  it("names a refusal a refusal and a failure a failure", () => {
    expect(source).toContain("Placement denied");
    expect(source).toContain("Placement could not be applied");
    expect(source).toContain("Placement needs attention");
  });

  it("borrows the Pending-changes sheet's words rather than minting rivals", async () => {
    const statusBar = await readFile(STATUS_BAR, "utf8");
    expect(statusBar).toContain("permission changed");
    expect(statusBar).toContain("needs attention");
    expect(source).toContain("permission changed");
    expect(source).toContain("needs attention");
  });
});
