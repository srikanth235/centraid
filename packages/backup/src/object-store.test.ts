import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { assertSafeKey, FsObjectStore } from "./object-store.js";

describe(assertSafeKey, () => {
  test("accepts nested relative keys", () => {
    expect(() => assertSafeKey("chunks/ab/cdef")).not.toThrow();
  });
  test("rejects empty key", () => {
    expect(() => assertSafeKey("")).toThrow("object key must not be empty");
  });
  test("rejects absolute keys", () => {
    expect(() => assertSafeKey("/etc/passwd")).toThrow(
      'object key must be relative: "/etc/passwd"'
    );
  });
  test("rejects traversal segments", () => {
    expect(() => assertSafeKey("../escape")).toThrow(
      'object key must not contain "." or ".." segments: "../escape"'
    );
    expect(() => assertSafeKey("chunks/../../escape")).toThrow(
      'object key must not contain "." or ".." segments: "chunks/../../escape"'
    );
  });
});

describe(FsObjectStore, () => {
  test("put/get roundtrip for a Uint8Array", async () => {
    const store = new FsObjectStore(await tempDir());
    const data = new TextEncoder().encode("hello world");
    await store.put("chunks/a", data);
    expect([...(await store.get("chunks/a"))]).toStrictEqual([...data]);
  });

  test("put accepts an AsyncIterable and streams it to disk", async () => {
    const store = new FsObjectStore(await tempDir());
    async function* gen() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6]);
    }
    await store.put("chunks/streamed", gen());
    expect([...(await store.get("chunks/streamed"))]).toStrictEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  test("creates parent directories as needed", async () => {
    const store = new FsObjectStore(await tempDir());
    await store.put("a/b/c/d.bin", new Uint8Array([9]));
    expect([...(await store.get("a/b/c/d.bin"))]).toStrictEqual([9]);
  });

  test("head returns size for an existing object, null otherwise", async () => {
    const store = new FsObjectStore(await tempDir());
    await store.put("chunks/x", new Uint8Array(42));
    await expect(store.head("chunks/x")).resolves.toStrictEqual({ size: 42 });
    await expect(store.head("chunks/missing")).resolves.toBeNull();
  });

  test("getStream yields the full content across multiple reads", async () => {
    const store = new FsObjectStore(await tempDir());
    const data = new Uint8Array(200_000).map((_, i) => i % 256);
    await store.put("big", data);
    const parts: Uint8Array[] = [];
    for await (const chunk of store.getStream("big")) parts.push(chunk);
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(total).toBe(data.length);
    const reassembled = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      reassembled.set(p, offset);
      offset += p.length;
    }
    expect([...reassembled]).toStrictEqual([...data]);
  });

  test("list yields every object under a prefix with correct sizes", async () => {
    const store = new FsObjectStore(await tempDir());
    await store.put("chunks/a", new Uint8Array(1));
    await store.put("chunks/b", new Uint8Array(2));
    await store.put("manifests/m.json", new Uint8Array(3));
    const chunkKeys: { key: string; size: number }[] = [];
    for await (const obj of store.list("chunks/")) chunkKeys.push(obj);
    expect(chunkKeys.sort((a, b) => a.key.localeCompare(b.key))).toStrictEqual([
      { key: "chunks/a", size: 1 },
      { key: "chunks/b", size: 2 },
    ]);
  });

  test("list on an empty/nonexistent prefix yields nothing without throwing", async () => {
    const store = new FsObjectStore(await tempDir());
    const out: unknown[] = [];
    for await (const obj of store.list("nope/")) out.push(obj);
    expect(out).toStrictEqual([]);
  });

  test("delete is idempotent (no throw on missing key)", async () => {
    const store = new FsObjectStore(await tempDir());
    await expect(store.delete("missing")).resolves.toBeUndefined();
    await store.put("present", new Uint8Array(1));
    await store.delete("present");
    await expect(store.head("present")).resolves.toBeNull();
  });

  test("put is atomic — a crash mid-write never leaves a partial object visible (no temp file leak)", async () => {
    const dir = await tempDir();
    const store = new FsObjectStore(dir);
    await store.put("chunks/atomic", new Uint8Array([1, 2, 3]));
    const entries = await fs.readdir(path.join(dir, "chunks"));
    expect(entries).toStrictEqual(["atomic"]); // no leftover .tmp file
  });

  test("rejects keys that would escape the store root", async () => {
    const store = new FsObjectStore(await tempDir());
    await expect(store.put("../escape", new Uint8Array(1))).rejects.toThrow(
      'object key must not contain "." or ".." segments: "../escape"'
    );
    await expect(store.get("../../etc/passwd")).rejects.toThrow(
      'object key must not contain "." or ".." segments: "../../etc/passwd"'
    );
  });
});
