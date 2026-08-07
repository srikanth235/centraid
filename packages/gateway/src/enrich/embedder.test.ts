// The external embedder contract (issue #721 E2) against a REAL child
// process — the stub program in embedder.test-fixtures.ts. Mocking the spawn
// would test nothing that matters here: the whole point of this module is that
// a foreign program's argv, stdin, stdout and exit code become a validated
// vector or a refusal.

import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  DEFAULT_EMBEDDER_MODEL,
  parseEmbedderOutput,
  resolveEmbedder,
} from "./embedder.js";
import {
  STUB_DIM,
  stubVectorFor,
  writeStubEmbedder,
} from "./embedder.test-fixtures.js";

describe("embedder", () => {
  test("an unconfigured host resolves no embedder at all", () => {
    expect(resolveEmbedder({})).toBeNull();
    expect(resolveEmbedder({ CENTRAID_EMBEDDER_PATH: "   " })).toBeNull();
  });

  test("image and text modes both return a vector from the same program", async () => {
    const dir = await tempDir("embedder-");
    const embedder = resolveEmbedder({
      CENTRAID_EMBEDDER_PATH: await writeStubEmbedder(dir),
    });
    expect(embedder).not.toBeNull();
    const image = Buffer.from([10, 20, 30, 40, 50]);
    await expect(embedder!.embedImage(image)).resolves.toStrictEqual(
      stubVectorFor(image)
    );
    await expect(
      embedder!.embedText("a dog on a beach")
    ).resolves.toStrictEqual(stubVectorFor("a dog on a beach"));
    await expect(embedder!.embedImage(image)).resolves.toHaveLength(STUB_DIM);
  });

  test("a non-zero exit becomes an error carrying the program's own words", async () => {
    const dir = await tempDir("embedder-fail-");
    const embedder = resolveEmbedder({
      CENTRAID_EMBEDDER_PATH: await writeStubEmbedder(dir),
    });
    // The child inherits this process's environment, which is how the stub is
    // told to fail — the same way a real embedder's own config would reach it.
    process.env.CENTRAID_STUB_EMBEDDER_FAIL = "1";
    try {
      await expect(embedder!.embedText("anything")).rejects.toThrow(
        /refuses this input/u
      );
    } finally {
      delete process.env.CENTRAID_STUB_EMBEDDER_FAIL;
    }
  });

  test("a program that is not there fails rather than returning a fake vector", async () => {
    const embedder = resolveEmbedder({
      CENTRAID_EMBEDDER_PATH: "/no/such/embedder",
    });
    await expect(embedder!.embedText("anything")).rejects.toThrow(/ENOENT/u);
  });

  test("output that is not a usable vector is refused at the boundary", async () => {
    const dir = await tempDir("embedder-garbage-");
    const file = path.join(dir, "garbage");
    await fs.writeFile(file, "#!/bin/sh\nprintf 'not json'\n");
    await fs.chmod(file, 0o755);
    const embedder = resolveEmbedder({ CENTRAID_EMBEDDER_PATH: file });
    await expect(embedder!.embedText("anything")).rejects.toThrow(
      /unusable output/u
    );
  });

  test("a model id that does not carry a version is replaced, never stored", () => {
    expect(
      resolveEmbedder({
        CENTRAID_EMBEDDER_PATH: "/bin/true",
        CENTRAID_EMBEDDER_MODEL: "my model (final)",
      })!.model
    ).toBe(DEFAULT_EMBEDDER_MODEL);
    expect(
      resolveEmbedder({
        CENTRAID_EMBEDDER_PATH: "/bin/true",
        CENTRAID_EMBEDDER_MODEL: "siglip-so400m@4",
      })!.model
    ).toBe("siglip-so400m@4");
  });

  describe("stdout parsing", () => {
    test("accepts both a bare array and a {vector} envelope", () => {
      expect(parseEmbedderOutput("[1, 2, 3]")).toStrictEqual([1, 2, 3]);
      expect(parseEmbedderOutput('{"vector":[1,2,3]}')).toStrictEqual([
        1, 2, 3,
      ]);
    });

    test("refuses an empty vector, a non-array, and non-finite values", () => {
      expect(() => parseEmbedderOutput("[]")).toThrow(/dimensions/u);
      expect(() => parseEmbedderOutput('{"vector":"nope"}')).toThrow(
        /JSON array/u
      );
      expect(() => parseEmbedderOutput("[1, null, 3]")).toThrow(/non-finite/u);
      expect(() => parseEmbedderOutput('[1, "2"]')).toThrow(/non-finite/u);
    });

    test("refuses more dimensions than the ledger row accepts", () => {
      const oversized = JSON.stringify(Array.from({ length: 4097 }, () => 0.1));
      expect(() => parseEmbedderOutput(oversized)).toThrow(/1\.\.4096/u);
    });
  });
});
