import { describe, expect, it } from "vitest";

import { ManifestError } from "./manifest-errors.js";
import {
  validateOutputAgainstSchema,
  validateOutputSchema,
} from "./manifest-output.js";

describe(validateOutputSchema, () => {
  it("returns undefined when the schema is omitted", () => {
    expect(validateOutputSchema(undefined)).toBeUndefined();
  });

  it("rejects non-object roots", () => {
    for (const raw of [null, "x", 1, true, []]) {
      expect(() => validateOutputSchema(raw)).toThrow(ManifestError);
      // Captured outside a catch so the code/field assertion always runs —
      // `thrown` stays undefined if the call silently returns.
      let thrown: unknown;
      try {
        validateOutputSchema(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({
        code: "invalid_output_schema",
        field: "outputSchema",
      });
    }
  });

  it("requires type object", () => {
    expect(() => validateOutputSchema({ type: "string" })).toThrow(
      /type must be "object"/u
    );
  });

  it("accepts a bare object schema", () => {
    expect(validateOutputSchema({ type: "object" })).toStrictEqual({
      type: "object",
    });
  });

  it("validates property type declarations", () => {
    expect(
      validateOutputSchema({
        type: "object",
        properties: { name: { type: "string" }, count: { type: "number" } },
      })
    ).toStrictEqual({
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
    });
  });

  it("rejects bad properties containers", () => {
    expect(() =>
      validateOutputSchema({ type: "object", properties: null })
    ).toThrow(/properties must be an object/u);
    expect(() =>
      validateOutputSchema({ type: "object", properties: [] })
    ).toThrow(/properties must be an object/u);
  });

  it("rejects property entries that are not typed objects", () => {
    expect(() =>
      validateOutputSchema({ type: "object", properties: { a: null } })
    ).toThrow(/must be an object with a "type" field/u);
    expect(() =>
      validateOutputSchema({
        type: "object",
        properties: { a: { type: "bigint" } },
      })
    ).toThrow(/type must be one of/u);
  });

  it("validates required as non-empty strings", () => {
    expect(
      validateOutputSchema({
        type: "object",
        required: ["a", "b"],
        properties: { a: { type: "string" } },
      })
    ).toStrictEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
    });
    expect(() =>
      validateOutputSchema({ type: "object", required: "a" })
    ).toThrow(/required must be an array/u);
    expect(() =>
      validateOutputSchema({ type: "object", required: [""] })
    ).toThrow(/must be a non-empty string/u);
    expect(() =>
      validateOutputSchema({ type: "object", required: [1] })
    ).toThrow(/must be a non-empty string/u);
  });
});

describe(validateOutputAgainstSchema, () => {
  const schema = validateOutputSchema({
    type: "object",
    properties: {
      name: { type: "string" },
      tags: { type: "array" },
      meta: { type: "object" },
      ok: { type: "boolean" },
    },
    required: ["name"],
  })!;

  it("accepts matching objects", () => {
    expect(
      validateOutputAgainstSchema(schema, { name: "x", tags: [], ok: true })
    ).toBeNull();
  });

  it("rejects non-objects with a clear got-type", () => {
    expect(validateOutputAgainstSchema(schema, null)).toMatch(/got null/u);
    expect(validateOutputAgainstSchema(schema, [])).toMatch(/got array/u);
    expect(validateOutputAgainstSchema(schema, "s")).toMatch(/got string/u);
  });

  it("flags missing required keys", () => {
    expect(validateOutputAgainstSchema(schema, { tags: [] })).toMatch(
      /missing required/u
    );
  });

  it("flags type mismatches including array vs object and null", () => {
    expect(
      validateOutputAgainstSchema(schema, { name: "x", tags: "nope" })
    ).toMatch(/expected type array, got string/u);
    expect(
      validateOutputAgainstSchema(schema, { name: "x", meta: null })
    ).toMatch(/expected type object, got null/u);
    expect(validateOutputAgainstSchema(schema, { name: "x", ok: 1 })).toMatch(
      /expected type boolean, got number/u
    );
  });

  it("ignores undeclared and optional-absent properties", () => {
    expect(
      validateOutputAgainstSchema(schema, { name: "x", extra: 1 })
    ).toBeNull();
    expect(
      validateOutputAgainstSchema({ type: "object" }, { anything: true })
    ).toBeNull();
  });
});
