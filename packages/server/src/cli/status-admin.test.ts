import crypto from "node:crypto";
/*
 * `centraid-gateway status` (issue #382) — a data-dir-only unit test:
 * `--data-dir` given but no service ever installed, so `queryServiceStatus`
 * reports `installed: false` without shelling out to a real launchd/systemd
 * (both platforms handle "unit not found" as a normal, zero-exit read — see
 * `service-admin.ts`'s `launchdStatusInfo`/`systemdStatusInfo`). Darwin and
 * Linux CI runners both exercise the real OS probe this way; a `win32` CI
 * runner would hit the "not supported" branch instead — acceptable, `status`
 * inherits `service`'s two-platform scope.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { buildGatewayInfoPayload } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { endpointIdForSecret } from "@centraid/tunnel";
import { KeyStore } from "@centraid/vault";

import { landlordBearerForEndpointSecret } from "./landlord-auth.ts";
import { daemonLayoutFor } from "./paths.ts";
import { commandStatus } from "./status-admin.ts";
import { commandVault } from "./vault-admin.ts";

class CliFailError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
    this.name = "CliFailError";
  }
}
const fail = (message: string, code = 1): never => {
  throw new CliFailError(message, code);
};

let dataDir: string;

async function capture(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function lastJson(text: string): Record<string, unknown> {
  const lines = text.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe("status-admin scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`status-admin-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const servicePlatform =
    process.platform !== "darwin" && process.platform !== "linux";
  const offlineFetch = (async (): Promise<Response> => {
    throw new Error("connection refused");
  }) as typeof fetch;

  // #545 A10 — skipIf so report-signals sees the skip (bare return was false-green).
  test.skipIf(servicePlatform)(
    "status --json uses the shared default data dir (never-installed unit reads clean)",
    async () => {
      // An explicit, per-run label. Without it the probe asks launchd/systemd
      // about the DEFAULT label, so on any machine that actually runs Centraid
      // the service is installed and "never-installed" reads `true` — the test
      // was asserting a property of the host, not of the code (#656).
      const neverInstalled = `dev.centraid.never-installed.${crypto.randomUUID()}`;
      const parsed = lastJson(
        await capture(() =>
          commandStatus(
            ["--data-dir", dataDir, "--label", neverInstalled, "--json"],
            fail,
            offlineFetch
          )
        )
      );
      expect(parsed.ok).toBe(true);
      expect(parsed.dataDir).toMatchObject({
        dataDir,
        exists: true,
        daemonRunning: false,
      });
      const service = parsed.service as { installed: boolean; label: string };
      expect(service.installed).toBe(false);
      expect(service.label).toBe(neverInstalled);
    }
  );

  test.skipIf(servicePlatform)(
    "status --json with --data-dir adds the data-dir summary (exists, endpoint identity, vault count)",
    async () => {
      // A vault + endpoint custody key, same as a daemon that has booted once.
      await capture(() =>
        commandVault(
          ["create", "--data-dir", dataDir, "--name", "Family"],
          fail
        )
      );
      const layout = daemonLayoutFor(dataDir);
      const secret = Buffer.alloc(32, 11);
      new KeyStore(layout.keysDir).store("endpoint-key.bin", secret);
      const endpointId = endpointIdForSecret(secret);
      const liveFetch = (async (
        _input: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        // Mirror production #568 item C: dial tickets only for authenticated callers.
        const headers = new Headers(init?.headers);
        const authorized =
          headers.get("authorization") ===
          `Bearer ${landlordBearerForEndpointSecret(secret)}`;
        return Response.json(
          buildGatewayInfoPayload({
            instanceId: "daemon",
            startedAt: Date.now(),
            uptimeMs: 1,
            authenticated: authorized,
            endpointId,
            ...(authorized ? { endpointTicket: "gw-ticket-base32" } : {}),
          })
        );
      }) as typeof fetch;

      const parsed = lastJson(
        await capture(() =>
          commandStatus(["--data-dir", dataDir, "--json"], fail, liveFetch)
        )
      );
      expect(parsed.ok).toBe(true);
      const summary = parsed.dataDir as {
        exists: boolean;
        endpointId?: string;
        endpointTicket?: string;
        vaultCount?: number;
      };
      expect(summary.exists).toBe(true);
      expect(summary.endpointId).toBe(endpointId);
      expect(summary.endpointTicket).toBe("gw-ticket-base32");
      expect(summary.vaultCount).toBe(1);
    }
  );

  test.skipIf(servicePlatform)(
    "status --json against a --data-dir that does not exist reports exists:false, no throw",
    async () => {
      const missing = path.join(dataDir, "never-created");
      const parsed = lastJson(
        await capture(() =>
          commandStatus(["--data-dir", missing, "--json"], fail, offlineFetch)
        )
      );
      expect(parsed.ok).toBe(true);
      const summary = parsed.dataDir as {
        exists: boolean;
        endpointId?: string;
      };
      expect(summary.exists).toBe(false);
      expect(summary.endpointId).toBeUndefined();
    }
  );

  test.skipIf(servicePlatform)(
    "status (human mode) prints readable lines, not JSON",
    async () => {
      const text = await capture(() =>
        commandStatus(["--data-dir", dataDir], fail, offlineFetch)
      );
      expect(text).toContain("service:");
      expect(text).toContain("data dir:");
      expect(() => JSON.parse(text)).toThrow(SyntaxError);
    }
  );

  test("status --json rejects an unknown flag as a usage error", async () => {
    let captured = "";
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(commandStatus(["--bogus", "--json"], fail)).rejects.toThrow(
        /unknown flag/u
      );
    } finally {
      process.stdout.write = original;
    }
    const parsed = lastJson(captured);
    expect(parsed).toMatchObject({ ok: false, error: "usage" });
  });
});
