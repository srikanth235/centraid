import { describe, expect, test } from "vitest";

import {
  compareModelIds,
  isSupersededBy,
  makeModelId,
  parseModelId,
} from "./model-id.js";

describe("model-id", () => {
  test("a made id round-trips through the parser", () => {
    const id = makeModelId("clip-vit-b32", 3);
    expect(id).toBe("clip-vit-b32@3");
    expect(parseModelId(id)).toStrictEqual({
      name: "clip-vit-b32",
      version: 3,
    });
  });

  test("a name that would make the separator ambiguous is refused", () => {
    expect(() => makeModelId("clip@vit", 1)).toThrow(/must not contain/u);
    expect(() => makeModelId("", 1)).toThrow(/alphanumeric/u);
    expect(() => makeModelId(" clip", 1)).toThrow(/alphanumeric/u);
  });

  test("a version that is not a positive integer is refused", () => {
    expect(() => makeModelId("clip", 0)).toThrow(/positive integer/u);
    expect(() => makeModelId("clip", -2)).toThrow(/positive integer/u);
    expect(() => makeModelId("clip", 1.5)).toThrow(/positive integer/u);
  });

  test("an id that does not follow the convention parses as null, never as version 0", () => {
    expect(parseModelId("clip")).toBeNull();
    expect(parseModelId("clip@")).toBeNull();
    expect(parseModelId("@3")).toBeNull();
    expect(parseModelId("clip@v3")).toBeNull();
    expect(parseModelId("clip@0")).toBeNull();
    expect(parseModelId("clip@-1")).toBeNull();
  });

  test("versions order within a family and are incomparable across families", () => {
    expect(compareModelIds("clip@1", "clip@2")).toBeLessThan(0);
    expect(compareModelIds("clip@2", "clip@2")).toBe(0);
    expect(compareModelIds("clip@3", "clip@2")).toBeGreaterThan(0);
    expect(compareModelIds("clip@1", "siglip@1")).toBeNull();
    expect(compareModelIds("clip@1", "handwritten")).toBeNull();
  });

  test("only an older version of the SAME family is superseded", () => {
    expect(isSupersededBy("clip@1", "clip@2")).toBe(true);
    expect(isSupersededBy("clip@2", "clip@2")).toBe(false);
    expect(isSupersededBy("clip@3", "clip@2")).toBe(false);
    expect(isSupersededBy("siglip@1", "clip@9")).toBe(false);
    expect(isSupersededBy("legacy-hand-written-key", "clip@9")).toBe(false);
  });

  test("a name may carry dots, dashes and underscores", () => {
    expect(parseModelId("openai.clip_vit-b32@12")).toStrictEqual({
      name: "openai.clip_vit-b32",
      version: 12,
    });
  });
});
