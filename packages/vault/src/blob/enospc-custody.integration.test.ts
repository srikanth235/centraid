import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { VaultDiskFullError } from "../errors.js";
import { FsBlobStore } from "./local.js";

let writeSyncShouldFail = false;
vi.mock(import("node:fs"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      if (writeSyncShouldFail) {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      }
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
  };
});

describe("enospc-custody", () => {
  afterEach(() => {
    writeSyncShouldFail = false;
  });

  test("ENOSPC on putSync: VaultDiskFullError, no custody claim, no leftover tmp", async () => {
    const dir = tempDirSync("enospc-custody-");
    const store = new FsBlobStore(dir);
    const sha = "c".repeat(64);
    writeSyncShouldFail = true;
    expect(() => store.putSync(sha, Buffer.from("payload-bytes"))).toThrow(
      VaultDiskFullError
    );
    const fanoutDir = path.join(dir, "sha256", sha.slice(0, 2));
    const leftover = existsSync(fanoutDir) ? readdirSync(fanoutDir) : [];
    expect(leftover).toStrictEqual([]);
    await expect(store.has(sha)).resolves.toBe(false);
  });

  test("successful put after a failed ENOSPC still works on the same store", async () => {
    const dir = tempDirSync("enospc-recover-");
    const store = new FsBlobStore(dir);
    const failSha = "d".repeat(64);
    const okSha = "e".repeat(64);
    writeSyncShouldFail = true;
    expect(() => store.putSync(failSha, Buffer.from("nope"))).toThrow(
      VaultDiskFullError
    );
    writeSyncShouldFail = false;
    store.putSync(okSha, Buffer.from("ok-payload"));
    await expect(store.has(okSha)).resolves.toBe(true);
    await expect(store.has(failSha)).resolves.toBe(false);
  });
});
