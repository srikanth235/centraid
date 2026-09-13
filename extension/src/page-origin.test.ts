import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isEligiblePageUrl,
  isLoopback,
  lockerGestureRefusal,
  pageOrigin,
} from "./page-origin.js";

interface Vector {
  readonly name: string;
  readonly stored: string;
  readonly page: string;
  readonly policy: string;
  readonly match: boolean;
}

const vectors = (
  JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../contracts/origin-matching-v1.json"
      ),
      "utf8"
    )
  ) as { vectors: Vector[] }
).vectors;

describe("the promoted spec's eligibility half", () => {
  /*
   * The extension no longer decides whether a stored login matches a page —
   * that moved to the seat and to `crates/apps/locker` (D-1020-X8). What it still
   * owns is whether Locker may run on the page at all, and every one of the
   * spec's 24 vectors exercises a real page URL, so they are the corpus for it.
   *
   * A vector that MATCHES must be eligible: a policy that says "fill this" for a
   * page the extension would refuse to act on is a contradiction between the two
   * halves, and this is where it would show.
   */
  it("has the spec's own 24 vectors", () => {
    expect(vectors).toHaveLength(24);
  });

  it("judges every matching vector's page eligible", () => {
    for (const vector of vectors) {
      if (!vector.match) continue;
      expect(isEligiblePageUrl(vector.page)).toBe(true);
      expect(isEligiblePageUrl(vector.stored)).toBe(true);
    }
  });

  it("normalises every eligible page to an origin with no path", () => {
    for (const vector of vectors) {
      const origin = pageOrigin(vector.page);
      if (origin === undefined) continue;
      expect(origin).not.toContain("?");
      expect(new URL(vector.page).origin).toBe(origin);
    }
  });
});

describe("loopback is the one HTTP exception", () => {
  it("is true only for real loopback", () => {
    for (const host of [
      "localhost",
      "::1",
      "[::1]",
      "127.0.0.1",
      "127.9.9.9",
    ]) {
      expect(isLoopback(host)).toBe(true);
    }
    // THE THREE CASES THE RULE EXISTS FOR.
    for (const host of [
      "127.0.0.1.evil.test",
      "127.foo.bar",
      "notlocalhost",
      "localhost.evil.test",
      "128.0.0.1",
      "127.0.0.256",
    ]) {
      expect(isLoopback(host)).toBe(false);
    }
  });

  it("admits http only on loopback", () => {
    expect(isEligiblePageUrl("http://localhost:5173/app")).toBe(true);
    expect(isEligiblePageUrl("http://127.0.0.1:8080/")).toBe(true);
    expect(isEligiblePageUrl("http://www.bank.example")).toBe(false);
    expect(isEligiblePageUrl("http://127.0.0.1.evil.test")).toBe(false);
  });

  it("admits nothing that is not http(s)", () => {
    for (const raw of [
      "file:///etc/passwd",
      "about:blank",
      "chrome-extension://abc/popup.html",
      `${"java"}${"script"}:alert(1)`,
      "",
      "bank.example",
    ]) {
      expect(isEligiblePageUrl(raw)).toBe(false);
      expect(pageOrigin(raw)).toBeUndefined();
    }
  });
});

describe("the Locker gesture's three refusals", () => {
  const top = {
    method: "locker:candidates",
    frameId: 0,
    pageUrl: "https://www.bank.example/sign-in",
    tabUrl: "https://www.bank.example/sign-in",
  };

  it("accepts a top-level eligible page whose origin is the tab's", () => {
    expect(lockerGestureRefusal(top)).toBeUndefined();
  });

  it("refuses a subframe", () => {
    expect(lockerGestureRefusal({ ...top, frameId: 3 })).toMatch(/top-level/u);
  });

  it("refuses a page that is not the active tab's origin", () => {
    expect(
      lockerGestureRefusal({ ...top, tabUrl: "https://attacker.test/" })
    ).toMatch(/does not match/u);
  });

  it("refuses an ineligible page", () => {
    expect(
      lockerGestureRefusal({
        ...top,
        pageUrl: "http://www.bank.example/",
        tabUrl: "http://www.bank.example/",
      })
    ).toMatch(/HTTPS/u);
  });

  it("is not a gate on anything but Locker", () => {
    expect(
      lockerGestureRefusal({ ...top, method: "capture:task", frameId: 9 })
    ).toBeUndefined();
  });
});
