/*
 * W8.1 diagnostics leak canary (#842).
 *
 * The sibling of the T3 sealed canary in `user-facing-qualities.test.ts`,
 * pointed at the one artifact designed to leave the machine. T3 asks "can
 * a sealed column reach a product surface"; this asks the harder version:
 * a REALISTIC vault is seeded with sentinels of every class a support
 * bundle could plausibly carry — sealed columns, person names, the
 * owner-authored vault name, emails, phone numbers, a payment card, note
 * bodies, absolute paths, URLs with credentials in the query, a bearer
 * token, the vault's own seal key and identity seed — those values are
 * then pushed through the paths that actually interpolate owner data
 * (gateway log lines, health details, anomaly messages, the config
 * summary), the bundle is rendered at BOTH redaction levels, and every
 * sentinel is swept for.
 *
 * The sweep alone would pass on an empty document, which is the failure
 * mode this file exists to avoid, so the usefulness assertions are the
 * other half of the gate and are as specific as the leak assertions: the
 * bundle must still name the failing component, its error count, the
 * anomaly codes and their recurrence, the log component/level histogram,
 * the storage sizing, and the redaction accounting.
 *
 * Determinism: sentinels come from a seeded generator and the clock is
 * injected. Two runs produce byte-identical bundles.
 */

import { createHash } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import { ensureConversationLedger } from "@centraid/server/engine";

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

/** Seeded, no `Math.random`: the sentinel corpus is reproducible. */
function seededHex(label: string, length: number): string {
  return createHash("sha256")
    .update(`842-w8-canary:${label}`)
    .digest("hex")
    .slice(0, length);
}

/**
 * One sentinel per leak CLASS. The class label is what a failure message
 * names, so a red run says which kind of data escaped, not just which
 * string.
 */
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
  ensureConversationLedger(db.journal);
  seedYear3Vault(
    {
      vault: db.vault,
      journal: db.journal,
      // The canary does not need real sealing to test the BUNDLE: the
      // sentinels must be absent from the bundle whether the column is
      // sealed at rest or not. Storing them in the clear is the stronger
      // starting position — if the bundle cannot leak a plaintext row it
      // certainly cannot leak a sealed one.
      sealCell: (_entity, _column, _rowId, plaintext) => plaintext,
    },
    { parties: 12, photos: 24, conversations: 2, turnsPerConversation: 2 }
  );
  const profile = year3VaultProfile();

  // A person row and a note row carrying sentinels, exactly where a real
  // vault would hold them.
  db.vault
    .prepare(
      "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version) VALUES (?, 'person', ?, ?, ?, 'v0')"
    )
    .run(
      "w8-canary-person",
      SENTINELS["person-name"],
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );

  // The gateway log store, fed the way production feeds it: message
  // templates with owner values interpolated in.
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

  // Health, with owner data interpolated into a component detail — the
  // shape `reportDegraded(component, detail)` genuinely produces.
  const health = new HealthRegistry({ now: () => CLOCK_START });
  health.reportDegraded(
    "storage-latency",
    `p95 812ms writing "${SENTINELS["vault-name"]}" at ${SENTINELS["absolute-path"]}`
  );
  health.reportError(
    "storage-latency",
    `checkpoint of "${SENTINELS["vault-name"]}" stalled: ${SENTINELS["note-body"]}`
  );

  // Anomalies, recorded from a real Error whose message carries sentinels.
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

/*
 * The rig opens a real vault plane and seeds it; building it once and
 * sharing it across the cases keeps this file inside the quality lane's
 * budget. Every case is read-only against it — the two that mutate work on
 * a copy of the built bundle, never on the rig.
 */
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
        // The seeded fixture's own sealed-column sentinel prefix, swept as
        // a family rather than value by value.
        expect(rendered.text).not.toContain("CENTRAID-SEALED-");
        // Owner-authored names sampled straight out of the live vault.
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
      // Identity of the build that failed.
      expect(bundle.gateway.version).toBe("0.42.1");
      expect(bundle.gateway.protocolVersion).toBe(11);
      expect(bundle.runtime.platform).toBe("linux");
      // The failing component, by name, with its error count.
      expect(bundle.health.status).toBe("error");
      const failing = bundle.health.components.find(
        (component) => component.component === "storage-latency"
      );
      expect(failing?.status).toBe("error");
      expect(failing?.errorCount).toBeGreaterThan(0);
      // What went wrong, how often, and where in the code.
      expect(bundle.anomalies.count).toBe(3);
      expect(bundle.anomalies.histogram["vault.mount.schema-mismatch"]).toBe(2);
      expect(bundle.anomalies.histogram["disk.full.append"]).toBe(1);
      const mount = bundle.anomalies.records[0] as Record<string, unknown>;
      expect(mount.component).toBe("serve.vault-registry");
      expect(mount.facts).toStrictEqual({ attempt: 2, epoch: 7 });
      expect((mount.stack as string[]).length).toBeGreaterThan(0);
      // The log tail keeps its shape and its grep handles.
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
      // Storage sizing survives, so "how big is this vault" is answerable.
      const storage = bundle.storage[0] as Record<string, unknown>;
      expect(storage.vaultDbBytes).toBeGreaterThan(0);
      const counts = storage.tableRowCounts as Record<string, number>;
      expect(Object.keys(counts).length).toBeGreaterThan(3);
      // Non-secret config survives.
      expect(JSON.stringify(bundle.config)).toContain('"provider":"s3"');
      expect(JSON.stringify(bundle.config)).toContain('"mountedVaults":1');
      // And the document is a real document.
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
      // A lane that copied the owner's vault name straight through.
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
    // Determinism is a property of the BUILDER, not of two independently
    // created vaults: a fresh vault mints a new id and lands a different
    // number of bytes on disk, so rendering two rigs would only prove
    // SQLite is nondeterministic. Same input, same salt, same bytes.
    const rig = await getRig();
    expect(renderSupportBundle(rig.input).text).toBe(
      renderSupportBundle(rig.input).text
    );
    expect(renderSupportBundle({ ...rig.input, level: "standard" }).text).toBe(
      renderSupportBundle({ ...rig.input, level: "standard" }).text
    );
  });

  /*
   * REGRESSION LOCK for #846 P8, formerly the pin
   * "the legacy owner-facing diagnostics bundle still emits the vault name
   * verbatim".
   *
   * `GET /centraid/_gateway/diagnostics` used to be assembled by a second
   * builder (`gateway-diagnostics.ts`) that redacted only the `config`
   * object, by key name: the owner-authored vault name rode out verbatim in
   * `vaults[].name` and the log tail was embedded raw — in the one artifact
   * that module's own header told a person to attach to a support request.
   * That builder is retired; the endpoint now serves THIS bundle, which is
   * allowlist-by-construction.
   *
   * The composition below is `build-gateway.ts`'s `buildDiagnostics` closure
   * over a real vault plane, level and all. If the endpoint is ever rewired
   * back to a hand-assembled structure, this goes red.
   */
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
      // The key-name redaction that always worked, still working.
      expect(text).not.toContain(SENTINELS["bearer-token"]);
      // The half that did not: owner-authored names are gone from the
      // document this endpoint hands out.
      expect(text).not.toContain(SENTINELS["vault-name"]);
      expect(text).not.toContain(SENTINELS["person-name"]);
      assertNoLeak(text);
      // Still useful: the bundle names the vault it describes and its
      // storage sizing, it just does not name it in the owner's words.
      const parsed = JSON.parse(text) as {
        storage: { vaultId: unknown; name?: unknown }[];
        redaction: { level: string };
      };
      expect(parsed.storage).toHaveLength(1);
      expect(parsed.storage[0]?.vaultId).toBeTypeOf("string");
      // `name` is carried in the INPUT so the tripwire can refuse it, and is
      // emitted by no policy.
      expect(parsed.storage[0]).not.toHaveProperty("name");
      expect(parsed.redaction.level).toBe("standard");
    } finally {
      plane.stop();
    }
  });
});

export type { SentinelClass };
