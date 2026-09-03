import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

const run = promisify(execFile);

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const BUNDLE_IDS = [
  "photo-ocr",
  "embed-image",
  "embed-text",
  "faces",
  "place-names",
  "transcript",
] as const;

function bundlePath(root: string, id: string): string {
  return path.join(
    root,
    "packages/blueprints/automations",
    id,
    "automations",
    id,
    "handler.js"
  );
}

let rebuiltRoot = "";

describe("published recognition bundles", () => {
  beforeAll(async () => {
    rebuiltRoot = await tempDir("centraid-automation-bundles-");
    await run("bun", ["run", "build-automation-handlers.ts"], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, CENTRAID_AUTOMATION_BUNDLE_ROOT: rebuiltRoot },
    });
    await run(
      path.join(REPO_ROOT, "node_modules/.bin/oxfmt"),
      [
        "-c",
        path.join(REPO_ROOT, "oxfmt.config.ts"),
        "--disable-nested-config",
        "--write",
        path.join(rebuiltRoot, "packages/blueprints/automations"),
      ],
      { cwd: REPO_ROOT }
    );
  }, 120_000);

  it.each(BUNDLE_IDS)(
    "%s: the committed bundle is the build of the committed source",
    async (id) => {
      const [rebuilt, committed] = await Promise.all([
        readFile(bundlePath(rebuiltRoot, id), "utf8"),
        readFile(bundlePath(REPO_ROOT, id), "utf8"),
      ]);

      expect(
        rebuilt,
        `${id}: committed bundle is stale — rerun 'bun run --cwd packages/model-runtime build:automations'`
      ).toBe(committed);
    }
  );

  it("keeps the test-only runtime seam in the shipped bundle", async () => {
    const bundle = await readFile(bundlePath(REPO_ROOT, "transcript"), "utf8");

    expect(bundle).toContain("setTranscriptRuntimeForTests");
  });
});
