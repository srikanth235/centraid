import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseManifest } from "./manifest.js";

const require = createRequire(import.meta.url);
const BLUEPRINTS_ROOT = path.dirname(
  require.resolve("@centraid/blueprints/package.json")
);
const AUTOMATIONS_DIR = path.join(BLUEPRINTS_ROOT, "automations");

function templateIds(): string[] {
  return readdirSync(AUTOMATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .toSorted();
}

describe("bundled automation templates", () => {
  const ids = templateIds();
  const pullIds = ids.filter((id) => id.endsWith("-pull"));
  const handlerFnIds = ids.filter((id) => !id.endsWith("-pull"));

  it("finds the bundled template set", () => {
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  it("covers both handler shapes", () => {
    expect(pullIds.length).toBeGreaterThan(0);
    expect(handlerFnIds.length).toBeGreaterThan(0);
  });

  it.each(ids.map((id) => [id] as const))(
    "%s: automation.json parses",
    (id) => {
      const raw = readFileSync(
        path.join(AUTOMATIONS_DIR, id, "automations", id, "automation.json"),
        "utf8"
      );
      const manifest = parseManifest(raw);
      expect(manifest.name.length).toBeGreaterThan(0);
      const needsVault = manifest.triggers.some(
        (t) => t.kind === "condition" || t.kind === "data"
      );
      expect(manifest.vault !== undefined || !needsVault).toBe(true);
    }
  );

  it.each(pullIds.map((id) => [id] as const))(
    "%s: handler.js loads and exports a pull-connector spec",
    async (id) => {
      const file = path.join(
        AUTOMATIONS_DIR,
        id,
        "automations",
        id,
        "handler.js"
      );
      const mod = (await import(`${"file://"}${file}`)) as {
        default?: unknown;
      };
      expect(mod.default).toMatchObject({
        protocol: "centraid.pull/v1",
        principal: expect.any(Function),
        pull: expect.any(Function),
      });
    }
  );

  it.each(handlerFnIds.map((id) => [id] as const))(
    "%s: handler.js loads and exports a handler function",
    async (id) => {
      const file = path.join(
        AUTOMATIONS_DIR,
        id,
        "automations",
        id,
        "handler.js"
      );
      const mod = (await import(`${"file://"}${file}`)) as {
        default?: unknown;
      };
      expect(mod.default).toBeTypeOf("function");
    }
  );
});
