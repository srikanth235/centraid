import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { checkAssembledReference } from "./assembled-links.mjs";

describe("assembled site references", () => {
  it("rejects missing routes and fragments", async () => {
    const siteDir = tempDirSync("centraid-site-links-");
    mkdirSync(path.join(siteDir, "docs", "start"), { recursive: true });
    writeFileSync(
      path.join(siteDir, "docs", "start", "index.html"),
      '<main id="first-day"></main>'
    );

    await expect(
      checkAssembledReference("docs/start/#first-day", "index.html", siteDir)
    ).resolves.toBeNull();
    await expect(
      checkAssembledReference("docs/missing/", "index.html", siteDir)
    ).resolves.toMatch(/missing docs\/missing\/index\.html/u);
    await expect(
      checkAssembledReference("/docs/start/#gone", "index.html", siteDir)
    ).resolves.toMatch(/missing #gone/u);
  });
});
