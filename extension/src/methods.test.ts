import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isIdempotent,
  isMethod,
  MAX_FRAME_BYTES,
  METHOD_NAMES,
  METHODS,
  methodRow,
  readsPage,
  stagesBytes,
} from "./methods.js";

describe("the closed method table", () => {
  /*
   * EIGHTEEN, AND THE CENSUS SAYS SEVENTEEN. `handleCompanionRequest` has
   * eighteen `case` arms; census §E2 calls them "the 17 companion methods" and
   * then lists eighteen. The generator asserts the count, and so does this.
   */
  it("is v0's eighteen, in v0's order", () => {
    expect(METHOD_NAMES).toStrictEqual([
      "status",
      "pair",
      "select-vault",
      "unpair",
      "lock",
      "unlock",
      "warm",
      "modules",
      "blocking-count",
      "locker:candidates",
      "locker:fill",
      "locker:save",
      "capture:task",
      "capture:note",
      "capture:document",
      "agenda:add",
      "people:add",
      "page:capture",
    ]);
  });

  it("knows a name or does not, with no near misses", () => {
    for (const name of METHOD_NAMES) expect(isMethod(name)).toBe(true);
    for (const bad of [
      "locker.fill",
      "LOCKER:FILL",
      "status ",
      "",
      "page:captures",
      undefined,
      null,
      42,
    ]) {
      expect(isMethod(bad)).toBe(false);
    }
  });

  /*
   * THE RETRY RULE'S TEETH. `locker:fill` and `locker:candidates` LOOK like
   * reads and are `POST`s in v0 (`appRead` is a POST, `transport.ts:198`), so
   * neither is idempotent — and post-wave-4 a fill writes a reveal receipt, so a
   * rule that retried it on any failure would receipt one gesture three times.
   */
  it("does not call a fill idempotent", () => {
    expect(isIdempotent("locker:fill")).toBe(false);
    expect(isIdempotent("locker:candidates")).toBe(false);
    expect(isIdempotent("locker:save")).toBe(false);
    expect(isIdempotent("warm")).toBe(true);
    expect(isIdempotent("status")).toBe(true);
    // An unknown name is not retryable: repeating it will not fix a version
    // mismatch.
    expect(isIdempotent("locker:reveal")).toBe(false);
  });

  it("carries v0's own request fields", () => {
    expect(
      methodRow("locker:fill")?.fields.map((field) => field.name)
    ).toStrictEqual(["itemId", "pageUrl"]);
    const role = methodRow("people:add")?.fields.find(
      (field) => field.name === "role"
    );
    expect(role?.optional).toBe(true);
  });

  it("marks the page-reading and byte-carrying methods", () => {
    expect(METHOD_NAMES.filter((name) => stagesBytes(name))).toStrictEqual([
      "capture:document",
    ]);
    expect(readsPage("page:capture")).toBe(true);
    expect(readsPage("locker:fill")).toBe(true);
    expect(readsPage("agenda:add")).toBe(false);
  });

  it("names the write each method lands on, or none", () => {
    expect(methodRow("locker:save")?.writes).toStrictEqual({
      app: "locker",
      action: "add-item",
    });
    expect(methodRow("status")?.writes).toBeNull();
  });

  it("states the browser's ceiling once", () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  /*
   * TWO FILES, ONE FACT. The contract is what the native host compiles in and
   * what the lint reads; `methods-table.ts` is the shipped copy a bundler-free
   * service worker can import. Both are written by one generator run, and this is
   * what makes that a claim rather than a hope.
   */
  it("is byte-equal in content to the contract the host compiles in", () => {
    const contract = JSON.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../contracts/extension/methods.json"
        ),
        "utf8"
      )
    ) as { methods: unknown[]; max_frame_bytes: number };
    expect(METHODS).toStrictEqual(contract.methods);
    expect(MAX_FRAME_BYTES).toBe(contract.max_frame_bytes);
  });

  it("has one row per name and no duplicates", () => {
    expect(new Set(METHOD_NAMES).size).toBe(METHODS.length);
    expect(METHODS).toHaveLength(18);
  });
});
