/*
 * THE HOST OWNS THE NETWORK (#1011, docs/config-ownership.md).
 *
 * `BuildGatewayOptions.modelAssets.provision` defaults to `"verify-only"`, so
 * a gateway nobody configured — a test, an e2e harness, an embedded build
 * someone forgot — reports what is on disk and never opens a connection.
 * These two tests are the pair that keeps that true from both ends: an
 * unconfigured `serve()` reaches nothing, and every production host says
 * `"fetch"` out loud.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { NOT_PROVISIONED_DETAIL } from "../enrich/system-model-assets.js";
import { serve } from "./serve.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

interface HealthSnapshotBody {
  components?: { component: string; status: string; detail?: string }[];
}

describe("system model assets provisioning is the host's decision (#1011)", () => {
  test("an unconfigured serve() opens no connection and says it is not provisioned", async () => {
    // OBSERVED, not asserted from the option: every non-loopback request the
    // process makes during the boot window is recorded, so a fetch would be
    // named here rather than merely presumed absent.
    const offBox: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      );
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
        offBox.push(url.href);
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
    onTestFinished(() => {
      globalThis.fetch = realFetch;
    });

    const dataDir = await tempDir("model-assets-provision-");
    const token = "model-assets-provision-token";
    // No `modelAssets` on purpose: this is the shape every unconfigured host
    // has, and the default has to be the safe one.
    const handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") },
      token,
    });
    onTestFinished(async () => {
      await handle.close().catch(() => undefined);
    });

    // Provisioning is deliberately off the boot path, so poll rather than
    // assume the first snapshot has it.
    let detail: string | undefined;
    for (let attempt = 0; attempt < 60 && detail === undefined; attempt += 1) {
      // Serial by construction: one poll of one gateway.
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(`${handle.url}/centraid/_gateway/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // oxlint-disable-next-line no-await-in-loop
      const body = (await response.json()) as HealthSnapshotBody;
      detail = (body.components ?? []).find(
        (entry) => entry.component === "recognition-models"
      )?.detail;
      if (detail === undefined)
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          globalThis.setTimeout(resolve, 100);
        });
    }

    expect(detail, "the recognition-models component never reported").toContain(
      NOT_PROVISIONED_DETAIL
    );
    // An unconfigured host is told what is missing, not told to wait.
    expect(detail).not.toContain("retrying in");
    expect(offBox, "an unconfigured boot reached off this box").toStrictEqual(
      []
    );
  }, 60_000);

  test("every production host passes provision: fetch explicitly", () => {
    // STATIC, and honest about it: booting the daemon and the Electron main
    // process to observe the option would be a far larger harness than the
    // fact deserves, so the assertion is over the call sites themselves. It
    // is a sweep, not a list — a new host that calls `serve({` without the
    // option fails here rather than silently inheriting `verify-only`.
    const entries = [
      "packages/server/src/cli/cli.ts",
      "apps/desktop/src/main/embedded-gateway.ts",
    ];
    for (const entry of entries) {
      const source = readFileSync(path.join(REPO_ROOT, entry), "utf8");
      expect(source, `${entry} boots a gateway`).toContain("serve({");
      expect(
        source,
        `${entry} must say provision: "fetch" — the gateway default is verify-only`
      ).toContain('modelAssets: { provision: "fetch" }');
    }
  });
});
