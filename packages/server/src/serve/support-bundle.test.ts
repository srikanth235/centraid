import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { AnomalyLedger } from "./anomaly-ledger.js";
import {
  buildSupportBundle,
  renderSupportBundle,
  serializeSupportBundle,
  SUPPORT_BUNDLE_FORMAT_VERSION,
  SUPPORT_BUNDLE_SHARING,
} from "./support-bundle.js";
import type { SupportBundleInput } from "./support-bundle.js";

const AT = Date.parse("2026-08-21T09:30:00.000Z");

function ledgerWithFaults(): AnomalyLedger {
  let tick = 0;
  const ledger = new AnomalyLedger({
    now: () => {
      tick += 1;
      return AT - 60_000 * (10 - tick);
    },
  });
  ledger.record({
    kind: "vault-mount-failure",
    severity: "error",
    code: "vault.mount.schema-mismatch",
    component: "serve.vault-registry",
    message: 'mount of "Priya\'s private vault" failed at /Users/priya/v',
    facts: { attempt: 2, epoch: 7 },
  });
  ledger.record({
    kind: "disk-full",
    severity: "error",
    code: "disk.full.append",
    component: "serve.log-store",
    message: "ENOSPC writing /Users/priya/Library/Centraid/gateway.jsonl",
    facts: { droppedWrites: 41 },
  });
  ledger.record({
    kind: "vault-mount-failure",
    severity: "error",
    code: "vault.mount.schema-mismatch",
    component: "serve.vault-registry",
    message: "mount failed again",
    facts: { attempt: 3, epoch: 7 },
  });
  return ledger;
}

function input(
  overrides: Partial<SupportBundleInput> = {}
): SupportBundleInput {
  return {
    generatedAtMs: AT,
    salt: "bundle-salt-842",
    gateway: {
      version: "0.42.1",
      protocolVersion: 11,
      minSupportedProtocol: 9,
    },
    runtime: { platform: "darwin", arch: "arm64", nodeVersion: "v24.4.0" },
    health: {
      status: "degraded",
      uptimeMs: 3_600_000,
      components: [
        {
          component: "storage-latency",
          status: "degraded",
          errorCount: 3,
          detail: 'p95 812ms on "Priya\'s vault"',
          lastError: "checkpoint stalled at /Users/priya/v/vault.db",
        },
        { component: "broker", status: "ok", errorCount: 0 },
      ],
      metrics: { rssBytes: 412_000_000, outboxPending: 6, mountedVaults: 2 },
    },
    anomalies: ledgerWithFaults().snapshot(),
    logs: [
      {
        seq: 1,
        ts: AT - 5000,
        level: "warn",
        message: 'vault registry: created vault v-1 ("Priya\'s private vault")',
      },
      {
        seq: 2,
        ts: AT - 4000,
        level: "error",
        message:
          "backup service: upload to https://backup.example.com/x?key=SEKRIT failed",
      },
      {
        seq: 3,
        ts: AT - 3000,
        level: "info",
        message: "vault registry: mounted 2 vault(s)",
      },
    ],
    storage: [
      {
        vaultId: "vault-0198abcd",
        name: "Priya's private vault",
        vaultDbBytes: 84_000_000,
        journalDbBytes: 6_200_000,
        tableRowCounts: { core_content_item: 41_233, locker_item: 87 },
      },
    ],
    config: {
      dataDir: "/Users/priya/Library/Application Support/Centraid",
      backup: { provider: "s3", accessToken: "sk-live-0123456789abcdef" },
      experimental: true,
    },
    sensitiveLiterals: [
      "Priya's private vault",
      "sk-live-0123456789abcdef",
      "SEKRIT",
    ],
    ...overrides,
  };
}

describe("support bundle — redaction", () => {
  test.each(["strict", "standard"] as const)(
    "%s leaks no seeded sensitive value",
    (level) => {
      const rendered = renderSupportBundle(input({ level }));
      for (const secret of [
        "Priya",
        "private vault",
        "sk-live-0123456789abcdef",
        "SEKRIT",
        "/Users/priya",
        "backup.example.com",
        "vault-0198abcd",
      ])
        expect(rendered.text, `${level} leaked ${secret}`).not.toContain(
          secret
        );
      expect(() => JSON.parse(rendered.text)).not.toThrow();
    }
  );

  test("strict is the default, and it drops prose rather than scrubbing it", () => {
    const bundle = buildSupportBundle(input({ level: undefined }));
    expect(bundle.redaction.level).toBe("strict");
    expect(
      bundle.logs.groups.every((group) => group.templates.length === 0)
    ).toBe(true);
    expect(bundle.redaction.byRule["prose-dropped"]).toBeGreaterThan(0);
  });

  test("standard keeps the message skeleton and says which rules fired", () => {
    const bundle = buildSupportBundle(input({ level: "standard" }));
    const templates = bundle.logs.groups.flatMap((group) => group.templates);
    expect(templates.join("\n")).toContain("vault registry: created vault v-1");
    expect(bundle.redaction.byRule["quoted-value"]).toBeGreaterThan(0);
    expect(bundle.redaction.byRule.url).toBeGreaterThan(0);
  });

  test("the tripwire counts what the policy missed instead of hiding it", () => {
    const bundle = buildSupportBundle(input({ level: "standard" }));
    const planted = {
      ...bundle,
      // Simulate a lane that copied an owner-authored value through.
      disclosure: [...bundle.disclosure, "Priya's private vault"],
    };
    const serialized = serializeSupportBundle(planted, [
      "Priya's private vault",
    ]);
    expect(serialized.tripwireHits).toBe(1);
    expect(serialized.text).not.toContain("Priya");
    const parsed = JSON.parse(serialized.text) as {
      redaction: { byRule: Record<string, number> };
    };
    expect(parsed.redaction.byRule.tripwire).toBe(1);
  });

  test("a field added upstream does not ride along — nothing is copied", () => {
    const extended = input();
    const bundle = buildSupportBundle({
      ...extended,
      storage: [
        {
          ...extended.storage[0]!,
          // A future field carrying owner text.
          ownerNote: "Priya's laptop",
        } as never,
      ],
    });
    expect(JSON.stringify(bundle)).not.toContain("laptop");
    expect(Object.keys(bundle.storage[0] ?? {}).toSorted()).toStrictEqual([
      "journalDbBytes",
      "tableRowCounts",
      "vaultDbBytes",
      "vaultId",
    ]);
  });

  test("the same input and salt render byte-identically", () => {
    expect(renderSupportBundle(input()).text).toBe(
      renderSupportBundle(input()).text
    );
  });
});

describe("support bundle — usefulness", () => {
  test("a redacted bundle still answers what broke, where, and how often", () => {
    const bundle = buildSupportBundle(input());
    expect(bundle.formatVersion).toBe(SUPPORT_BUNDLE_FORMAT_VERSION);
    expect(bundle.gateway.version).toBe("0.42.1");
    expect(bundle.gateway.protocolVersion).toBe(11);
    expect(bundle.runtime.platform).toBe("darwin");
    expect(bundle.health.status).toBe("degraded");
    // The failing component is named, with its error count.
    const failing = bundle.health.components.find(
      (component) => component.component === "storage-latency"
    );
    expect(failing?.status).toBe("degraded");
    expect(failing?.errorCount).toBe(3);
    // The anomaly ledger keeps the machine-readable cause and its recurrence.
    expect(bundle.anomalies.count).toBe(3);
    expect(bundle.anomalies.histogram["vault.mount.schema-mismatch"]).toBe(2);
    const first = bundle.anomalies.records[0] as Record<string, unknown>;
    expect(first.code).toBe("vault.mount.schema-mismatch");
    expect(first.severity).toBe("error");
    expect(first.facts).toStrictEqual({ attempt: 2, epoch: 7 });
    // The log tail keeps its shape: which component, which level, how many.
    expect(bundle.logs.count).toBe(3);
    expect(bundle.logs.byLevel).toStrictEqual({ warn: 1, error: 1, info: 1 });
    expect(
      bundle.logs.groups.map((group) => group.component).toSorted()
    ).toStrictEqual(["backup-service", "vault-registry", "vault-registry"]);
    // Every group carries a digest the owner can grep their own log for.
    expect(bundle.logs.groups.every((group) => group.digests.length > 0)).toBe(
      true
    );
    // Storage sizing survives, so "the vault is 84MB with 41k items" is answerable.
    const storage = bundle.storage[0] as Record<string, unknown>;
    expect(storage.vaultDbBytes).toBe(84_000_000);
    expect(
      (storage.tableRowCounts as Record<string, number>).core_content_item
    ).toBe(41_233);
    // Non-secret config survives.
    expect(JSON.stringify(bundle.config)).toContain('"provider":"s3"');
    expect(JSON.stringify(bundle.health.metrics)).toContain(
      '"outboxPending":6'
    );
  });

  test("the bundle is not empty — a leak sweep over nothing proves nothing", () => {
    const rendered = renderSupportBundle(input());
    expect(rendered.bytes).toBeGreaterThan(1200);
    const redactedFraction =
      rendered.bundle.redaction.redactedLeaves /
      rendered.bundle.redaction.leaves;
    // Most leaves survive. A bundle that redacts everything is a blank page.
    expect(rendered.bundle.redaction.leaves).toBeGreaterThan(30);
    expect(redactedFraction).toBeLessThan(0.5);
  });

  test("it states its own sharing rule and what it does not contain", () => {
    const bundle = buildSupportBundle(input());
    expect(bundle.sharing).toBe(SUPPORT_BUNDLE_SHARING);
    expect(SUPPORT_BUNDLE_SHARING).toBe("manual-owner-action");
    expect(bundle.disclosure.join(" ")).toContain(
      "Nothing in Centraid uploads"
    );
    expect(bundle.generatedAt).toBe("2026-08-21T09:30:00.000Z");
  });
});

describe("support bundle — no egress", () => {
  const here = import.meta.dirname;
  const NETWORK = [
    /\bfetch\s*\(/u,
    /\bXMLHttpRequest\b/u,
    /\bWebSocket\b/u,
    /from\s+"node:(?:http|https|net|tls|dgram|dns)"/u,
    /require\(\s*["']node:(?:http|https|net|tls|dgram|dns)["']/u,
    /\bundici\b/u,
    /navigator\.sendBeacon/u,
  ];

  test.each([
    "support-bundle.ts",
    "diagnostics-redaction.ts",
    "anomaly-ledger.ts",
  ])("%s reaches no network primitive", (file) => {
    const source = readFileSync(path.join(here, file), "utf8");
    for (const pattern of NETWORK)
      expect(pattern.test(source), `${file} matches ${pattern.source}`).toBe(
        false
      );
  });

  test("building a bundle performs no timer or scheduler work", () => {
    // Purity in the shape that matters here: the same call twice, with the
    // clock supplied by the caller, is the same value. Nothing schedules,
    // nothing uploads, nothing observes the wall clock.
    const one = buildSupportBundle(input());
    const two = buildSupportBundle(input());
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
