// The phone's seat driver has one job the other two seats' drivers do not:
// expo-sqlite CANNOT BIND A `bigint`, and a JS number crosses its bridge as a
// Double, so the 64-bit integers the log preserves would silently round. These
// are the tests for the rewrite that keeps them exact.
import { describe, expect, it, vi } from "vitest";

vi.mock(import("expo-sqlite"), () => ({}) as never);

const { bindWideIntegers } = await import("./expo-seat-driver");

describe("binding a 64-bit integer through expo-sqlite", () => {
  it("leaves SQL and binds untouched when nothing is wide", () => {
    const [sql, params] = bindWideIntegers("SELECT ? , ?", ["a", 1]);
    expect(sql).toBe("SELECT ? , ?");
    expect(params).toStrictEqual(["a", 1]);
  });

  it("wraps ONLY the placeholder that takes the wide integer", () => {
    const [sql, params] = bindWideIntegers(
      "INSERT INTO t (a, b, c) VALUES (?, ?, ?)",
      ["a", 9007199254740993n, new Uint8Array([1])]
    );
    expect(sql).toBe(
      "INSERT INTO t (a, b, c) VALUES (?, CAST(? AS INTEGER), ?)"
    );
    expect(params[1]).toBe("9007199254740993");
    expect(params[2]).toBeInstanceOf(Uint8Array);
  });

  it("carries the whole 64-bit range as digits, which a Double could not", () => {
    const [, params] = bindWideIntegers("SELECT ?", [9223372036854775807n]);
    expect(params[0]).toBe("9223372036854775807");
    expect(BigInt(params[0] as string)).toBe(9223372036854775807n);
  });

  it("does not count a `?` inside a string literal as a placeholder", () => {
    const [sql, params] = bindWideIntegers("INSERT INTO t VALUES ('why?', ?)", [
      7n,
    ]);
    expect(sql).toBe("INSERT INTO t VALUES ('why?', CAST(? AS INTEGER))");
    expect(params).toStrictEqual(["7"]);
  });

  it("does not count a `?` inside a doubled-quote literal, an identifier or a comment", () => {
    const [sql] = bindWideIntegers(
      `-- ?\nINSERT INTO "q?" VALUES ('it''s ?', /* ? */ ?)`,
      [7n]
    );
    expect(sql).toBe(
      `-- ?\nINSERT INTO "q?" VALUES ('it''s ?', /* ? */ CAST(? AS INTEGER))`
    );
  });

  it("refuses a numbered parameter rather than guessing which value it takes", () => {
    expect(() => bindWideIntegers("SELECT ?1", [7n])).toThrow(
      /numbered SQL parameters/u
    );
  });

  it("refuses a bind count that does not match the placeholders", () => {
    expect(() => bindWideIntegers("SELECT ?", [7n, 8n])).toThrow(
      /2 bind values for 1 placeholders/u
    );
  });
});
