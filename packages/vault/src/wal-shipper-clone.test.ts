import { randomBytes } from "node:crypto";
import {
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { cloneDbFile } from "./wal-shipper.js";

const MiB = 1024 * 1024;
const SIZE = 128 * MiB;

let root: string;

describe("wal-shipper-clone", () => {
  beforeEach(() => {
    root = tempDirSync("wal-clone-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function freeBytes(p: string): number {
    const fs = statfsSync(p);
    return Number(fs.bsize) * Number(fs.bavail);
  }

  test.skipIf(process.platform !== "darwin")(
    "the base clone is a reflink: cloning a 128 MiB database consumes no new disk",
    () => {
      const src = path.join(root, "vault.db");
      writeFileSync(src, randomBytes(SIZE));

      const before = freeBytes(root);
      const dst = path.join(root, "base.db");
      expect(cloneDbFile(src, dst)).toBe(true);
      const consumed = before - freeBytes(root);

      expect(statSync(dst).size).toBe(SIZE);
      expect(consumed).toBeLessThan(SIZE / 4);
    }
  );

  test("the clone is byte-identical to the source, reflink or not", () => {
    const src = path.join(root, "vault.db");
    const bytes = randomBytes(4 * MiB);
    writeFileSync(src, bytes);

    const dst = path.join(root, "base.db");
    const reflinked = cloneDbFile(src, dst);

    expect(statSync(dst).size).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(bytes), readFileSync(dst))).toBe(0);
    expect(reflinked).toBeTypeOf("boolean");
  });
});
