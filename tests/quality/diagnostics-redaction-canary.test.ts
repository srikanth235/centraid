import { createHash } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import { AnomalyLedger } from "../../packages/server/src/serve/anomaly-ledger.js";
import { GatewayLogStore } from "../../packages/server/src/serve/gateway-log-store.js";
import { HealthRegistry } from "../../packages/server/src/serve/health-registry.js";
import { collectSupportBundleInput } from "../../packages/server/src/serve/support-bundle-source.js";
import {
  buildSupportBundle,
  renderSupportBundle,
  serializeSupportBundle,
} from "../../packages/server/src/serve/support-bundle.js";
import type { SupportBundleInput } from "../../packages/server/src/serve/support-bundle.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";
import {
  seedYear3Vault,
  year3VaultProfile,
} from "../../packages/test-kit/src/year3-vault.js";

const CLOCK_START = Date.parse("2026-08-21T09:00:00.000Z");

function seededHex(label: string, length: number): string {
  return createHash("sha256")
    .update(`842-w8-canary:${label}`)
    .digest("hex")
    .slice(0, length);
}

const SENTINELS = {
  "person-name": "Priyanka Raghunathan",
  "vault-name": "Kitchen table archive",
  email: "priyanka.raghunathan@example.org",
  phone: "+1 415 555 0184",
  "payment-card": "4111 1111 1111 1111",
  "note-body":
    "Mum's cardiologist said the stent goes in on the 14th and we should not tell Dad yet",
  "absolute-path": "/Users/priyanka/Library/Application Support/Centraid",
  "url-credential": "https://backup.example.net/put?key=OQ7SECRETKEY9",
  "bearer-token": `sk-live-${seededHex("bearer", 32)}`,
  passphrase: "correct-horse-battery-staple-1978",
  "opaque-handle": seededHex("handle", 32),
} as const;

type SentinelClass = keyof typeof SENTINELS;

function assertNoLeak(text: string, extra: Record<string, string> = {}): void {
  for (const [label, value] of Object.entries({ ...SENTINELS, ...extra }))
    expect(text, `leaked ${label}: ${value}`).not.toContain(value);
}

interface Rig {
  input: SupportBundleInput;
  sealedSentinels: Record<string, string>;
  planeStop: () => void;
  diagnosticsVaultName: string;
}

async function buildRig(): Promise<Rig> {
  const dir = await tempDir("quality-w8-diagnostics-");
  const emitted: string[] = [];
  const plane = openVaultPlane({
    bootstrap: true,
    dir,
    ownerName: SENTINELS["person-name"],
    vaultName: SENTINELS["vault-name"],
    logger: {
      info: (message: string) => emitted.push(message),
      warn: (message: string) => emitted.push(message),
      error: (message: string) => emitted.push(message),
    },
    enableWalShipper: false,
  });
  const db = plane.db;
  seedYear3Vault(
    {
      vault: db.vault,
      sealCell: (_entity, _column, _rowId, plaintext) => plaintext,
    },
    { parties: 12, photos: 24, conversations: 2, turnsPerConversation: 2 }
  );
  const profile = year3VaultProfile();

  db.vault
    .prepare(
      "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at) VALUES (?, 'person', ?, ?, ?)"
    )
    .run(
      "w8-canary-person",
      SENTINELS["person-name"],
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

  const logs = new GatewayLogStore();
  const logger = logs.wrap({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  logger.info(
    `vault registry: created vault ${plane.boot.vaultId} ("${SENTINELS["vault-name"]}")`
  );
  logger.warn(
    `backup service: upload to ${SENTINELS["url-credential"]} failed after 3 tries`
  );
  logger.error(
    `contacts import: row 41 has phone ${SENTINELS.phone} and email ${SENTINELS.email}`
  );
  logger.warn(
    `locker: card ${SENTINELS["payment-card"]} rejected by the issuer`
  );
  logger.error(
    `vault plane: cannot open ${SENTINELS["absolute-path"]}/vault.db`
  );
  logger.warn(`notes: body too large — ${SENTINELS["note-body"]}`);
  logger.info(`peer: authorization Bearer ${SENTINELS["bearer-token"]}`);
  logger.warn(`keys: passphrase ${SENTINELS.passphrase} did not unwrap`);
  logger.info(`blob: handle ${SENTINELS["opaque-handle"]} missing`);
  for (const message of emitted) logger.info(message);

  const health = new HealthRegistry({ now: () => CLOCK_START });
  health.reportDegraded(
    "storage-latency",
    `p95 812ms writing "${SENTINELS["vault-name"]}" at ${SENTINELS["absolute-path"]}`
  );
  health.reportError(
    "storage-latency",
    `checkpoint of "${SENTINELS["vault-name"]}" stalled: ${SENTINELS["note-body"]}`
  );

  let tick = 0;
  const anomalies = new AnomalyLedger({
    now: () => {
      tick += 1;
      return CLOCK_START + tick * 1000;
    },
  });
  anomalies.record({
    kind: "vault-mount-failure",
    severity: "error",
    code: "vault.mount.schema-mismatch",
    component: "serve.vault-registry",
    error: new Error(
      `mount of "${SENTINELS["vault-name"]}" failed at ${SENTINELS["absolute-path"]}`
    ),
    facts: { attempt: 2, epoch: 7 },
  });
  anomalies.record({
    kind: "vault-mount-failure",
    severity: "error",
    code: "vault.mount.schema-mismatch",
    component: "serve.vault-registry",
    message: `retry for ${SENTINELS["person-name"]}`,
    facts: { attempt: 3, epoch: 7 },
  });
  anomalies.record({
    kind: "disk-full",
    severity: "error",
    code: "disk.full.append",
    component: "serve.log-store",
    message: `ENOSPC at ${SENTINELS["absolute-path"]}/gateway.jsonl`,
    facts: { droppedWrites: 41 },
  });

  const input = await collectSupportBundleInput({
    health,
    logs,
    anomalies,
    planes: [plane],
    gateway: {
      version: "0.42.1",
      protocolVersion: 11,
      minSupportedProtocol: 9,
    },
    runtime: { platform: "linux", arch: "x64", nodeVersion: "v24.4.0" },
    generatedAtMs: CLOCK_START,
    salt: "w8-canary-salt",
    config: {
      dataDir: SENTINELS["absolute-path"],
      backup: {
        provider: "s3",
        accessToken: SENTINELS["bearer-token"],
        endpoint: SENTINELS["url-credential"],
      },
      owner: SENTINELS["person-name"],
      experimental: true,
      mountedVaults: 1,
    },
    extraSensitive: [SENTINELS["bearer-token"], SENTINELS.passphrase],
  });

  return {
    input,
    sealedSentinels: { ...profile.sealedSentinels },
    planeStop: () => plane.stop(),
    diagnosticsVaultName: plane.name,
  };
}

let rigPromise: Promise<Rig> | undefined;

function getRig(): Promise<Rig> {
  rigPromise ??= buildRig();
  return rigPromise;
}

describe("W8.1 diagnostics leak canary", () => {
  afterAll(async () => {
    if (rigPromise) (await rigPromise).planeStop();
  });

  test.each(["strict", "standard"] as const)(
    "the %s support bundle carries no sentinel of any class",
    async (level) => {
      const rig = await getRig();
      {
        const rendered = renderSupportBundle({ ...rig.input, level });
        assertNoLeak(rendered.text, rig.sealedSentinels);
        expect(rendered.text).not.toContain("CENTRAID-SEALED-");
        expect(rendered.text).not.toContain("Year 3 person");
        expect(rendered.text).not.toContain(rig.diagnosticsVaultName);
        expect(() => JSON.parse(rendered.text)).not.toThrow();
      }
    }
  );

  test("the bundle is genuinely useful, not merely empty", async () => {
    const rig = await getRig();
    {
      const rendered = renderSupportBundle(rig.input);
      const bundle = rendered.bundle;
      expect(bundle.gateway.version).toBe("0.42.1");
      expect(bundle.gateway.protocolVersion).toBe(11);
      expect(bundle.runtime.platform).toBe("linux");
      expect(bundle.health.status).toBe("error");
      const failing = bundle.health.components.find(
        (component) => component.component === "storage-latency"
      );
      expect(failing?.status).toBe("error");
      expect(failing?.errorCount).toBeGreaterThan(0);
      expect(bundle.anomalies.count).toBe(3);
      expect(bundle.anomalies.histogram["vault.mount.schema-mismatch"]).toBe(2);
      expect(bundle.anomalies.histogram["disk.full.append"]).toBe(1);
      const mount = bundle.anomalies.records[0] as Record<string, unknown>;
      expect(mount.component).toBe("serve.vault-registry");
      expect(mount.facts).toStrictEqual({ attempt: 2, epoch: 7 });
      expect((mount.stack as string[]).length).toBeGreaterThan(0);
      expect(bundle.logs.count).toBeGreaterThanOrEqual(9);
      expect(Object.keys(bundle.logs.byLevel).toSorted()).toStrictEqual([
        "error",
        "info",
        "warn",
      ]);
      const components = bundle.logs.groups.map((group) => group.component);
      expect(components).toContain("vault-registry");
      expect(components).toContain("backup-service");
      expect(
        bundle.logs.groups.every((group) => group.digests.length > 0)
      ).toBe(true);
      const storage = bundle.storage[0] as Record<string, unknown>;
      expect(storage.vaultDbBytes).toBeGreaterThan(0);
      const counts = storage.tableRowCounts as Record<string, number>;
      expect(Object.keys(counts).length).toBeGreaterThan(3);
      expect(JSON.stringify(bundle.config)).toContain('"provider":"s3"');
      expect(JSON.stringify(bundle.config)).toContain('"mountedVaults":1');
      expect(rendered.bytes).toBeGreaterThan(2000);
      expect(bundle.redaction.leaves).toBeGreaterThan(60);
      expect(
        bundle.redaction.redactedLeaves / bundle.redaction.leaves
      ).toBeLessThan(0.6);
    }
  });

  test("the redaction report names which rules fired, per class", async () => {
    const rig = await getRig();
    {
      const bundle = buildSupportBundle({ ...rig.input, level: "standard" });
      const fired = Object.entries(bundle.redaction.byRule)
        .filter(([, count]) => count > 0)
        .map(([rule]) => rule)
        .toSorted();
      for (const rule of [
        "absolute-path",
        "email",
        "high-entropy",
        "payment-card",
        "quoted-value",
        "secret-key",
        "url",
      ])
        expect(
          fired,
          `${rule} never fired against the seeded corpus`
        ).toContain(rule);
    }
  });

  test("a value the policy misses is caught, counted and reported by the tripwire", async () => {
    const rig = await getRig();
    {
      const bundle = buildSupportBundle({ ...rig.input, level: "standard" });
      const leaky = {
        ...bundle,
        disclosure: [...bundle.disclosure, SENTINELS["vault-name"]],
      };
      const serialized = serializeSupportBundle(
        leaky,
        rig.input.sensitiveLiterals ?? []
      );
      expect(serialized.tripwireHits).toBeGreaterThan(0);
      assertNoLeak(serialized.text);
      const parsed = JSON.parse(serialized.text) as {
        redaction: { byRule: Record<string, number> };
      };
      expect(parsed.redaction.byRule.tripwire).toBe(serialized.tripwireHits);
    }
  });

  test("the bundle is deterministic under a fixed clock and salt", async () => {
    const rig = await getRig();
    expect(renderSupportBundle(rig.input).text).toBe(
      renderSupportBundle(rig.input).text
    );
    expect(renderSupportBundle({ ...rig.input, level: "standard" }).text).toBe(
      renderSupportBundle({ ...rig.input, level: "standard" }).text
    );
  });

  test("the diagnostics endpoint document carries no owner-authored name", async () => {
    const dir = await tempDir("quality-w8-endpoint-");
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      ownerName: SENTINELS["person-name"],
      vaultName: SENTINELS["vault-name"],
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      enableWalShipper: false,
    });
    const logs = new GatewayLogStore();
    try {
      const input = await collectSupportBundleInput({
        health: new HealthRegistry({ now: () => CLOCK_START }),
        logs,
        anomalies: { snapshot: () => [] },
        planes: [plane],
        gateway: {
          version: "0.0.0-test",
          protocolVersion: 1,
          minSupportedProtocol: 1,
        },
        runtime: { platform: "linux", arch: "x64", nodeVersion: "v24.0.0" },
        generatedAtMs: CLOCK_START,
        salt: seededHex("endpoint-salt", 32),
        level: "standard",
        config: { accessToken: SENTINELS["bearer-token"] },
      });
      const text = renderSupportBundle(input).text;
      expect(text).not.toContain(SENTINELS["bearer-token"]);
      expect(text).not.toContain(SENTINELS["vault-name"]);
      expect(text).not.toContain(SENTINELS["person-name"]);
      assertNoLeak(text);
      const parsed = JSON.parse(text) as {
        storage: { vaultId: unknown; name?: unknown }[];
        redaction: { level: string };
      };
      expect(parsed.storage).toHaveLength(1);
      expect(parsed.storage[0]?.vaultId).toBeTypeOf("string");
      expect(parsed.storage[0]).not.toHaveProperty("name");
      expect(parsed.redaction.level).toBe("standard");
    } finally {
      plane.stop();
    }
  });
});

export type { SentinelClass };
