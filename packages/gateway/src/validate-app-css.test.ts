// Publish-time token-purity gate (issue #686 D3). `validateManifestAt` now
// refuses a draft whose CSS restates design tokens, so an agent that ignores
// the UI grounding gets a hard, actionable failure instead of a silently
// off-palette app. The generated `toBlueprintCss()` baseline that
// `scaffoldAppFiles` prepends to `app.css` must NOT be reported as the app's
// own violations — that is the case with the most bricking potential.

import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { scaffoldAppFiles } from "@centraid/blueprints";
import { toBlueprintCss } from "@centraid/design";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { stripGeneratedTokenBaseline } from "./validate-app-css.ts";
import { validateManifestAt } from "./validate-manifest.ts";

let dir: string;

async function writeApp(files: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(dir, "app.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "styled",
      name: "Styled",
      version: "0.1.0",
      actions: [],
      queries: [],
    })
  );
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    })
  );
}

describe("publish-time app CSS token purity", () => {
  beforeEach(async () => {
    dir = await tempDir("centraid-app-css-");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("a freshly scaffolded app publishes clean", async () => {
    // The whole scaffold, verbatim — generated token baseline included.
    await Promise.all(
      scaffoldAppFiles("styled", { name: "Styled" }).map(async (file) => {
        const full = path.join(dir, file.path);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, file.content);
      })
    );
    await expect(validateManifestAt(dir)).resolves.toBeUndefined();
  });

  test("token-only app CSS passes", async () => {
    await writeApp({
      "app.css": `${toBlueprintCss()}\n\n.row {\n  color: var(--text);\n  background: var(--bg-elev);\n  gap: var(--sp-3);\n}\n`,
    });
    await expect(validateManifestAt(dir)).resolves.toBeUndefined();
  });

  test("rejects a hex literal and says which token to use", async () => {
    await writeApp({ "app.css": ".row { color: #3355ff; }\n" });
    const err = await validateManifestAt(dir);
    expect(err).toContain("app.css breaks the design token contract");
    expect(err).toContain("#3355ff");
    expect(err).toContain("var(--text)");
  });

  test("rejects an rgba() literal", async () => {
    await writeApp({
      "styles/panel.css": ".p { background: rgba(0,0,0,.4); }\n",
    });
    const err = await validateManifestAt(dir);
    expect(err).toContain("styles/panel.css");
    expect(err).toContain("rgba(");
    expect(err).toContain("var(--scrim)");
  });

  test("rejects a concrete font stack", async () => {
    await writeApp({
      "app.css": "body { font-family: Helvetica, Arial, sans-serif; }\n",
    });
    const err = await validateManifestAt(dir);
    expect(err).toContain("font-family: Helvetica, Arial, sans-serif");
    expect(err).toContain("var(--font-sans)");
  });

  test("rejects redeclaring a reserved custom property", async () => {
    await writeApp({ "app.css": ":root { --text-soft: var(--text); }\n" });
    const err = await validateManifestAt(dir);
    expect(err).toContain("--text-soft:");
    expect(err).toContain("owned by @centraid/design");
    expect(err).toContain("--app-hue and --app-identity");
  });

  test("an app-authored violation after the generated baseline is still caught", async () => {
    await writeApp({
      "app.css": `${toBlueprintCss()}\n\n.row { color: #010203; }\n`,
    });
    const err = await validateManifestAt(dir);
    expect(err).toContain("#010203");
    // Exactly one finding: the baseline's own literals are not double-counted.
    expect(err).toContain("1 violation");
  });

  test("a manifest problem still surfaces before the CSS problem", async () => {
    await fs.writeFile(path.join(dir, "app.css"), ".row { color: #fff; }\n");
    await expect(validateManifestAt(dir)).resolves.toBe("app.json is missing");
  });

  test("a vendored kit.css is not the app's to police", async () => {
    await writeApp({ "kit.css": ".kit-btn { color: #123456; }\n" });
    await expect(validateManifestAt(dir)).resolves.toBeUndefined();
  });
});

describe("the generated token baseline", () => {
  test("removes the whole emit while preserving line numbers", () => {
    const app = ".row { color: #fff; }\n";
    const stripped = stripGeneratedTokenBaseline(
      `${toBlueprintCss()}\n\n${app}`
    );
    expect(stripped).not.toContain("--c-teal");
    expect(stripped.trim()).toBe(app.trim());
    expect(stripped.split("\n")).toHaveLength(
      `${toBlueprintCss()}\n\n${app}`.split("\n").length
    );
  });

  test("leaves an unmarked stylesheet untouched", () => {
    const css = ":root { --c-teal: #0aa; }\n";
    expect(stripGeneratedTokenBaseline(css)).toBe(css);
  });

  test("stops at the first authored rule, so later token blocks are scanned", () => {
    const stripped = stripGeneratedTokenBaseline(
      "/* Generated by @centraid/design's toBlueprintCss() */\n" +
        ":root { --c-teal: #0aa; }\n" +
        ".row { color: var(--text); }\n" +
        ":root { --c-rose: #f00; }\n"
    );
    expect(stripped).not.toContain("--c-teal");
    expect(stripped).toContain("--c-rose");
  });
});
