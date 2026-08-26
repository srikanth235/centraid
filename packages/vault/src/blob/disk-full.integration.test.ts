import { execFileSync } from "node:child_process";
// REAL disk-full round-trip (#351): putSync against an ACTUAL full APFS
// volume (hdiutil) — genuine ENOSPC. Gated behind CENTRAID_DISKFULL_E2E=1
// (darwin only); hdiutil scratch is always cleaned up in a finally.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { VaultDiskFullError } from "../errors.js";
import { FsBlobStore } from "./local.js";

vi.setConfig({ testTimeout: 30_000 });

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("disk-full", () => {
  test("FsBlobStore.putSync against a REAL full filesystem: ENOSPC, no leftover tmp file, VaultDiskFullError", (t) => {
    if (process.platform !== "darwin") {
      t.skip("disk-full e2e only runs on darwin (hdiutil)");
      return;
    }
    if (process.env.CENTRAID_DISKFULL_E2E !== "1") {
      t.skip(
        "set CENTRAID_DISKFULL_E2E=1 (on darwin) to run the real hdiutil disk-full e2e"
      );
      return;
    }

    const work = tempDirSync("centraid-diskfull-e2e-");
    const image = path.join(work, "diskfull.dmg");
    const mount = path.join(work, "mnt");
    mkdirSync(mount, { recursive: true });
    let attached = false;

    try {
      execFileSync("hdiutil", [
        "create",
        "-size",
        "5m",
        "-fs",
        "APFS",
        "-volname",
        "CentraidDiskFullE2E",
        "-quiet",
        image,
      ]);
      execFileSync("hdiutil", [
        "attach",
        image,
        "-mountpoint",
        mount,
        "-nobrowse",
      ]);
      attached = true;

      const store = new FsBlobStore(mount);
      // Fill with distinct 1 MiB blobs until one write genuinely ENOSPCs.
      let failure: unknown;
      for (let i = 0; i < 64 && failure === undefined; i++) {
        const sha = i.toString(16).padStart(64, "0");
        const bytes = Buffer.alloc(1024 * 1024, i);
        try {
          store.putSync(sha, bytes);
        } catch (error) {
          failure = error;
        }
      }

      expect(failure).toBeDefined();
      expect(failure).toBeInstanceOf(VaultDiskFullError);
      expect((failure as VaultDiskFullError).context).toBe("blob CAS write");

      // No stray `.tmp` anywhere under the fan-out tree.
      const strayTmp = listFilesRecursive(mount).filter((f) =>
        f.endsWith(".tmp")
      );
      expect(strayTmp).toStrictEqual([]);
    } finally {
      if (attached) {
        try {
          execFileSync("hdiutil", ["detach", mount, "-force"]);
        } catch {
          /* best-effort — a leaked test volume from a killed run is a known cost */
        }
      }
      rmSync(work, { recursive: true, force: true });
    }
  });
});
