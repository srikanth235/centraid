import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { KIT_DIR } from "./kit.js";

describe("design kit seam", () => {
  it("exports an absolute path to the on-disk kit layer", () => {
    expect(path.isAbsolute(KIT_DIR)).toBe(true);
    expect(path.basename(KIT_DIR)).toBe("kit");
    expect(existsSync(path.join(KIT_DIR, "kit.ts"))).toBe(true);
    expect(existsSync(path.join(KIT_DIR, "kit.css"))).toBe(true);
    expect(existsSync(path.join(KIT_DIR, "conversation-client.js"))).toBe(true);
  });
});
