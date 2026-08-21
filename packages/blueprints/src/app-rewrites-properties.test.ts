import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { rewriteAutomationManifestNames } from "./app-rewrites.js";

/**
 * The thin readFile/writeFile wrappers over the pure rewrites next door.
 * Split from the app-meta property file (#656 Layer 3) — their whole
 * behaviour is "missing → no-op, changed → write", which is a different law
 * from the string transforms they wrap, and the combined file exceeded the
 * size cap.
 */

describe("filesystem rewrite wrappers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir("centraid-rewrites-");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rewriteAutomationManifestNames is a no-op without an automations/ dir", async () => {
    await expect(
      rewriteAutomationManifestNames(dir, "New")
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "automations"))).rejects.toThrow(
      /ENOENT/u
    );
  });

  it("rewrites every real manifest, skipping dot/underscore dirs and broken files", async () => {
    const write = async (rel: string, content: string): Promise<void> => {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    };
    const manifest = JSON.stringify({ name: "Old" }, null, 2) + "\n";
    await write("automations/wake/automation.json", manifest);
    await write("automations/sleep/automation.json", manifest);
    await write("automations/.hidden/automation.json", manifest);
    await write("automations/_scratch/automation.json", manifest);
    await write("automations/broken/automation.json", "{oops");
    await write("automations/README.md", "not a manifest");

    await rewriteAutomationManifestNames(dir, "New");

    const nameOf = async (rel: string): Promise<string> =>
      fs
        .readFile(path.join(dir, rel), "utf8")
        .then((raw) => (JSON.parse(raw) as { name: string }).name);
    await expect(nameOf("automations/wake/automation.json")).resolves.toBe(
      "New"
    );
    await expect(nameOf("automations/sleep/automation.json")).resolves.toBe(
      "New"
    );
    // Conventionally-hidden folders are not automations.
    await expect(nameOf("automations/.hidden/automation.json")).resolves.toBe(
      "Old"
    );
    await expect(nameOf("automations/_scratch/automation.json")).resolves.toBe(
      "Old"
    );
    // A broken sibling does not abort the others, and is left as-is.
    await expect(
      fs.readFile(path.join(dir, "automations/broken/automation.json"), "utf8")
    ).resolves.toBe("{oops");
    await expect(
      fs.readFile(path.join(dir, "automations/README.md"), "utf8")
    ).resolves.toBe("not a manifest");
  });

  it("stamps generated on disk only when the clone path asks for it", async () => {
    const rel = "automations/wake/automation.json";
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(
      full,
      JSON.stringify(
        {
          name: "Old",
          generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
        },
        null,
        2
      ) + "\n"
    );
    await rewriteAutomationManifestNames(dir, "New", { stampGenerated: true });
    const out = JSON.parse(await fs.readFile(full, "utf8")) as {
      name: string;
      generated: { by: string; at: string };
    };
    expect(out.name).toBe("New");
    expect(out.generated.by).toBe("centraid-builder");
    expect(out.generated.at).not.toBe("2020-01-01T00:00:00.000Z");
  });
});
