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
 * fixtures/peer-target-golden.json, the shared verdict corpus written so a
 * Rust test CAN read it unchanged (see the file's `_readme`). That reader is
 * not written yet, so the Rust half rests on the transliteration today — the
 * corpus block below says so at length rather than implying a bridge that
 * does not exist.
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

const CORPUS = fileURLToPath(
  new URL("../fixtures/peer-target-corpus.json", import.meta.url)
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
 * Two axes where the two languages could genuinely part company, both modelled
 * here rather than assumed away:
 *
 *  - **length.** Rust's `str::len()` counts UTF-8 BYTES while JS's
 *    `String#length` counts UTF-16 code units, so this model measures bytes
 *    (`TextEncoder`) where the product measures code units. The two agree for
 *    the extension test because the prefix is pure ASCII and any string that
 *    extends it by one code unit also extends it by at least one byte.
 *  - **representability.** A Rust `&str` cannot hold a lone surrogate, so a
 *    target carrying one never reaches `peer_target_allowed` at all. That is
 *    modelled as a refusal, which is what the JS guard now answers too
 *    (#846 P7) — before the fix, JS silently judged the U+FFFD rewrite.
 *
 * Everything else follows the Rust text line for line: `split(['?', '#'])
 * .next()`, the path-length extension test, `bytes().any(...)` over `%`, `\`,
 * and every byte at or below 0x20, then `split('/')` with no `.` or `..`.
 */
function rustModel(target: string): boolean {
  if (!isWellFormedString(target)) return false;
  if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
  const path = target.split(/[?#]/u)[0] ?? "";
  if (utf8.encode(path).length <= utf8.encode(PEER_PLANE_PREFIX).length)
    return false;
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
 * bare prefix names no resource)" applied to the PATH, the byte and
 * dot-segment rules, and — since the contract says "mirrored byte-for-byte in
 * Rust" — representability as a Rust `&str`.
 *
 * Written independently of the product on purpose: it agrees with the product
 * on every input (#846 P6/P7), and it is the independent restatement that
 * keeps them agreeing.
 */
function documentedIntent(target: unknown): boolean {
  if (typeof target !== "string") return false;
  if (!isWellFormedString(target)) return false;
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

/*
 * The committed JS↔Rust bridge (issue #842 W2.1).
 *
 * `peer-target-golden.json` is the CURATED corpus — cases a human thought
 * worth naming, plus the pins. This second corpus is its MACHINE half: a
 * deterministically seeded draw off the same generator, each row carrying the
 * verdict the product guard gives.
 *
 * WHAT THIS DOES AND DOES NOT PROVE TODAY. The Rust side of the bridge is the
 * `rustModel` transliteration below, pinned to the Rust source text so an edit
 * there cannot silently invalidate it. There is NO Rust test reading this file
 * yet — `data-plane/tests/` holds only `golden.rs`, which reads a different
 * fixture. So the corpus is currently a one-language artifact BUILT to be read
 * by a Rust test: every row is representable as a `&str`, and the bytes are
 * deterministic, which is exactly what a future reader needs. Until that
 * reader exists, the cross-language claim rests on the transliteration, not on
 * the compiled guard. Stated here rather than left to be inferred, because a
 * corpus that looks like a bridge and is not one is worse than no corpus.
 *
 * Determinism is the whole point: `fc.sample` is a pure function of (seed,
 * count), so a regenerated corpus is byte-identical on any machine, and CI can
 * diff the committed file against a fresh draw to catch a hand edit.
 */
const CORPUS_SEED = 726_003;
const CORPUS_DRAWS = 700;
const CORPUS_CAP = 480;

interface CorpusRow {
  target: string;
  jsVerdict: boolean;
}

/**
 * `String#isWellFormed` is ES2024 and the tunnel test tsconfig targets an
 * older lib, so we spell the lone-surrogate check out: a string is well-formed
 * iff every high surrogate is followed by a low one and no low surrogate
 * stands alone. A lone surrogate is exactly what a Rust `&str` cannot hold.
 */
function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc_00 || next > 0xdf_ff) return false;
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return false;
    }
  }
  return true;
}

/**
 * Materialise the corpus deterministically. Only WELL-FORMED targets survive:
 * a lone surrogate is not representable as a Rust `&str`, so admitting one into
 * a corpus the Rust lane must read would break the bridge — the JS-only lone-
 * surrogate divergence is pinned above, never smuggled in here.
 */
function generateCorpus(): CorpusRow[] {
  const drawn = fc.sample(adversarialTarget, {
    numRuns: CORPUS_DRAWS,
    seed: CORPUS_SEED,
  });
  const rows: CorpusRow[] = [];
  const seen = new Set<string>();
  for (const target of drawn) {
    if (!isWellFormedString(target) || seen.has(target)) continue;
    seen.add(target);
    rows.push({ target, jsVerdict: isPeerPlaneTarget(target) });
    if (rows.length >= CORPUS_CAP) break;
  }
  return rows;
}

/** One row per line: stable to diff and countable against the 625-line cap. */
function serializeCorpus(rows: CorpusRow[]): string {
  return `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
}

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

  test("the guard matches its documented intent on every input", () => {
    fc.assert(
      fc.property(adversarialTarget, (target) => {
        // No carve-out. Until #846 P6 this property had to skip the
        // bare-prefix-plus-separator class, because that was the one place the
        // product and its own sentence parted company. The product moved, so
        // the exemption goes with it: any future edit that reopens a gap
        // between guard and sentence fails here on the first draw that hits it.
        expect(isPeerPlaneTarget(target)).toBe(documentedIntent(target));
      }),
      { numRuns: 800, seed: 84223 }
    );
  });

  /*
   * REGRESSION LOCK for #846 P6.
   *
   * Both guards document "must EXTEND the prefix (a bare prefix names no
   * resource)", and both apply that test to the PATH, never to the whole
   * target: a lone `?` or `#` is otherwise enough to get the BARE prefix
   * admitted, because `/centraid/_peer/?` is 17 bytes and passes a length
   * test over `target` while the path it resolves to is exactly the prefix.
   * One word in each language: measure `path`, not `target`.
   */
  test("a bare prefix plus a query or fragment is refused", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}?`,
      `${PEER_PLANE_PREFIX}#`,
      `${PEER_PLANE_PREFIX}?next=/centraid/_gateway/devices`,
      `${PEER_PLANE_PREFIX}#/../_gateway`,
    ]) {
      // The path behind each of these IS the bare prefix.
      expect(resolvedPathname(target)).toBe(PEER_PLANE_PREFIX);
      expect(documentedIntent(target)).toBe(false);
      expect(isPeerPlaneTarget(target)).toBe(false);
      expect(rustModel(target)).toBe(false);
      expect(routeLayerModel(target)).toBe(false);
    }
    // The bare prefix itself was always refused, and a real extension carrying
    // a query or fragment is still admitted — the fix is exactly the
    // separator-as-extension class and nothing wider.
    expect(isPeerPlaneTarget(PEER_PLANE_PREFIX)).toBe(false);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}x?a=b`)).toBe(true);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}x#frag`)).toBe(true);
  });

  /*
   * REGRESSION LOCK for #846 P7, formerly the pin
   * `lone-surrogate-admitted-by-js-only`.
   *
   * protocol.ts promises the rule is "mirrored byte-for-byte in Rust", but a
   * JS string can hold a lone surrogate and a Rust `&str` cannot: the JS
   * guard's `Buffer.from(path, "utf8")` silently rewrote it to U+FFFD
   * (EF BF BD), found no forbidden byte, and so ADMITTED a target the Rust
   * lane can never carry — forwarding a target whose bytes are not the ones
   * the peer sent. Rust was the right side of that disagreement: a guard that
   * rewrites its own input before judging it has judged a different string.
   */
  test("the JS guard refuses lone surrogates the Rust lane cannot hold", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}\uD800`,
      `${PEER_PLANE_PREFIX}\uDFFF/x`,
      `${PEER_PLANE_PREFIX}a\uDC00b`,
    ]) {
      // A lone surrogate: matched as its own code point, so a well-formed
      // astral pair never does.
      expect(/\p{Surrogate}/u.test(target)).toBe(true);
      // The utf8 round-trip is a different string: a guard that judged the
      // replacement rather than the input would admit these.
      expect(Buffer.from(target, "utf8").toString("utf8")).not.toBe(target);
      expect(isPeerPlaneTarget(target)).toBe(false);
      expect(documentedIntent(target)).toBe(false);
      expect(rustModel(target)).toBe(false);
      expect(routeLayerModel(target)).toBe(false);
    }
    // Well-formed astral text — a surrogate PAIR — was never part of the
    // defect and must stay admitted: this is a representability rule, not a
    // ban on non-ASCII targets.
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
    for (const vector of golden.vectors) {
      expect(seen.has(vector.name)).toBe(false);
      seen.add(vector.name);
      expect(isPeerPlaneTarget(vector.target)).toBe(vector.allowed);
      expect(rustModel(vector.target)).toBe(vector.allowed);
      expect(routeLayerModel(vector.target)).toBe(vector.allowed);
      // Since #846 P6/P7 there is no pinned vector left: every recorded
      // verdict is also the documented one. A vector that reintroduces a
      // `pin` fails here rather than quietly re-establishing the carve-out.
      expect(vector.pin).toBeUndefined();
      expect(documentedIntent(vector.target)).toBe(vector.allowed);
    }
    expect(Object.keys(golden.pins)).toStrictEqual([]);
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
    // The four separator-as-extension vectors stay in the corpus as the
    // regression lock for #846 P6 — fixed, so they now record `false`.
    expect(golden.vectors.filter((v) => v.pin !== undefined)).toHaveLength(0);
    expect(
      golden.vectors.filter(
        (v) => (v.target.split(/[?#]/u)[0] ?? "") === PEER_PLANE_PREFIX
      ).length
    ).toBeGreaterThanOrEqual(4);
  });

  test("the generated corpus is deterministic and matches the committed file", () => {
    const fresh = serializeCorpus(generateCorpus());
    // Bootstrap / regenerate with CENTRAID_WRITE_PEER_CORPUS=1; the normal run
    // only READS, so a stray edit fails here instead of being overwritten.
    if (process.env.CENTRAID_WRITE_PEER_CORPUS === "1") {
      fs.writeFileSync(CORPUS, fresh);
    }
    expect(fresh).toBe(fs.readFileSync(CORPUS, "utf8"));
    // A second draw at the same seed is byte-identical — a pure function of
    // (seed, count). This is what lets the Rust lane trust the committed file.
    expect(serializeCorpus(generateCorpus())).toBe(fresh);
  });

  test("every generated corpus row is well-formed and self-consistent", () => {
    const rows = JSON.parse(fs.readFileSync(CORPUS, "utf8")) as CorpusRow[];
    expect(rows.length).toBeGreaterThan(200);
    const seen = new Set<string>();
    for (const row of rows) {
      expect(row.target).toBeTypeOf("string");
      // Every target the Rust test will read must be a valid `&str`.
      expect(isWellFormedString(row.target)).toBe(true);
      expect(seen.has(row.target)).toBe(false);
      seen.add(row.target);
      // The recorded verdict is the product guard's own answer, recomputed so
      // a hand-edited corpus cannot silently record a lie for Rust to match.
      expect(row.jsVerdict).toBe(isPeerPlaneTarget(row.target));
      expect(rustModel(row.target)).toBe(row.jsVerdict);
      expect(routeLayerModel(row.target)).toBe(row.jsVerdict);
    }
    // Both verdicts are exercised: an all-reject corpus proves nothing about
    // the accept path the Rust guard must also match.
    expect(rows.some((row) => row.jsVerdict)).toBe(true);
    expect(rows.some((row) => !row.jsVerdict)).toBe(true);
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
    expect(relay).toContain("if !target.starts_with(PEER_PLANE_PREFIX)");
    expect(relay).toContain(".split(['?', '#'])");
    // #846 P6: the extension test measures the PATH. If this line ever reads
    // `target.len()` again, the languages have parted company.
    expect(relay).toContain("if path.len() <= PEER_PLANE_PREFIX.len()");
    expect(relay).not.toContain("target.len() <= PEER_PLANE_PREFIX.len()");
    expect(relay).toContain(
      ".any(|byte| byte == b'%' || byte == b'\\\\' || byte <= 0x20)"
    );
    expect(relay).toContain(
      'path.split(\'/\')\n        .all(|segment| segment != "." && segment != "..")'
    );
  });
});
