/*
 * Peer-plane target differential (#842). The path confinement is written THREE
 * times in two languages, so loosening any one is a privilege escalation and
 * drift fails nowhere but on a real link. There is no runtime bridge to the
 * Rust crate, so its half rests on `rustModel`, a transliteration PINNED to
 * the Rust source. Seeds are inline and NEVER randomised.
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
 * Transliterated from iroh_relay.rs, deliberately NOT sharing a line with the
 * TypeScript guard. Two axes are modelled rather than assumed away: LENGTH
 * (Rust counts UTF-8 bytes, JS counts UTF-16 code units) and REPRESENTABILITY
 * (a Rust `&str` cannot hold a lone surrogate, modelled as a refusal — never a
 * verdict on the U+FFFD rewrite, #846).
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

function routeLayerModel(target: string): boolean {
  if (!target.startsWith(PEER_PLANE_PREFIX)) return false;
  return isPeerPlaneTarget(target);
}

/** Written independently of the product ON PURPOSE: the restatement is what
 *  keeps them agreeing. */
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

function resolvedPathname(target: string): string {
  return new URL(target, "http://gateway.invalid/").pathname;
}

/** Draws cluster around the PREFIX BOUNDARY. */
const adversarialPiece = fc.oneof(
  fc.constantFrom(
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
    ".",
    "..",
    "...",
    "..;",
    ".;/",
    "..%2f",
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
    "_GATEWAY",
    "_gateway",
    "_Peer",
    "İ",
    "K",
    "@",
    "user@host",
    ":8080",
    "://",
    "?",
    "#",
    "?a=b",
    "#frag",
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
 * The MACHINE half of the corpus. NO Rust test reads it yet, so the
 * cross-language claim rests on `rustModel`, not the compiled guard — a corpus
 * that looks like a bridge and is not one is worse than none.
 */
const CORPUS_SEED = 726_003;
const CORPUS_DRAWS = 700;
const CORPUS_CAP = 480;

interface CorpusRow {
  target: string;
  jsVerdict: boolean;
}

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

/** Only WELL-FORMED targets survive: the JS-only divergence is pinned above,
 *  never smuggled into the corpus Rust must read. */
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

function serializeCorpus(rows: CorpusRow[]): string {
  return `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
}

describe("peer-plane target differential", () => {
  test("every reachable implementation returns the same verdict", () => {
    fc.assert(
      fc.property(adversarialTarget, (target) => {
        const verdict = isPeerPlaneTarget(target);
        // A re-export that drifted would split the JS half in two.
        expect(guardViaPackageEntry(target)).toBe(verdict);
        expect(routeLayerModel(target)).toBe(verdict);
        expect(rustModel(target)).toBe(verdict);
      }),
      { numRuns: 800, seed: 84221 }
    );
  });

  test("an admitted target can never resolve outside the peer plane", () => {
    // The property the guard EXISTS for: every forwarder pastes `target` onto
    // the upstream URL, so a URL parser's reading must stay inside the plane.
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
        // NO carve-out (#846): any edit reopening a gap fails on the first
        // draw that hits it.
        expect(isPeerPlaneTarget(target)).toBe(documentedIntent(target));
      }),
      { numRuns: 800, seed: 84223 }
    );
  });

  /*
   * REGRESSION LOCK (#846 P6). The extension test applies to the PATH, never
   * the whole target: a lone `?` or `#` otherwise gets the BARE prefix
   * admitted. One word in each language: measure `path`.
   */
  test("a bare prefix plus a query or fragment is refused", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}?`,
      `${PEER_PLANE_PREFIX}#`,
      `${PEER_PLANE_PREFIX}?next=/centraid/_gateway/devices`,
      `${PEER_PLANE_PREFIX}#/../_gateway`,
    ]) {
      expect(resolvedPathname(target)).toBe(PEER_PLANE_PREFIX);
      expect(documentedIntent(target)).toBe(false);
      expect(isPeerPlaneTarget(target)).toBe(false);
      expect(rustModel(target)).toBe(false);
      expect(routeLayerModel(target)).toBe(false);
    }
    expect(isPeerPlaneTarget(PEER_PLANE_PREFIX)).toBe(false);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}x?a=b`)).toBe(true);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}x#frag`)).toBe(true);
  });

  /*
   * REGRESSION LOCK (#846 P7). A utf8 round-trip silently rewrites a lone
   * surrogate to U+FFFD, finds no forbidden byte, and ADMITS a target the Rust
   * lane can never carry. A guard that rewrites its own input has judged a
   * different string.
   */
  test("the JS guard refuses lone surrogates the Rust lane cannot hold", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}\uD800`,
      `${PEER_PLANE_PREFIX}\uDFFF/x`,
      `${PEER_PLANE_PREFIX}a\uDC00b`,
    ]) {
      expect(/\p{Surrogate}/u.test(target)).toBe(true);
      expect(Buffer.from(target, "utf8").toString("utf8")).not.toBe(target);
      expect(isPeerPlaneTarget(target)).toBe(false);
      expect(documentedIntent(target)).toBe(false);
      expect(rustModel(target)).toBe(false);
      expect(routeLayerModel(target)).toBe(false);
    }
    // A surrogate PAIR stays admitted: a representability rule, not a ban on
    // non-ASCII targets.
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
      // A vector reintroducing a `pin` fails here rather than quietly
      // re-establishing the carve-out (#846).
      expect(vector.pin).toBeUndefined();
      expect(documentedIntent(vector.target)).toBe(vector.allowed);
    }
    expect(Object.keys(golden.pins)).toStrictEqual([]);
  });

  test("the corpus keeps its curated adversarial classes", () => {
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
    expect(golden.vectors.filter((v) => v.pin !== undefined)).toHaveLength(0);
    expect(
      golden.vectors.filter(
        (v) => (v.target.split(/[?#]/u)[0] ?? "") === PEER_PLANE_PREFIX
      ).length
    ).toBeGreaterThanOrEqual(4);
  });

  test("the generated corpus is deterministic and matches the committed file", () => {
    const fresh = serializeCorpus(generateCorpus());
    if (process.env.CENTRAID_WRITE_PEER_CORPUS === "1") {
      fs.writeFileSync(CORPUS, fresh);
    }
    expect(fresh).toBe(fs.readFileSync(CORPUS, "utf8"));
    expect(serializeCorpus(generateCorpus())).toBe(fresh);
  });

  test("every generated corpus row is well-formed and self-consistent", () => {
    const rows = JSON.parse(fs.readFileSync(CORPUS, "utf8")) as CorpusRow[];
    expect(rows.length).toBeGreaterThan(200);
    const seen = new Set<string>();
    for (const row of rows) {
      expect(row.target).toBeTypeOf("string");
      expect(isWellFormedString(row.target)).toBe(true);
      expect(seen.has(row.target)).toBe(false);
      seen.add(row.target);
      expect(row.jsVerdict).toBe(isPeerPlaneTarget(row.target));
      expect(rustModel(row.target)).toBe(row.jsVerdict);
      expect(routeLayerModel(row.target)).toBe(row.jsVerdict);
    }
    expect(rows.some((row) => row.jsVerdict)).toBe(true);
    expect(rows.some((row) => !row.jsVerdict)).toBe(true);
  });

  test("the Rust guard still says what rustModel transliterates", () => {
    // `rustModel` is evidence only while the Rust text is unchanged. If this
    // goes red, re-derive it before touching anything else.
    const relay = fs.readFileSync(RUST_RELAY, "utf8");
    expect(relay).toContain("fn peer_target_allowed(target: &str) -> bool");
    expect(relay).toContain("if !target.starts_with(PEER_PLANE_PREFIX)");
    expect(relay).toContain(".split(['?', '#'])");
    // If this line ever reads `target.len()` again, the languages have parted
    // company (#846 P6).
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
