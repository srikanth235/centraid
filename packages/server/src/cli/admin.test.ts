// governance: allow-repo-hygiene file-size-limit (#639) — the stopped-daemon
// admin scenarios share one fixture and command-dispatch contract.
import crypto from "node:crypto";
/*
 * Stopped-daemon filesystem maintenance (#289):
 * `centraid-gateway vault|devices|pair` plus the daemon device plane. Tests
 * call the dispatched command functions, asserting stdout + gateway.db rows.
 */
import { promises as fs } from "node:fs";
import type http from "node:http";

import { describe, afterEach, beforeEach, expect, test, vi } from "vitest";

import { buildGatewayInfoPayload } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { endpointIdForSecret } from "@centraid/tunnel";
import { KeyStore } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.ts";
import { OwnerStore } from "../serve/owner-store.ts";
import {
  encodePairingTicket,
  PairingTicketStore,
} from "../serve/pairing-store.ts";
import { openVaultRegistry } from "../serve/vault-registry.ts";
import { capture, CliFailError, fail, lastJson } from "./admin-test-kit.ts";
import { commandDevices, commandPair } from "./device-admin.ts";
import {
  DEVICE_HEADER,
  DEVICE_PROOF_HEADER,
  makeDaemonDevicePlane,
} from "./endpoint-host.ts";
import { daemonKeyStore } from "./key-store.ts";
import { landlordBearerForEndpointSecret } from "./landlord-auth.ts";
import { daemonLayoutFor } from "./paths.ts";
import { commandVault } from "./vault-admin.ts";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
// The slowest file in the suite: every test bootstraps a real vault/daemon
// layout on disk, so it is the most fsync-bound thing we run. It needs an
// escalation ABOVE the 30s node-project default in @centraid/test-kit/vitest
// (see the measurements there). Sizing: the slowest single test here measured
// ~5.6s on a fast host; at the ~10x worst observed hosted-runner disk penalty
// that is ~56s, so 60s. The earlier 15s budget blamed v8 coverage
// instrumentation, which was the wrong variable — coverage runs in the ci lane
// too and passes there — and 15s was duly still too small: this file timed out
// twice in nightly run 29733737906 (102s wall for 13 tests vs 20s in ci).
vi.setConfig({ testTimeout: 60_000 });

let dataDir: string;

describe("admin scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`admin-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function fakePairDaemon(): Promise<typeof fetch> {
    const layout = daemonLayoutFor(dataDir);
    const secret = Buffer.alloc(32, 7);
    new KeyStore(layout.keysDir).store("endpoint-key.bin", secret);
    const endpointId = endpointIdForSecret(secret);
    return (async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url
      );
      if (url.pathname === "/centraid/_gateway/info") {
        // Mirror production #568 item C: dial tickets only for authenticated callers.
        const headers = new Headers(init?.headers);
        const authorized =
          headers.get("authorization") ===
          `Bearer ${landlordBearerForEndpointSecret(secret)}`;
        return Response.json(
          buildGatewayInfoPayload({
            instanceId: "test-daemon",
            startedAt: Date.now(),
            uptimeMs: 1,
            authenticated: authorized,
            endpointId,
            ...(authorized ? { endpointTicket: "gw-ticket-base32" } : {}),
          })
        );
      }
      if (url.pathname !== "/centraid/_gateway/devices/ticket") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        vaultId?: string;
        ttlMinutes?: number;
      };
      const registry = openVaultRegistry({
        rootDir: layout.vaultDir,
        // The daemon this stands in for opens custody the same way; a bare
        // KeyStore cannot unwrap a protected sealkey and would mount nothing
        // (#568).
        keyStore: daemonKeyStore(layout.keysDir),
        logger: silentLogger,
        enableWalShipper: false,
      });
      try {
        const vaults = registry.list();
        const vault =
          vaults.find(
            (row) => row.vaultId === body.vaultId || row.name === body.vaultId
          ) ?? vaults[0];
        if (!vault) {
          return Response.json(
            {
              error: "vault_required",
              message: "this gateway has no vault to invite into",
            },
            { status: 409 }
          );
        }
        const tickets = PairingTicketStore.open(layout.gatewayDbFile);
        // The daemon owns the invitation: it names the owner and the vault
        // list; the CLI only carries the token (#599 Decision 5, #726).
        const owners = OwnerStore.open(tickets.gatewayDatabase);
        const ownerId = owners.ownerOf(vault.vaultId);
        const owner =
          ownerId === undefined
            ? (() => {
                const created = owners.create("The owner");
                owners.setOwner(vault.vaultId, created.ownerId);
                return created;
              })()
            : owners.get(ownerId)!;
        const ttl = (body.ttlMinutes ?? 15) * 60_000;
        const minted = tickets.mint(
          { ownerId: owner.ownerId, vaultIds: [vault.vaultId] },
          ttl
        );
        return Response.json({
          ok: true,
          ownerId: owner.ownerId,
          ownerLabel: owner.label,
          vaults: [{ vaultId: vault.vaultId, vaultName: vault.name }],
          ticket: encodePairingTicket({
            v: 1,
            kind: "centraid-gw-pair",
            gw: "gw-ticket-base32",
            t: minted.ticketId,
            s: minted.secret,
            vaultName: vault.name,
            exp: minted.expiresAt,
          }),
          vaultId: vault.vaultId,
          vaultName: vault.name,
          expiresAt: new Date(minted.expiresAt).toISOString(),
        });
      } finally {
        registry.stop();
      }
    }) as typeof fetch;
  }

  // ── devices admin ─────────────────────────────────────────────────────

  test("devices add / list / revoke, scoped by vault", async () => {
    const family = lastJson(
      await capture(() =>
        commandVault(
          ["create", "--data-dir", dataDir, "--name", "Family"],
          fail
        )
      )
    );
    const vaultId = family.vaultId as string;

    const added = lastJson(
      await capture(() =>
        commandDevices(
          [
            "add",
            "--data-dir",
            dataDir,
            "ep-laptop",
            "--vault",
            "Family",
            "--label",
            "Priya laptop",
          ],
          fail
        )
      )
    );
    expect(added).toMatchObject({
      endpointId: "ep-laptop",
      vaultId,
      label: "Priya laptop",
    });

    const listed = (
      await capture(() =>
        commandDevices(
          ["list", "--data-dir", dataDir, "--vault", "Family"],
          fail
        )
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(listed).toHaveLength(1);

    const revoked = lastJson(
      await capture(() =>
        commandDevices(
          [
            "revoke",
            "--data-dir",
            dataDir,
            "ep-laptop",
            "--confirm-last-device",
            "Family",
          ],
          fail
        )
      )
    );
    expect(revoked).toHaveProperty("revoked");
    // Revoking an unknown device fails loudly.
    await expect(
      capture(() =>
        commandDevices(["revoke", "--data-dir", dataDir, "ep-gone"], fail)
      )
    ).rejects.toThrow(/no enrollment/u);
  });

  test("last-device revoke requires the vault name and SSH can restore a device", async () => {
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );
    const owner = lastJson(
      await capture(() =>
        commandDevices(
          ["add", "--data-dir", dataDir, "ep-owner", "--vault", "Family"],
          fail
        )
      )
    );
    const enrollmentId = owner.enrollmentId as string;

    await expect(
      capture(() =>
        commandDevices(["revoke", "--data-dir", dataDir, enrollmentId], fail)
      )
    ).rejects.toThrow(/last device.*--confirm-last-device "Family"/iu);

    await capture(() =>
      commandDevices(
        [
          "revoke",
          "--data-dir",
          dataDir,
          enrollmentId,
          "--confirm-last-device",
          "Family",
        ],
        fail
      )
    );

    // The owner and their vault_owners row survive the tombstone, so the
    // host lane can bring a replacement device in for the SAME owner.
    const recovered = lastJson(
      await capture(() =>
        commandDevices(
          ["add", "--data-dir", dataDir, "ep-recovery", "--vault", "Family"],
          fail
        )
      )
    );
    expect(recovered).toMatchObject({
      endpointId: "ep-recovery",
      ownerId: owner.ownerId,
    });
  });

  test("devices admin rejects bad usage + unknown vault", async () => {
    await expect(
      capture(() => commandDevices(["bogus", "--data-dir", dataDir], fail))
    ).rejects.toThrow(/list, add, revoke/u);
    await expect(
      capture(() => commandDevices(["add", "--data-dir", dataDir], fail))
    ).rejects.toThrow(/devices add/u);
    await expect(
      capture(() =>
        commandDevices(
          ["add", "--data-dir", dataDir, "ep-x", "--vault", "no-such"],
          fail
        )
      )
    ).rejects.toThrow(/no vault named/u);
  });

  // ── pair ──────────────────────────────────────────────────────────────

  test("pair needs the daemon endpoint identity, then mints a pasteable ticket", async () => {
    // Host custody key is required before the daemon handshake (auth-gated
    // endpointTicket, #568 item C) — empty data dir fails for that reason first.
    await expect(
      capture(() =>
        commandPair(["--data-dir", dataDir], fail, async () => {
          throw new Error("connection refused");
        })
      )
    ).rejects.toThrow(/no gateway endpoint identity/u);

    const layout = daemonLayoutFor(dataDir);
    // Bootstrap a vault the ticket can name.
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );
    // Key present but daemon unreachable → "daemon not running".
    new KeyStore(layout.keysDir).store("endpoint-key.bin", Buffer.alloc(32, 3));
    await expect(
      capture(() =>
        commandPair(["--data-dir", dataDir], fail, async () => {
          throw new Error("connection refused");
        })
      )
    ).rejects.toThrow(/daemon not running/u);

    const daemon = await fakePairDaemon();

    const text = await capture(() =>
      commandPair(
        ["--data-dir", dataDir, "--vault", "Family", "--ttl-minutes", "5"],
        fail,
        daemon
      )
    );
    expect(text).toMatch(/Pairing ticket for The owner/u);
    expect(text).toMatch(/Family \(.*\)/u);
    // The pasteable token is the sole base64url line in the human block.
    const token = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^[A-Za-z0-9_-]{40,}$/u.test(l));
    expect(token).toBeTruthy();
    const payload = JSON.parse(
      Buffer.from(token!, "base64url").toString("utf8")
    ) as {
      kind: string;
      gw: string;
      vaultName: string;
      t: string;
      s: string;
    };
    expect(payload).toMatchObject({
      kind: "centraid-gw-pair",
      gw: "gw-ticket-base32",
      vaultName: "Family",
    });
    expect(
      PairingTicketStore.open(layout.gatewayDbFile).redeem(payload.t, payload.s)
    ).toMatchObject({
      ownerId: expect.any(String) as unknown as string,
      vaultIds: [expect.any(String) as unknown as string],
    });
  });

  test("pair --qr prints a terminal QR of the same pasteable ticket", async () => {
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );
    const daemon = await fakePairDaemon();

    const text = await capture(() =>
      commandPair(
        ["--data-dir", dataDir, "--vault", "Family", "--qr"],
        fail,
        daemon
      )
    );
    expect(text).toMatch(/Pairing ticket for The owner/u);
    expect(text).toMatch(/Phone: scan this QR/u);
    // Token still present and decodable.
    const token = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^[A-Za-z0-9_-]{40,}$/u.test(l));
    expect(token).toBeTruthy();
    const payload = JSON.parse(
      Buffer.from(token!, "base64url").toString("utf8")
    ) as {
      kind: string;
    };
    expect(payload.kind).toBe("centraid-gw-pair");
    // Terminal QR is multi-line block art.
    expect(text.split("\n").length).toBeGreaterThan(12);
    expect(text).toMatch(/[█▄▀ ]/u);
  });

  test("pair --json emits one JSON line instead of the pasteable text block (issue #382)", async () => {
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );
    const daemon = await fakePairDaemon();

    const line = await capture(() =>
      commandPair(
        ["--data-dir", dataDir, "--vault", "Family", "--json"],
        fail,
        daemon
      )
    );
    const parsed = lastJson(line);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("ticket");
    expect(parsed).toHaveProperty("vaultId");
    expect(parsed).toMatchObject({ vaultName: "Family" });
    expect(parsed.expiresAt).toBeTypeOf("string");
    // The ticket itself still decodes to the same payload shape as the human path.
    const payload = JSON.parse(
      Buffer.from(parsed.ticket as string, "base64url").toString("utf8")
    ) as { kind: string; vaultName: string };
    expect(payload).toMatchObject({
      kind: "centraid-gw-pair",
      vaultName: "Family",
    });
  });

  test("pair mints for the vault's owner and the retired role flag is refused", async () => {
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );
    const daemon = await fakePairDaemon();

    // Ordinary pairing is never sensitive to whether this happens to be the
    // first enrollment row.
    const first = lastJson(
      await capture(() =>
        commandPair(
          ["--data-dir", dataDir, "--vault", "Family", "--json"],
          fail,
          daemon
        )
      )
    );
    expect(first.ownerId).toBeTypeOf("string");

    // Enroll a device so the vault is no longer empty.
    await capture(() =>
      commandDevices(
        ["add", "--data-dir", dataDir, "ep-first", "--vault", "Family"],
        fail
      )
    );

    // A later pairing mints for the same owner — access is ownership.
    const second = lastJson(
      await capture(() =>
        commandPair(
          ["--data-dir", dataDir, "--vault", "Family", "--json"],
          fail,
          daemon
        )
      )
    );
    expect(second.ownerId).toBe(first.ownerId);

    // Role flags died with the role lattice (#726).
    await expect(
      commandPair(
        ["--data-dir", dataDir, "--vault", "Family", "--role", "admin"],
        fail,
        daemon
      )
    ).rejects.toThrow(/unknown flag/u);
  });

  test("pair --json failure emits {ok:false,error,message} on stdout, then still fails the process", async () => {
    let captured = "";
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      captured += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(
        commandPair(["--data-dir", dataDir, "--json"], fail, async () => {
          throw new Error("connection refused");
        })
      ).rejects.toThrow(CliFailError);
    } finally {
      process.stdout.write = original;
    }
    const parsed = lastJson(captured);
    expect(parsed).toMatchObject({ ok: false, error: "error" });
    expect(parsed.message).toBeTypeOf("string");
  });

  // ── daemon device plane (deviceAccess + ticket redemption) ─────────────

  test("device plane: deviceKeyFor trusts only the in-process proof header", async () => {
    const layout = daemonLayoutFor(dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    await capture(() =>
      commandVault(["create", "--data-dir", dataDir, "--name", "Family"], fail)
    );

    // Enroll a device out of band, then check the deviceAccess resolution.
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: silentLogger,
    });
    const vaultId = registry.defaultVaultId();
    EnrollmentStore.open(layout.gatewayDbFile).enroll({
      endpointId: "ep-known",
      vaultIds: [vaultId],
      label: "known",
    });
    const plane = makeDaemonDevicePlane({
      layout,
      vaults: () => registry,
      logger: silentLogger,
      loopbackEndpointId: "ep-host-custody",
    });

    const bare = {
      headers: {},
      socket: { remoteAddress: "10.0.0.1" },
    } as unknown as http.IncomingMessage;
    expect(plane.deviceAccess.deviceKeyFor(bare)).toBeUndefined();

    // Kernel-observed loopback uses host custody; Iroh still proves remotes.
    const loopback = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    expect(plane.deviceAccess.deviceKeyFor(loopback)).toBe("ep-host-custody");

    // A device header without the process proof is refused.
    const spoof = {
      headers: { [DEVICE_HEADER]: "ep-known", [DEVICE_PROOF_HEADER]: "forged" },
    } as unknown as http.IncomingMessage;
    expect(plane.deviceAccess.deviceKeyFor(spoof)).toBeUndefined();

    expect(plane.deviceAccess.vaultsFor("ep-known")).toStrictEqual([vaultId]);
    expect(plane.deviceAccess.vaultsFor("ep-nobody")).toStrictEqual([]);
    registry.stop();
  });

  test("device plane: an unenrolled endpoint derives identity from the custody key", async () => {
    const layout = daemonLayoutFor(dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      keyStore: daemonKeyStore(layout.keysDir),
      logger: silentLogger,
    });
    const plane = makeDaemonDevicePlane({
      layout,
      vaults: () => registry,
      logger: silentLogger,
      relays: "disabled",
    });
    expect(registry.isFresh()).toBe(true);
    // An enrollment is the ONLY admission (#603), so an unknown EndpointId is
    // refused even on a fresh dir.
    expect(plane.dataPlaneControl.authorize("first-device")).toMatchObject({
      allowed: false,
    });
    // Relays disabled keeps the endpoint offline; identity remains derivable
    // from the custody key without a stale address cache.
    const handle = await plane.startEndpoint({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    try {
      expect(handle?.endpointId).toBeTruthy();
      const secret = new KeyStore(layout.keysDir).load("endpoint-key.bin");
      expect(secret).not.toBeNull();
      expect(endpointIdForSecret(secret!)).toBe(handle!.endpointId);
      expect(handle!.ticket()).toBeTruthy();
    } finally {
      await handle?.close();
      registry.stop();
    }
  });
});
