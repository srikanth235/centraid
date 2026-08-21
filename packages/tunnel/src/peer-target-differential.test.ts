/*
 * Peer-plane target differential (issue #842 W2.1).
 *
 * The peer path confinement is written THREE times, in two languages:
 *
 *   1. `peer_target_allowed` — data-plane/src/iroh_relay.rs, the production
 *      relay and the only guard most peer traffic ever meets.
 *   2. `isPeerPlaneTarget` — protocol.ts, the pure-JS endpoint's half, also
 *      re-exported from index.ts and consumed by gateway-endpoint.ts.
 *   3. The route-layer re-check in packages/server/src/routes/peer-plane.ts,
 *      which is a two-step composite (`startsWith` the prefix, THEN the
 *      guard) and is the backstop for a forwarder that forgets.
 *
 * Loosening any one of them is a privilege escalation, and a drift between
 * them fails nowhere but on a real link, in production. The existing suites
 * (`peer-plane.test.ts`, `wire-properties.test.ts`, the Rust unit test, and
 * fixtures/wire-golden.json) pin the cases someone thought of. This file adds
 * the half those cannot: a seeded generator that draws adversarial targets
 * nobody wrote down, and cross-checks every implementation reachable from a
 * vitest process against each other AND against the guards' own documented
 * intent.
 *
 * Mechanism, mirroring `alpn-parity.test.ts`: there is no runtime bridge to
 * the Rust crate, so the Rust half is covered two ways — a transliteration of
 * `peer_target_allowed` on UTF-8 byte semantics (`rustModel`), pinned to the
 * Rust source text so a Rust edit cannot silently invalidate the model, and
 * fixtures/peer-target-golden.json, the shared verdict corpus a Rust test
 * reads unchanged (see the file's `_readme`).
 *
 * Seeds are recorded inline and never randomised: a property suite whose
 * counterexamples cannot be reproduced is an anecdote.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { isPeerPlaneTarget as guardViaPackageEntry } from "./index.js";
import { isPeerPlaneTarget, PEER_PLANE_PREFIX } from "./protocol.js";

const RUST_RELAY = fileURLToPath(
  new URL("../data-plane/src/iroh_relay.rs", import.meta.url)
);

const GOLDEN = fileURLToPath(
  new URL("../fixtures/peer-target-golden.json", import.meta.url)
);

interface GoldenVector {
  name: string;
  target: string;
  allowed: boolean;
  pin?: string;
  note: string;
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as {
  version: number;
  prefix: string;
  pins: Record<string, string[]>;
  vectors: GoldenVector[];
};

const utf8 = new TextEncoder();

/**
 * `peer_target_allowed` transliterated from iroh_relay.rs, deliberately NOT
 * sharing a line with the TypeScript guard.
 *
 * The one axis where the two languages could genuinely part company is length:
 * Rust's `str::len()` counts UTF-8 BYTES while JS's `String#length` counts
 * UTF-16 code units, so this model measures bytes (`TextEncoder`) where the
 * product measures code units. Everything else follows the Rust text line for
 * line: `split(['?', '#']).next()`, `bytes().any(...)` over `%`, `\`, and
 * every byte at or below 0x20, then `split('/')` with no `.` or `..` segment.
 */
function rustModel(target: string): boolean {
  const targetBytes = utf8.encode(target);
  const prefixBytes = utf8.encode(PEER_PLANE_PREFIX);
  if (targetBytes.length <= prefixBytes.length) return false;
  if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
  const path = target.split(/[?#]/u)[0] ?? "";
  for (const byte of utf8.encode(path)) {
    if (byte === 0x25 || byte === 0x5c || byte <= 0x20) return false;
  }
  return path
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

/**
 * The route layer's composite gate (peer-plane.ts), as a verdict: does this
 * target reach a peer-plane route at all? A target that fails `startsWith`
 * falls through the handler entirely and is then refused by the gateway's
 * peer-marked backstop; a target that passes it but fails the guard answers
 * `not_found` on the spot. Both are "not admitted", which is what a
 * differential compares.
 */
function routeLayerModel(target: string): boolean {
  if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
  return isPeerPlaneTarget(target);
}

/**
 * The rule the guards DOCUMENT, in both languages: "must extend the prefix (a
 * bare prefix names no resource)" plus the byte and dot-segment rules. The
 * difference from the product is one word — the extension test is applied to
 * the PATH here, and to the whole target there. See the `pins` block in
 * fixtures/peer-target-golden.json.
 */
function documentedIntent(target: unknown): boolean {
  if (typeof target !== "string") return false;
  if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
  const path = target.split(/[?#]/u)[0] ?? "";
  if (path.length <= PEER_PLANE_PREFIX.length) return false;
  for (const byte of Buffer.from(path, "utf8")) {
    if (byte === 0x25 || byte === 0x5c || byte <= 0x20) return false;
  }
  return path
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

/** Where an admitted target actually lands once a URL parser resolves it. */
function resolvedPathname(target: string): string {
  return new URL(target, "http://gateway.invalid/").pathname;
}

/**
 * Adversarial target generator: every escape hatch the guard names, plus the
 * ones it does not. Pieces are assembled onto a small set of heads so the
 * draws cluster around the prefix boundary, which is where the interesting
 * disagreements live — a uniformly random string is almost never a near-miss.
 */
const adversarialPiece = fc.oneof(
  fc.constantFrom(
    // Percent escapes: single, double, encoded separators, overlong UTF-8.
    "%2e",
    "%2E",
    "%2f",
    "%5c",
    "%252e",
    "%252f",
    "%c0%af",
    "%e0%80%af",
    "%00",
    "%",
    // Dot segments and their near-misses.
    ".",
    "..",
    "...",
    "..;",
    ".;/",
    "..%2f",
    // Separators and control bytes.
    "/",
    "//",
    "\\",
    "\u0000",
    "\u0009",
    "\r\n",
    "\r",
    " ",
    "\u001F",
    "\u007F",
    // Unicode confusables and invisibles: none of these are ASCII '.' or '/'.
    "\u00A0",
    "\u0085",
    "\u2028",
    "⁄",
    "∕",
    "。",
    "．",
    "／",
    "\uFEFF",
    "\u200E",
    // Case games and Unicode case folding traps.
    "_GATEWAY",
    "_gateway",
    "_Peer",
    "İ",
    "K",
    // Authority tricks.
    "@",
    "user@host",
    ":8080",
    "://",
    // Query / fragment separators — the boundary the pinned defect lives on.
    "?",
    "#",
    "?a=b",
    "#frag",
    // Multi-byte and astral text.
    "é",
    "𝕏"
  ),
  fc.string({ minLength: 0, maxLength: 4 })
);

const adversarialTarget = fc
  .tuple(
    fc.constantFrom(
      PEER_PLANE_PREFIX,
      "/centraid/_peer",
      "/centraid/_peer/x",
      "/centraid/_peerish/",
      "/CENTRAID/_PEER/",
      "//centraid/_peer/",
      "/centraid/_gateway/",
      "http://evil.example/centraid/_peer/",
      "/",
      ""
    ),
    fc.array(adversarialPiece, { minLength: 0, maxLength: 8 })
  )
  .map(([head, pieces]) => head + pieces.join(""));

describe("peer-plane target differential", () => {
  test("every reachable implementation returns the same verdict", () => {
    fc.assert(
      fc.property(adversarialTarget, (target) => {
        const verdict = isPeerPlaneTarget(target);
        // The package entry point is what gateway-endpoint.ts and the server
        // route both import; a re-export that ever stopped being the same
        // function would split the JS half in two.
        expect(guardViaPackageEntry(target)).toBe(verdict);
        expect(routeLayerModel(target)).toBe(verdict);
        expect(rustModel(target)).toBe(verdict);
      }),
      { numRuns: 800, seed: 84221 }
    );
  });

  test("an admitted target can never resolve outside the peer plane", () => {
    // The property the guard exists for: `target` is pasted onto the local
    // upstream URL by every forwarder, so whatever a URL parser makes of an
    // ADMITTED target must still be inside the plane.
    fc.assert(
      fc.property(adversarialTarget, (target) => {
        if (!isPeerPlaneTarget(target)) return;
        expect(resolvedPathname(target).startsWith(PEER_PLANE_PREFIX)).toBe(
          true
        );
      }),
      { numRuns: 800, seed: 84222 }
    );
  });

  test("the guard matches its documented intent off the bare-prefix boundary", () => {
    fc.assert(
      fc.property(adversarialTarget, (target) => {
        // The pinned defect below is the ONLY class where product and intent
        // part company. Everywhere else they must agree exactly, so a future
        // edit to either side that widens the gap fails here.
        const path = target.split(/[?#]/u)[0] ?? "";
        if (path === PEER_PLANE_PREFIX) return;
        expect(isPeerPlaneTarget(target)).toBe(documentedIntent(target));
      }),
      { numRuns: 800, seed: 84223 }
    );
  });

  /*
   * PINNED DEFECT (docs/decisions.md, ruling A-pinned) —
   * `bare-prefix-admitted-by-query-or-fragment`.
   *
   * Both guards document, in their own comments, "must EXTEND the prefix (a
   * bare prefix names no resource)". Both then apply that test to the whole
   * target rather than to the path, so appending a query or fragment
   * separator is enough to get the BARE prefix admitted: `/centraid/_peer/?`
   * is 17 bytes, so the length test passes, while the path it resolves to is
   * exactly the prefix.
   *
   * Which side is right: the documented sentence. It is the stated intent in
   * both languages, and the guard is the thing that must match it. This is
   * not an escalation — the resolved pathname stays inside the plane and no
   * peer-plane route matches the bare prefix, so the request dies as
   * `not_found` one layer later — which is why it is pinned rather than
   * fixed here. The fix is one word: test `path.length`, not `target.length`.
   *
   * This test asserts the WRONG behaviour on purpose. The day either guard
   * moves, it goes red and the record is revisited deliberately.
   */
  test("PINNED: a bare prefix plus a query or fragment is wrongly admitted", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}?`,
      `${PEER_PLANE_PREFIX}#`,
      `${PEER_PLANE_PREFIX}?next=/centraid/_gateway/devices`,
      `${PEER_PLANE_PREFIX}#/../_gateway`,
    ]) {
      expect(documentedIntent(target)).toBe(false);
      // Product, all three implementations, disagree with the sentence above.
      expect(isPeerPlaneTarget(target)).toBe(true);
      expect(rustModel(target)).toBe(true);
      expect(routeLayerModel(target)).toBe(true);
      // Bounded: it still names no resource outside the plane.
      expect(resolvedPathname(target)).toBe(PEER_PLANE_PREFIX);
    }
    // The bare prefix without a separator is still refused, so the defect is
    // exactly the separator class and nothing wider.
    expect(isPeerPlaneTarget(PEER_PLANE_PREFIX)).toBe(false);
  });

  /*
   * PINNED DEFECT — `lone-surrogate-admitted-by-js-only`.
   *
   * protocol.ts promises the rule is "mirrored byte-for-byte in Rust", but a
   * JS string can hold a lone surrogate and a Rust `&str` cannot: the JS
   * guard's `Buffer.from(path, "utf8")` silently rewrites it to U+FFFD
   * (EF BF BD) and then finds no forbidden byte, so the JS endpoint ADMITS a
   * target the Rust lane can never carry — and forwards a target whose bytes
   * are not the ones the peer sent.
   *
   * Which side is right: Rust. "Byte-for-byte mirrored" is the documented
   * contract, and a guard that rewrites its own input before judging it has
   * judged a different string. Non-escalating (U+FFFD is neither `%`, `\`,
   * `.` nor `/`), so it is pinned, not fixed.
   */
  test("PINNED: the JS guard admits lone surrogates the Rust lane cannot hold", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}\uD800`,
      `${PEER_PLANE_PREFIX}\uDFFF/x`,
      `${PEER_PLANE_PREFIX}a\uDC00b`,
    ]) {
      expect(target.isWellFormed()).toBe(false);
      expect(isPeerPlaneTarget(target)).toBe(true);
      // What the guard actually judged: the replacement, not the input.
      expect(Buffer.from(target, "utf8").toString("utf8")).not.toBe(target);
    }
    // Well-formed astral text — a surrogate PAIR — is not part of the defect.
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}𝕏`)).toBe(true);
  });

  test("non-string targets are refused by every JS implementation", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.boolean(),
          fc.constant({ toString: () => `${PEER_PLANE_PREFIX}x` }),
          fc.constant([`${PEER_PLANE_PREFIX}x`])
        ),
        (target) => {
          expect(isPeerPlaneTarget(target)).toBe(false);
          expect(guardViaPackageEntry(target)).toBe(false);
          expect(documentedIntent(target)).toBe(false);
        }
      ),
      { numRuns: 60, seed: 84224 }
    );
  });

  test("the shared verdict corpus answers identically in every implementation", () => {
    expect(golden.prefix).toBe(PEER_PLANE_PREFIX);
    expect(golden.vectors.length).toBeGreaterThan(40);
    const seen = new Set<string>();
    const pinned = new Set<string>();
    for (const vector of golden.vectors) {
      expect(seen.has(vector.name)).toBe(false);
      seen.add(vector.name);
      expect(isPeerPlaneTarget(vector.target)).toBe(vector.allowed);
      expect(rustModel(vector.target)).toBe(vector.allowed);
      expect(routeLayerModel(vector.target)).toBe(vector.allowed);
      // A pinned vector is one where the corpus records the WRONG verdict on
      // purpose; every other vector must also match the documented intent.
      expect(documentedIntent(vector.target) === vector.allowed).toBe(
        vector.pin === undefined
      );
      if (vector.pin !== undefined) pinned.add(vector.pin);
    }
    // Every pin id a vector claims is explained in the corpus `pins` block.
    expect(
      [...pinned].filter((id) => golden.pins[id] === undefined)
    ).toStrictEqual([]);
    expect(pinned.size).toBe(1);
  });

  test("the corpus keeps its curated adversarial classes", () => {
    // A corpus that quietly lost its nasty half would still pass every
    // assertion above. Name the classes so a deletion is visible.
    const targets = golden.vectors.map((vector) => vector.target);
    const hasClass = (predicate: (target: string) => boolean): boolean =>
      targets.some(predicate);
    expect(hasClass((t) => t.includes("%252e"))).toBe(true); // double escape
    expect(hasClass((t) => t.includes("%c0%af"))).toBe(true); // overlong UTF-8
    expect(hasClass((t) => t.includes("\u0000"))).toBe(true); // null byte
    expect(hasClass((t) => t.includes("\r\n"))).toBe(true); // CRLF injection
    expect(hasClass((t) => t.includes("．"))).toBe(true); // confusable
    expect(hasClass((t) => t.includes("\\"))).toBe(true); // backslash
    expect(hasClass((t) => t.includes("@") && t.includes(":8080"))).toBe(true); // authority
    expect(hasClass((t) => t === "")).toBe(true); // empty boundary
    expect(hasClass((t) => t === PEER_PLANE_PREFIX)).toBe(true); // prefix boundary
    expect(golden.vectors.filter((v) => v.pin !== undefined)).toHaveLength(4);
  });

  test("the Rust guard still says what rustModel transliterates", () => {
    /*
     * `rustModel` is a hand transliteration, so it is only evidence while the
     * Rust text it mirrors is unchanged. Pin the exact predicate lines — the
     * same reading-the-source technique alpn-parity.test.ts uses, and for the
     * same reason: a hand-copied expectation drifts with the edit that breaks
     * the wire. If this goes red, re-derive `rustModel` from the new source
     * before touching anything else in this file.
     */
    const relay = fs.readFileSync(RUST_RELAY, "utf8");
    expect(relay).toContain("fn peer_target_allowed(target: &str) -> bool");
    expect(relay).toContain(
      "if target.len() <= PEER_PLANE_PREFIX.len() || !target.starts_with(PEER_PLANE_PREFIX)"
    );
    expect(relay).toContain(".split(['?', '#'])");
    expect(relay).toContain(
      ".any(|byte| byte == b'%' || byte == b'\\\\' || byte <= 0x20)"
    );
    expect(relay).toContain(
      'path.split(\'/\')\n        .all(|segment| segment != "." && segment != "..")'
    );
  });
});
