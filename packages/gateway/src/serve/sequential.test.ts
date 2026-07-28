import { describe, expect, it } from "vitest";

import { findSequentially, forEachSequentially } from "./sequential.js";

describe("sequential async primitives", () => {
  it("visits each value in order", async () => {
    const visited: number[] = [];

    await forEachSequentially([1, 2, 3], async (value) => {
      await Promise.resolve();
      visited.push(value);
    });

    expect(visited).toStrictEqual([1, 2, 3]);
  });

  it("does not treat an undefined value as the end of the sequence", async () => {
    const visited: Array<string | undefined> = [];

    await findSequentially<string | undefined>([undefined, "next"], (value) => {
      visited.push(value);
      return value === "next";
    });

    expect(visited).toStrictEqual([undefined, "next"]);
  });
});
