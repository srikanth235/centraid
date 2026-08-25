/* oxlint-disable no-script-url -- the adversarial URL generators must name the
   executable schemes they prove the shared allowlist rejects. */
// NO `@vitest-environment` docblock on purpose. This suite must stay on the
// node environment: it is the node-side property complement to the jsdom
// render suite (src/untrusted-rendering.test.ts), and it is what lets Stryker's
// vitest runner measure apps/_shared/untrusted.ts at all — a jsdom project
// dry-runs as "No tests were executed" and defends no mutant (#864).
//
// The jsdom suite proves the app rows render the XSS vectors inert. This suite
// proves the four render-boundary laws the module itself must satisfy, against
// arbitrary unicode, `fc.webUrl()`, and a hand-built adversarial scheme/
// encoding alphabet — total display text, a closed URL allowlist, media ⊆
// document, and an unescapable CSS `background-image` sink. Boundaries the
// current implementation does NOT hold are pinned with `it.fails`, so the day
// one is closed the pin turns red and asks to become a passing law.
//
// Every non-printable character below is written as a `\u` escape on purpose:
// the code points under test are exactly the invisible controls and bidi marks
// this module exists to scrub, and a literal one in the source would be
// unreviewable. Each guarded law is checked with an UNCONDITIONAL boolean (the
// implication folded in), never a conditional `expect`, so the assertion count
// is stable and the property reads as one law.
import { describe, expect, it } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  displayText,
  safeBackgroundImage,
  safeDocumentUrl,
  safeExternalUrl,
  safeMediaUrl,
  VAULT_BLOB_PATH,
} from "./untrusted.ts";

const REPLACEMENT = "�";

// ---------------------------------------------------------------------------
// The render-boundary's forbidden output set, written as the security contract
// it is rather than as a copy of `displayText`'s predicate: these are the
// categories that must never survive to a text node or attribute — the C0
// controls minus the three whitespace ones the contract keeps (TAB, LF, CR),
// DEL, the Unicode bidi OVERRIDES, and the bidi ISOLATES. The tests scan the
// OUTPUT against this table; they never re-run the module's own logic over the
// input and compare.
const BANNED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function isBanned(code: number): boolean {
  return BANNED_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

// A code UNIT (not code point) at or below space, or DEL — the exact thing the
// URL sinks promise never to carry. Scanned as UTF-16 units so a smuggled
// C0/DEL cannot hide inside a surrogate pair.
function hasControlUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x20 || unit === 0x7f) return true;
  }
  return false;
}

const ACTIVE_CONTENT =
  /^(?:javascript|vbscript|data:text\/html|data:image\/svg)/iu;

function isHttpS(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// True when a sink's answer is null or lands in that sink's own allowlist and
// carries no active-content scheme. Returns a plain boolean so the property can
// assert it unconditionally.
function isClosed(name: string, result: string | null): boolean {
  if (result === null) return true;
  if (ACTIVE_CONTENT.test(result)) return false;
  if (name === "safeExternalUrl") {
    return /^(?:mailto:|tel:)/iu.test(result) || isHttpS(result);
  }
  return (
    result.startsWith(VAULT_BLOB_PATH) ||
    /^data:/iu.test(result) ||
    isHttpS(result)
  );
}

// True when a background-image answer is undefined or a single, unbreakable
// `url("…")` token whose inner string re-derives exactly the URL the media
// sink admitted (proving the escaper added and dropped nothing but its two
// escapes, and that no `"` can terminate the CSS string early).
function isSealedUrlToken(
  out: `url("${string}")` | undefined,
  admitted: string | null
): boolean {
  if (out === undefined) return true;
  if (!out.startsWith('url("') || !out.endsWith('")')) return false;
  const inner = out.slice('url("'.length, -'")'.length);
  let backslashes = 0;
  for (const character of inner) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    // A double quote is safe only behind an odd run of backslashes; an even
    // (incl. zero) run would close the CSS string and free the `)`.
    if (character === '"' && backslashes % 2 === 0) return false;
    backslashes = 0;
  }
  const recovered = inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  return recovered === admitted;
}

// Arbitrary unicode over full UTF-16 (incl. lone surrogates and every control),
// plus grapheme strings that reach astral code points.
const anyText = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.string({ unit: "grapheme" })
);

// URL-shaped inputs: real web URLs, a hand-built adversarial scheme/encoding
// alphabet, vault-blob and data: prefixed strings that exercise the trusted
// branches, and free-form unicode noise.
const adversarialScheme = fc.constantFrom(
  "javascript:",
  "JavaScript:",
  "java\tscript:",
  "  javascript:",
  "java\u0000script:",
  "vbscript:",
  "VBScript:",
  "data:text/html,",
  "data:text/html;base64,",
  "data:image/svg+xml,",
  "data:image/svg+xml;base64,",
  "file:///etc/passwd",
  "chrome://settings",
  "about:blank",
  "blob:https://x/y",
  "ftp://host/f",
  "mailto:",
  "tel:",
  "http://",
  "https://"
);
const dataPrefix = fc.constantFrom(
  "data:image/png;base64,",
  "data:image/gif;base64,",
  "data:image/svg+xml;base64,",
  "data:application/pdf;base64,",
  "data:text/plain;base64,",
  "data:text/html;base64,",
  "data:audio/mpeg;base64,",
  "data:video/mp4;base64,"
);
const urlInput = fc.oneof(
  fc.webUrl(),
  fc
    .tuple(adversarialScheme, fc.string())
    .map(([scheme, rest]) => scheme + rest),
  fc.string().map((rest) => VAULT_BLOB_PATH + rest),
  fc.tuple(dataPrefix, fc.string()).map(([prefix, rest]) => prefix + rest),
  fc.string({ unit: "binary" }),
  fc.constant('https://x.invalid/a") ; color:red;/*')
);

const URL_SINKS: ReadonlyArray<
  readonly [string, (value: unknown) => string | null]
> = [
  ["safeExternalUrl", safeExternalUrl],
  ["safeMediaUrl", safeMediaUrl],
  ["safeDocumentUrl", safeDocumentUrl],
];

// ---------------------------------------------------------------------------

describe("[law:untrusted-display-total] displayText is total, length-preserving, idempotent and sanitizing", () => {
  it("never throws, for any input including non-strings", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => displayText(value)).not.toThrow();
        expect(displayText(value)).toBeTypeOf("string");
      }),
      { numRuns: 400, seed: 8_640_001 }
    );
    // The non-string coercions the JSX layer can hand it, spelled out.
    for (const value of [
      null,
      undefined,
      123,
      123n,
      Symbol("s"),
      {},
      [1, 2],
      true,
      Number.NaN,
    ]) {
      expect(() => displayText(value)).not.toThrow();
    }
    expect(displayText(null)).toBe("");
    expect(displayText(undefined)).toBe("");
  });

  it("preserves code-point length and is idempotent for strings", () => {
    fc.assert(
      fc.property(anyText, (value) => {
        const once = displayText(value);
        // One output code point per input code point — every banned point is
        // replaced by exactly one U+FFFD, never dropped or expanded.
        expect([...once]).toHaveLength([...value].length);
        // Re-running changes nothing: U+FFFD and every kept character are safe.
        expect(displayText(once)).toBe(once);
      }),
      { numRuns: 400, seed: 8_640_002 }
    );
  });

  it("emits no character in the forbidden control/bidi set", () => {
    fc.assert(
      fc.property(anyText, (value) => {
        for (const character of displayText(value)) {
          expect(isBanned(character.codePointAt(0) ?? 0)).toBe(false);
        }
      }),
      { numRuns: 400, seed: 8_640_003 }
    );
    // The spoofing vectors the jsdom suite renders, at the display contract:
    // an RLO override is scrubbed, and an ESC-sequence prefix maps its two
    // controls to U+FFFD while the visible tail survives.
    expect(displayText("\u202Etxt.exe\u202C")).not.toContain("\u202E");
    expect(displayText("\u0000\u001B[31m")).toBe(
      `${REPLACEMENT}${REPLACEMENT}[31m`
    );
  });

  it("keeps every non-banned character and maps every banned one to U+FFFD", () => {
    // Boundary-adjacent SAFE code points on both sides of every banned range,
    // plus ordinary and astral text: none may be touched.
    const safeUnit = fc.constantFrom(
      "\t", // 0x09 kept
      "\n", // 0x0A kept
      "\r", // 0x0D kept
      " ",
      "!",
      "~", // just below DEL
      "\u0080", // just above DEL
      "\u2029", // just below the bidi-override block
      "\u202F", // just above it
      "\u2065", // just below the bidi-isolate block
      "\u206A", // just above it
      "A",
      "z",
      "0",
      "é",
      "\u{1F600}"
    );
    fc.assert(
      fc.property(
        fc.array(safeUnit).map((parts) => parts.join("")),
        (value) => {
          expect(displayText(value)).toBe(value);
        }
      ),
      { numRuns: 300, seed: 8_640_004 }
    );
    // Every banned code point collapses to a single U+FFFD.
    const bannedUnit = fc.constantFrom(
      "\u0000",
      "\u0008",
      "\u000B",
      "\u000C",
      "\u000E",
      "\u001F",
      "\u007F",
      "\u202A",
      "\u202E",
      "\u2066",
      "\u2069"
    );
    fc.assert(
      fc.property(
        fc.array(bannedUnit, { minLength: 1 }).map((parts) => parts.join("")),
        (value) => {
          const out = displayText(value);
          expect([...out].every((character) => character === REPLACEMENT)).toBe(
            true
          );
          expect([...out]).toHaveLength([...value].length);
        }
      ),
      { numRuns: 300, seed: 8_640_005 }
    );
  });
});

describe("[law:untrusted-url-allowlist-closed] the dynamic URL sinks return null or an allowlisted, inert value", () => {
  it("every result is null or in the sink's own allowlist and never active content", () => {
    fc.assert(
      fc.property(urlInput, (value) => {
        for (const [name, sink] of URL_SINKS) {
          expect(isClosed(name, sink(value)), name).toBe(true);
        }
      }),
      { numRuns: 600, seed: 8_640_010 }
    );
    // The concrete rejections the jsdom suite spot-checks.
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("java\tscript:alert(1)")).toBeNull();
    expect(safeMediaUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(safeDocumentUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  it("admits every allowlisted scheme verbatim and rejects at each guard boundary", () => {
    // The POSITIVE side the "null OR allowlisted" property cannot pin: a sink
    // that always answered null would satisfy that law, so every admitted
    // scheme is checked to round-trip its exact input here.
    expect(safeExternalUrl("http://a.example/")).toBe("http://a.example/");
    expect(safeExternalUrl("https://a.example/p?q=1#f")).toBe(
      "https://a.example/p?q=1#f"
    );
    expect(safeExternalUrl("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeExternalUrl("tel:+15551234567")).toBe("tel:+15551234567");
    expect(safeMediaUrl("https://a.example/i.png")).toBe(
      "https://a.example/i.png"
    );
    expect(safeMediaUrl(`${VAULT_BLOB_PATH}abc`)).toBe(`${VAULT_BLOB_PATH}abc`);
    expect(safeMediaUrl("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA"
    );
    expect(safeDocumentUrl("https://a.example/d.pdf")).toBe(
      "https://a.example/d.pdf"
    );
    expect(safeDocumentUrl(`${VAULT_BLOB_PATH}xyz`)).toBe(
      `${VAULT_BLOB_PATH}xyz`
    );
    expect(safeDocumentUrl("data:application/pdf;base64,AAAA")).toBe(
      "data:application/pdf;base64,AAAA"
    );
    // Non-strings are rejected by every sink's typeof guard, never coerced.
    for (const value of [
      123,
      123n,
      Symbol("s"),
      {},
      [1, 2],
      true,
      null,
      undefined,
      Number.NaN,
    ]) {
      expect(safeExternalUrl(value)).toBeNull();
      expect(safeMediaUrl(value)).toBeNull();
      expect(safeDocumentUrl(value)).toBeNull();
    }
    // Empty and whitespace-only collapse to null; the leading/trailing trim is
    // load-bearing — without it those spaces would themselves trip the control
    // guard and the URL below would never be admitted.
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl("  https://a.example/  ")).toBe(
      "https://a.example/"
    );
    // A DEL (U+007F) or an embedded space is a control code unit that rejects
    // the whole external link — the DEL exercises the `=== 127` arm the space
    // (<= 32) does not reach.
    expect(safeExternalUrl("https://a.example/\u007F")).toBeNull();
    expect(safeExternalUrl("https://a.example/ x")).toBeNull();
    // The 8 KiB external-link cap is exact: 8192 code units is admitted, 8193
    // is not.
    const base = "https://a.example/";
    const at8192 = base + "a".repeat(8_192 - base.length);
    expect(at8192).toHaveLength(8_192);
    expect(safeExternalUrl(at8192)).toBe(at8192);
    expect(safeExternalUrl(`${at8192}a`)).toBeNull();
  });

  it("safeExternalUrl never returns a value carrying a control code unit", () => {
    fc.assert(
      fc.property(urlInput, (value) => {
        const result = safeExternalUrl(value);
        // Implication folded in: null is vacuously control-free.
        expect(result === null || !hasControlUnit(result)).toBe(true);
      }),
      { numRuns: 600, seed: 8_640_011 }
    );
    // The same holds for media/document when they answer via the HTTP(S) arm —
    // the only arm that runs the control scan (the trusted-prefix arms do not,
    // which the boundary pin below records).
    fc.assert(
      fc.property(fc.webUrl(), (value) => {
        for (const sink of [safeMediaUrl, safeDocumentUrl]) {
          const result = sink(value);
          expect(
            result === null || !isHttpS(result) || !hasControlUnit(result)
          ).toBe(true);
        }
      }),
      { numRuns: 300, seed: 8_640_012 }
    );
  });

  it.fails("BOUNDARY: media/document pass control units straight through the trusted vault-blob and data: prefixes", () => {
    // The vault-blob and data: arms return the value verbatim with no control
    // scan, so the control-free promise is NOT global to these two sinks.
    // This pin documents that trusted-prefix gap; close it and this turns red.
    const smuggled = `${VAULT_BLOB_PATH}a\u0001b`;
    const result = safeMediaUrl(smuggled);
    expect(result).not.toBeNull();
    expect(hasControlUnit(result ?? "")).toBe(false);
  });
});

describe("[law:untrusted-media-subsumed-by-document] every media source is a document source", () => {
  it("safeMediaUrl acceptance implies identical safeDocumentUrl acceptance", () => {
    fc.assert(
      fc.property(urlInput, (value) => {
        const media = safeMediaUrl(value);
        // Implication folded in: a rejected media value is vacuously subsumed.
        expect(media === null || safeDocumentUrl(value) === media).toBe(true);
      }),
      { numRuns: 600, seed: 8_640_020 }
    );
  });

  it("document accepts a media-rejected value only for application/pdf or text/plain", () => {
    fc.assert(
      fc.property(urlInput, (value) => {
        const media = safeMediaUrl(value);
        const document = safeDocumentUrl(value);
        const converseHolds =
          !(media === null && document !== null) ||
          /^data:(?:application\/pdf|text\/plain);/iu.test(document ?? "");
        expect(converseHolds).toBe(true);
      }),
      { numRuns: 600, seed: 8_640_021 }
    );
    // Both directions of the converse, concretely.
    expect(safeMediaUrl("data:application/pdf;base64,AA")).toBeNull();
    expect(safeDocumentUrl("data:application/pdf;base64,AA")).toBe(
      "data:application/pdf;base64,AA"
    );
    expect(safeMediaUrl("data:text/plain;base64,AA")).toBeNull();
    expect(safeDocumentUrl("data:text/plain;base64,AA")).toBe(
      "data:text/plain;base64,AA"
    );
  });
});

describe("[law:untrusted-background-image-unescapable] safeBackgroundImage cannot escape its quoted CSS url() string", () => {
  it('output is undefined or a sealed url("…") token recoverable to the admitted source', () => {
    fc.assert(
      fc.property(urlInput, (value) => {
        expect(
          isSealedUrlToken(safeBackgroundImage(value), safeMediaUrl(value))
        ).toBe(true);
      }),
      { numRuns: 600, seed: 8_640_030 }
    );
    // The existing adversarial class is rejected upstream — it never reaches
    // the escaper, so there is nothing to break out of.
    expect(
      safeBackgroundImage('https://x.invalid/a") ; color:red;/*')
    ).toBeUndefined();
    // A clean URL bearing quote and backslash is neutralized, not dropped.
    expect(safeBackgroundImage('https://x/a"b\\c')).toBe(
      'url("https://x/a\\"b\\\\c")'
    );
  });

  it.fails("BOUNDARY: a data-URL newline yields CSS that is not a single valid url() token", () => {
    // safeMediaUrl admits a data: body verbatim, and the escaper only handles
    // quote and backslash — so a raw newline survives into the CSS string,
    // which is a parse error rather than a single url() token. The value
    // cannot inject (it fails to set), but the token-integrity clause of the
    // law does not hold here. Strip the control and this turns red.
    const out = safeBackgroundImage("data:image/png;base64,AA\nBB");
    expect(out).toBeTypeOf("string");
    expect(/[\n\r\f]/u.test(out ?? "")).toBe(false);
  });
});
