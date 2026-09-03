import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveGatewayCliPath } from "./detached-gateway.js";

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe(resolveGatewayCliPath, () => {
  test("@centraid/server exports the ./package.json subpath the resolver needs", () => {
    expect(() =>
      require.resolve("@centraid/server/package.json")
    ).not.toThrow();
  });

  test("the resolved manifest is @centraid/server's own", () => {
    const manifest = require.resolve("@centraid/server/package.json");
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      name?: string;
    };
    expect(parsed.name).toBe("@centraid/server");
  });

  test("the resolved CLI path exists and is the gateway entrypoint", () => {
    const cliPath = resolveGatewayCliPath();
    expect(fs.existsSync(cliPath)).toBe(true);
    expect(cliPath.endsWith(path.join("dist", "cli", "cli.js"))).toBe(true);
  });

  test("the resolved CLI is the file package.json declares as centraid-gateway", () => {
    const manifest = require.resolve("@centraid/server/package.json");
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      bin?: Record<string, string>;
    };
    const declared = path.resolve(
      path.dirname(manifest),
      parsed.bin?.["centraid-gateway"] ?? ""
    );
    expect(fs.realpathSync(resolveGatewayCliPath())).toBe(
      fs.realpathSync(declared)
    );
  });

  test("the monorepo fallback climbs to the repository root, not apps/", () => {
    const fallback = path.resolve(
      import.meta.dirname,
      "../../../../packages/server/dist/cli/cli.js"
    );
    expect(fallback).toBe(
      path.join(repoRoot, "packages", "server", "dist", "cli", "cli.js")
    );
    expect(fs.existsSync(fallback)).toBe(true);

    const threeLevels = path.resolve(
      import.meta.dirname,
      "../../../packages/server/dist/cli/cli.js"
    );
    expect(fs.existsSync(threeLevels)).toBe(false);
  });
});
// @vitest-environment node
