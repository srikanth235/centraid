import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { serve } from "@centraid/server";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

import { startDesktopEmbeddedGateway } from "./embedded-gateway.js";

const roots: string[] = [];

const PARITY_TIMEOUT_MS = 120_000;
const FOUNDING_TIMEOUT_MS = 30_000;

describe("embedded-gateway-layout scenarios", () => {
  afterEach(async () =>
    forEachSequentially(roots.splice(0).toReversed(), (root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );

  function pathsFor(root: string) {
    return {
      vaultDir: path.join(root, "vault"),
      cacheDir: path.join(root, "cache"),
      logsDir: path.join(root, "gateway-logs"),
      modelCatalogFile: path.join(root, "cache", "model-catalog.json"),
      modelPricingFile: path.join(root, "cache", "model-pricing.json"),
      templatesCacheDir: path.join(root, "cache", "templates"),
    };
  }

  async function seedWarmerCaches(root: string): Promise<void> {
    const cacheDir = path.join(root, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "model-pricing.json"),
      `${JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: {
          "fixture-model": {
            input_cost_per_token: 1e-6,
            output_cost_per_token: 2e-6,
          },
        },
      })}\n`
    );
    await fs.writeFile(
      path.join(cacheDir, "model-catalog.json"),
      `${JSON.stringify({ version: 2, runners: {} }, null, 2)}\n`
    );
  }

  const WARMER_CACHE_FILES = new Set([
    path.join("cache", "model-catalog.json"),
    path.join("cache", "model-pricing.json"),
  ]);

  async function treeShape(root: string, relative = ""): Promise<string[]> {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    const result = await Promise.all(
      entries.map(async (entry) => {
        const child = path.join(relative, entry.name);
        if (WARMER_CACHE_FILES.has(child)) return [];
        const row = `${entry.isDirectory() ? "d" : "f"}:${child}`;
        return entry.isDirectory()
          ? [row, ...(await treeShape(root, child))]
          : [row];
      })
    );
    return result.flat().sort();
  }

  function normalizeDynamicNames(entries: string[]): string[] {
    return [
      ...new Set(
        entries.map((entry) =>
          entry
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu,
              "<vault-id>"
            )
            .replace(/[0-9a-f]{40}/gu, "<git-object>")
            .replace(
              /(?<prefix>apps\.git\/objects\/)[0-9a-f]{2}(?=\/|$)/u,
              "$<prefix><git-prefix>"
            )
            .replace(
              /(?<prefix>apps\.git\/objects\/<git-prefix>\/)[0-9a-f]{38}$/u,
              "$<prefix><git-rest>"
            )
            .replace(/[0-9a-f]{32}/gu, "<wal-generation>")
            .replace(/\d{13}(?=\.(?:tick|seg)$)/gu, "<tick-ms>")
            .replace(/\d{12}-\d{12}-<tick-ms>\.seg$/u, "<wal-segment>.seg")
            .replace(/closed-\d{12}\.mrk$/u, "closed.mrk")
        )
      ),
    ].sort();
  }

  test(
    "actual Electron embed and headless daemon produce identical complete trees",
    async () => {
      const desktopRoot = await tempDir("desktop-embedded-layout-");
      const headlessRoot = await tempDir("headless-layout-");
      roots.push(desktopRoot, headlessRoot);
      await Promise.all([
        seedWarmerCaches(desktopRoot),
        seedWarmerCaches(headlessRoot),
      ]);
      const protector = aesGcmKeyProtector(Buffer.alloc(32, 0x42));
      const desktop = await startDesktopEmbeddedGateway({
        dataDir: desktopRoot,
        paths: pathsFor(desktopRoot),
        keyStore: new KeyStore(path.join(desktopRoot, "keys"), { protector }),
        token: "desktop-layout-token",
        ownerEndpointId: "desktop-device",
      });
      desktop.vaults.current().walShipper?.tick();
      await desktop.close();

      const headless = await serve({
        paths: { ...pathsFor(headlessRoot), dataDir: headlessRoot },
        keyStore: new KeyStore(path.join(headlessRoot, "keys"), { protector }),
        token: "headless-layout-token",
        hostDeviceEndpointId: "desktop-device",
      });
      headless.vaults.current().walShipper?.tick();
      await headless.close();

      expect(normalizeDynamicNames(await treeShape(desktopRoot))).toStrictEqual(
        normalizeDynamicNames(await treeShape(headlessRoot))
      );
    },
    PARITY_TIMEOUT_MS
  );

  test(
    "actual Electron embed auto-founds Personal on a fresh data dir",
    async () => {
      const root = await tempDir("desktop-embedded-autofound-");
      roots.push(root);
      await seedWarmerCaches(root);
      const gateway = await startDesktopEmbeddedGateway({
        dataDir: root,
        paths: pathsFor(root),
        keyStore: new KeyStore(path.join(root, "keys"), {
          protector: aesGcmKeyProtector(Buffer.alloc(32, 0x43)),
        }),
        token: "desktop-autofound-token",
        ownerEndpointId: "a".repeat(64),
      });
      try {
        const response = await fetch(`${gateway.url}/centraid/_vault/vaults`, {
          headers: { Authorization: "Bearer desktop-autofound-token" },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          vaults?: Array<{ name?: string }>;
        };
        expect(
          (body.vaults ?? [])
            .map((vault) => vault.name)
            .sort((a, b) => String(a).localeCompare(String(b)))
        ).toStrictEqual(["Personal"]);

        const bootstrap = await fetch(
          `${gateway.url}/centraid/_vault/replica/bootstrap?window=100`,
          { headers: { Authorization: "Bearer desktop-autofound-token" } }
        );
        const bootstrapBody = await bootstrap.text();
        expect(bootstrap.status, bootstrapBody).toBe(200);
      } finally {
        await gateway.close();
      }
    },
    FOUNDING_TIMEOUT_MS
  );
});
// @vitest-environment node
