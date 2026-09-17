import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { runSyncVersions } from "./sync-versions.mjs";

// The contract: every workspace package that tracked the root version moves
// with it, and the build number is reported rather than written.
function scaffold(version) {
  const root = tempDirSync("sync-versions-");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "centraid", version }) + "\n"
  );
  mkdirSync(path.join(root, "desktop/electron"), { recursive: true });
  writeFileSync(
    path.join(root, "desktop/electron/package.json"),
    JSON.stringify({ name: "@centraid/desktop", version }) + "\n"
  );
  mkdirSync(path.join(root, "packages/pinned"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/pinned/package.json"),
    JSON.stringify({ name: "@centraid/pinned", version: "9.9.9" }) + "\n"
  );
  return root;
}

describe("sync-versions", () => {
  it("stamps every workspace that tracked the root version, and only those", () => {
    const root = scaffold("0.1.0");
    const r = runSyncVersions({ rootDir: root, version: "0.2.1" });
    expect(r.version).toBe("0.2.1");
    expect(r.build).toBe(2001);
    expect(r.workspaces).toStrictEqual([
      "package.json",
      "desktop/electron/package.json",
    ]);
    const desktop = JSON.parse(
      readFileSync(path.join(root, "desktop/electron/package.json"), "utf8")
    );
    expect(desktop.version).toBe("0.2.1");
    const pinned = JSON.parse(
      readFileSync(path.join(root, "packages/pinned/package.json"), "utf8")
    );
    expect(pinned.version).toBe("9.9.9");
  });

  it("writes nothing under --dry-run", () => {
    const root = scaffold("0.1.0");
    runSyncVersions({ rootDir: root, version: "0.2.1", dryRun: true });
    const rootPkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8")
    );
    expect(rootPkg.version).toBe("0.1.0");
  });

  it("refuses an unparseable version", () => {
    const root = scaffold("0.1.0");
    expect(() => runSyncVersions({ rootDir: root, version: "v1" })).toThrow(
      /unparseable/u
    );
  });
});
