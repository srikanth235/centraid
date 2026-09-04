import { describe, expect, test } from "vitest";

import { cloneTemplateFiles } from "@centraid/blueprints";
import type { ScaffoldFile } from "@centraid/blueprints";
import { recordQualityResult } from "@centraid/test-kit/quality-result";

const OWNER = "tests/scale/blueprint-clones.scale.test.ts";
const APPS = 1_000;

// An automation template's shape: the manifest, the handler, and the wrapping
// app.json — the file map `POST /centraid/_apps/_clone` actually rewrites.
const TEMPLATE_FILES: ScaffoldFile[] = [
  {
    path: "app.json",
    content:
      JSON.stringify(
        {
          manifestVersion: 1,
          id: "template",
          name: "Template",
          kind: "automation",
          version: "0.1.0",
          actions: [],
          queries: [],
        },
        null,
        2
      ) + "\n",
  },
  {
    path: "package.json",
    content: JSON.stringify({ name: "centraid-app-template" }, null, 2) + "\n",
  },
  {
    path: "automations/template/automation.json",
    content:
      JSON.stringify(
        {
          name: "Template",
          version: "0.1.0",
          enabled: false,
          prompt: "do the thing",
          triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        },
        null,
        2
      ) + "\n",
  },
  {
    path: "automations/template/handler.js",
    content: 'export default async () => ({ summary: "ok" });\n',
  },
];

describe("blueprint-clones.scale", () => {
  test("clones a template at multi-app catalog volume", async () => {
    const templateFiles = TEMPLATE_FILES;
    const started = performance.now();
    const clones = Array.from({ length: APPS }, (_, index) =>
      cloneTemplateFiles({
        newAppId: `clone-${index}`,
        newName: `Clone ${index}`,
        templateFiles,
      })
    );
    const durationMs = performance.now() - started;
    // Published, not gated (#927): the paired candidate/PR run compares two
    // trees; a threshold on one sample here would fence the runner.
    const passed = true;
    expect(clones).toHaveLength(APPS);
    expect(
      clones.every((files) => files.some((file) => file.path === "app.json"))
    ).toBe(true);
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `${APPS} in-memory blueprint clones`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
        },
        { name: "apps", value: APPS, unit: "count" },
      ],
    });
    expect(passed).toBe(true);
  });
});
