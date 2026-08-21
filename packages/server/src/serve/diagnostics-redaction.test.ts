import { describe, expect, test } from "vitest";

import {
  applyTripwire,
  digest12,
  emitLeaf,
  emptyRedactionReport,
  hashIdentifier,
  PROSE_MAX_CHARS,
  REDACTION_RULE_IDS,
  scrubProse,
  scrubUnknown,
  SECRET_KEY_PATTERN,
} from "./diagnostics-redaction.js";
import type { LeafContext } from "./diagnostics-redaction.js";

const context = (level: "strict" | "standard" = "standard"): LeafContext => ({
  report: emptyRedactionReport(level),
  salt: "fixed-salt-842",
});

describe("scrubProse", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      "email",
      "outbox: delivery to priya.raghunathan@example.com failed",
      "priya.raghunathan@example.com",
    ],
    ["jwt", "auth: eyJhbGciOi.eyJzdWIiOjEyMw.QWxsRG9uZQ rejected", "eyJhbGciOi"],
    [
      "url",
      "peer: dial https://vault.example.net/join?ticket=abc123 timed out",
      "vault.example.net",
    ],
    [
      "absolute-path",
      "backup: could not open /Users/priya/Library/Centraid/vault.db",
      "priya",
    ],
    ["ip-address", "tunnel: relay 203.0.113.44 unreachable", "203.0.113.44"],
    ["phone", "contact import: +1 415 555 0132 malformed", "555 0132"],
    ["payment-card", "locker: card 4111 1111 1111 1111 rejected", "4111"],
    [
      "quoted-value",
      'vault registry: created vault v-1 ("Priya\'s private vault")',
      "private vault",
    ],
    [
      "high-entropy",
      "seal: key CENTRAID-SEALED-9f2b7c1d0e4a6b8c3d5f refused",
      "CENTRAID-SEALED-9f2b7c1d0e4a6b8c3d5f",
    ],
  ];

  test.each(cases)("removes %s", (rule, input, leaked) => {
    const report = emptyRedactionReport("standard");
    const out = scrubProse(input, report);
    expect(out, `${rule} left ${leaked} in ${out}`).not.toContain(leaked);
    expect(out).toContain("[REDACTED:");
  });

  test("keeps the message skeleton so the line stays diagnostic", () => {
    const report = emptyRedactionReport("standard");
    const out = scrubProse(
      'vault registry: created vault v-1 ("Priya\'s vault")',
      report
    );
    expect(out).toContain("vault registry: created vault v-1");
    expect(report.byRule["quoted-value"]).toBe(1);
  });

  test("removes an owner sentence interpolated unquoted into a log line", () => {
    const report = emptyRedactionReport("standard");
    const out = scrubProse(
      "notes: body too large — Mum's cardiologist said the stent goes in on the 14th and we should not tell Dad yet",
      report
    );
    expect(out).toBe("notes: body too large — [REDACTED:sentence-run]");
    expect(report.byRule["sentence-run"]).toBe(1);
  });

  test("a short log skeleton survives the sentence rule", () => {
    const report = emptyRedactionReport("standard");
    expect(
      scrubProse("vault registry: mounted 2 vault(s) in 41ms", report)
    ).toBe("vault registry: mounted 2 vault(s) in 41ms");
    expect(report.byRule["sentence-run"]).toBe(0);
  });

  test("caps runaway interpolation and reports it", () => {
    const report = emptyRedactionReport("standard");
    // Punctuation between every token, so no rule but the cap applies.
    const out = scrubProse(`note: ${"a; ".repeat(400)}`, report);
    expect(out.length).toBeLessThanOrEqual(PROSE_MAX_CHARS + 32);
    expect(report.byRule["length-cap"]).toBe(1);
  });

  test("is idempotent — a scrubbed line cannot re-expand or re-fire", () => {
    const first = emptyRedactionReport("standard");
    const once = scrubProse("mail: a@b.co at /tmp/x/y.db", first);
    const second = emptyRedactionReport("standard");
    expect(scrubProse(once, second)).toBe(once);
    expect(Object.values(second.byRule).every((count) => count === 0)).toBe(
      true
    );
  });

  test("card attribution is Luhn-gated, and the fallthrough still redacts", () => {
    const valid = emptyRedactionReport("standard");
    expect(scrubProse("locker: 4111-1111-1111-1111 declined", valid)).toBe(
      "locker: [REDACTED:payment-card] declined"
    );
    expect(valid.byRule["payment-card"]).toBe(1);
    // Luhn refuses this one, so `payment-card` does not claim it — but the
    // long-digit-run shape is still a value, and `phone` removes it. A rule
    // declining a match must never mean the value survives.
    const invalid = emptyRedactionReport("standard");
    const out = scrubProse("seq 4111111111111112 seen", invalid);
    expect(out).not.toContain("4111111111111112");
    expect(invalid.byRule["payment-card"]).toBe(0);
    expect(invalid.byRule.phone).toBe(1);
  });
});

describe("emitLeaf", () => {
  test("refuses a value whose shape its policy does not declare", () => {
    const shared = context();
    expect(emitLeaf("Priya's vault", "enum", shared)).toBe(
      "[REDACTED:shape-refused]"
    );
    expect(emitLeaf(Number.NaN, "number", shared)).toBe(
      "[REDACTED:shape-refused]"
    );
    expect(emitLeaf("not-a-time", "timestamp", shared)).toBe(
      "[REDACTED:shape-refused]"
    );
    expect(shared.report.byRule["shape-refused"]).toBe(3);
  });

  test("passes machine-shaped values through", () => {
    const shared = context();
    expect(emitLeaf("vault.mount.failed", "enum", shared)).toBe(
      "vault.mount.failed"
    );
    expect(emitLeaf("2026-08-21T00:00:00.000Z", "timestamp", shared)).toBe(
      "2026-08-21T00:00:00.000Z"
    );
    expect(emitLeaf(42, "number", shared)).toBe(42);
  });

  test("strict drops prose entirely; standard keeps the skeleton", () => {
    const strict = context("strict");
    expect(emitLeaf("mount failed for x", "prose", strict)).toBe(
      "[REDACTED:prose-dropped]"
    );
    const standard = context("standard");
    expect(emitLeaf("mount failed for x", "prose", standard)).toBe(
      "mount failed for x"
    );
  });

  test("identifiers hash stably per salt and never round-trip", () => {
    const shared = context();
    const hashed = emitLeaf("vault-0198", "identifier", shared);
    expect(hashed).toBe(hashIdentifier("vault-0198", "fixed-salt-842"));
    expect(String(hashed)).not.toContain("0198");
    expect(hashIdentifier("vault-0198", "other")).not.toBe(hashed);
  });
});

describe("scrubUnknown", () => {
  test("drops secret-shaped keys at any depth and scrubs strings", () => {
    const shared = context();
    const out = scrubUnknown(
      {
        dataDir: "/Users/priya/Centraid",
        backup: { provider: "s3", accessToken: "sk-live-abcdefghijklmnop" },
        flags: { experimental: true, mountedVaults: 3 },
      },
      shared
    ) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain("sk-live-abcdefghijklmnop");
    expect(text).not.toContain("priya");
    expect(text).toContain('"provider":"s3"');
    expect(text).toContain('"mountedVaults":3');
    expect(shared.report.byRule["secret-key"]).toBe(1);
  });

  test("machine settings survive strict; anything name-shaped does not", () => {
    const strict = context("strict");
    const out = scrubUnknown(
      {
        provider: "s3",
        platform: "darwin",
        mode: "local-gateway",
        vaultName: "Priya",
        label: "Priya's private vault",
        title: "Backup of 2024",
        handle: "9f2b7c1d0e4a6b8c3d5f0011",
      },
      strict
    ) as Record<string, unknown>;
    expect(out.provider).toBe("s3");
    expect(out.platform).toBe("darwin");
    expect(out.mode).toBe("local-gateway");
    for (const key of ["vaultName", "label", "title", "handle"])
      expect(String(out[key]), key).toContain("[REDACTED:");
  });

  test("caps depth so a surprise structure cannot balloon the document", () => {
    const shared = context();
    let nested: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) nested = { nested };
    expect(JSON.stringify(scrubUnknown(nested, shared))).toContain(
      "[REDACTED:depth-cap]"
    );
  });
});

describe("applyTripwire", () => {
  test("removes every occurrence and counts them", () => {
    const result = applyTripwire(
      '{"a":"Priya Raghunathan","b":"x Priya Raghunathan"}',
      ["Priya Raghunathan"]
    );
    expect(result.hits).toBe(2);
    expect(result.text).not.toContain("Priya");
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  test("ignores literals too short to sweep without shredding the document", () => {
    const result = applyTripwire('{"status":"ok"}', ["ok"]);
    expect(result.hits).toBe(0);
    expect(result.text).toBe('{"status":"ok"}');
  });
});

describe("registry hygiene", () => {
  test("every rule id is unique and every report starts zero-filled", () => {
    expect(new Set(REDACTION_RULE_IDS).size).toBe(REDACTION_RULE_IDS.length);
    const report = emptyRedactionReport("strict");
    for (const id of REDACTION_RULE_IDS) expect(report.byRule[id]).toBe(0);
  });

  test("the secret-key pattern covers the naming conventions in use", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "bearerToken",
      "sealKey",
      "refresh_token",
      "clientSecret",
      "Authorization",
      "cookie",
      "otp_seed",
      "cvv",
    ])
      expect(SECRET_KEY_PATTERN.test(key), key).toBe(true);
    for (const key of ["mountedVaults", "provider", "status"])
      expect(SECRET_KEY_PATTERN.test(key), key).toBe(false);
  });

  test("digest12 is stable and carries no plaintext", () => {
    expect(digest12("hunter2")).toBe(digest12("hunter2"));
    expect(digest12("hunter2")).not.toContain("hunter");
    expect(digest12("hunter2")).toHaveLength(12);
  });
});
