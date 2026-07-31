// Client↔gateway seam laws for byte custody: the storage-connection CRUD +
// probe surface, the custody status stream, and the backup engine's control
// plane (#656 Layer 1B). Neither module had a test file; these state the wire
// contract (route, method, headers, body) and the typed-error mapping the UI
// branches on, not line coverage. Shared harness in
// gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  backup,
  installSeamContractHarness,
  json,
  respond,
  sent,
  sentJson,
  storage,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("storage-connection seam", () => {
  it("law: every connection verb rides its documented route and method", async () => {
    await storage.listStorageConnections();
    await storage.createStorageConnection({
      kind: "provider",
      name: "Home",
      baseUrl: "https://provider.test",
      apiKey: "secret",
    });
    await storage.updateStorageConnection("conn-1", { name: "Renamed" });
    await storage.testStorageConnection("conn-1");
    await storage.deleteStorageConnection("conn-1");
    await storage.getStorageStatus();
    await storage.getStorageUsage();

    expect(wireLog()).toStrictEqual([
      "GET /centraid/_gateway/storage/connections",
      "POST /centraid/_gateway/storage/connections",
      "PATCH /centraid/_gateway/storage/connections/conn-1",
      "POST /centraid/_gateway/storage/connections/conn-1/test",
      "DELETE /centraid/_gateway/storage/connections/conn-1",
      "GET /centraid/_gateway/storage/status",
      "GET /centraid/_gateway/storage/usage",
    ]);
  });

  it("law: every request carries the bearer token and the addressed vault", async () => {
    await storage.listStorageConnections();

    const headers = sent("GET /centraid/_gateway/storage/connections").headers;
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("x-centraid-vault")).toBe("vault-1");
  });

  it("law: a connection id is percent-encoded into the path, never interpolated raw", async () => {
    respond("DELETE /centraid/_gateway/storage/connections/conn%2F1", () =>
      json({})
    );
    await storage.deleteStorageConnection("conn/1");

    expect(wireLog()).toStrictEqual([
      "DELETE /centraid/_gateway/storage/connections/conn%2F1",
    ]);
  });

  it("law: an absent collection reads as empty, never undefined", async () => {
    respond("GET /centraid/_gateway/storage/connections", () => json({}));
    respond("GET /centraid/_gateway/storage/status", () => json({}));
    respond("GET /centraid/_gateway/storage/usage", () => json({}));

    await expect(storage.listStorageConnections()).resolves.toStrictEqual([]);
    await expect(storage.getStorageStatus()).resolves.toStrictEqual([]);
    await expect(storage.getStorageUsage()).resolves.toStrictEqual([]);
  });

  it("law: a 409 on create is the recovery-kit gate as a typed error", async () => {
    respond("POST /centraid/_gateway/storage/connections", () =>
      json({ message: "export the kit first" }, 409)
    );

    await expect(
      storage.createStorageConnection({
        kind: "provider",
        name: "Home",
        baseUrl: "https://provider.test",
        apiKey: "secret",
      })
    ).rejects.toBeInstanceOf(storage.RecoveryKitNotConfirmedError);
  });

  it("law: the recovery-kit gate still names itself when the gateway sends no message", async () => {
    respond(
      "POST /centraid/_gateway/storage/connections",
      () => new Response("", { status: 409 })
    );

    await expect(
      storage.createStorageConnection({
        kind: "provider",
        name: "Home",
        baseUrl: "https://provider.test",
        apiKey: "secret",
      })
    ).rejects.toThrow(/confirm the recovery kit/u);
  });

  it("law: a home-profile refusal carries the missing capabilities as a list", async () => {
    respond("POST /centraid/_gateway/storage/connections", () =>
      json(
        {
          error: "provider_not_home_profile",
          message: "provider is not a home bundle (missing cas, wal, audit)",
        },
        400
      )
    );

    const failure = await storage
      .createStorageConnection({
        kind: "provider",
        name: "Home",
        baseUrl: "https://provider.test",
        apiKey: "secret",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(storage.ProviderNotHomeProfileError);
    expect(
      (failure as InstanceType<typeof storage.ProviderNotHomeProfileError>)
        .missingCapabilities
    ).toStrictEqual(["cas", "wal", "audit"]);
  });

  it("law: a home-profile refusal with no named capabilities reports an empty list", async () => {
    respond("POST /centraid/_gateway/storage/connections", () =>
      json({ error: "provider_not_home_profile" }, 400)
    );

    const failure = await storage
      .createStorageConnection({
        kind: "provider",
        name: "Home",
        baseUrl: "https://provider.test",
        apiKey: "secret",
      })
      .catch((error: unknown) => error);
    expect(
      (failure as InstanceType<typeof storage.ProviderNotHomeProfileError>)
        .missingCapabilities
    ).toStrictEqual([]);
  });

  it("law: a 400 that is not the home-profile gate stays an untyped failure", async () => {
    respond("POST /centraid/_gateway/storage/connections", () =>
      json({ message: "bucket name is invalid" }, 400)
    );

    const failure = await storage
      .createStorageConnection({
        kind: "provider",
        name: "Home",
        baseUrl: "https://provider.test",
        apiKey: "secret",
      })
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(storage.ProviderNotHomeProfileError);
    expect((failure as Error).message).toBe("bucket name is invalid");
  });
});

describe("per-vault byte custody seam", () => {
  it("law: attach pins the addressed vault to s3 by connection id", async () => {
    await expect(
      storage.attachVaultStorageConnection("conn-1")
    ).resolves.toStrictEqual({ kind: "s3", connectionId: "conn-1" });
    expect(sentJson("PUT /centraid/_vault/blob-store")).toStrictEqual({
      blob_store: { kind: "s3", connectionId: "conn-1" },
    });
  });

  it("law: attach is recovery-kit gated the same way create is", async () => {
    respond("PUT /centraid/_vault/blob-store", () =>
      json({ message: "kit not confirmed" }, 409)
    );

    await expect(
      storage.attachVaultStorageConnection("conn-1")
    ).rejects.toBeInstanceOf(storage.RecoveryKitNotConfirmedError);
  });

  it("law: going local-only is never gated", async () => {
    respond("PUT /centraid/_vault/blob-store", (request) => {
      const body = JSON.parse(String(request.body)) as {
        blob_store: { kind: string };
      };
      return body.blob_store.kind === "fs"
        ? json({ blob_store: { kind: "fs" } })
        : json({ message: "kit not confirmed" }, 409);
    });

    await expect(storage.detachVaultStorageConnection()).resolves.toStrictEqual(
      { kind: "fs" }
    );
    await expect(storage.getVaultBlobStore()).resolves.toStrictEqual({
      kind: "fs",
    });
  });
});

describe("custody status stream seam", () => {
  it("law: only well-formed vault frames reach the subscriber", async () => {
    const seen: unknown[] = [];
    await storage.streamStorageCustody(
      (vaults) => seen.push(vaults),
      new AbortController().signal
    );

    expect(seen).toStrictEqual([[{ vaultId: "vault-1" }]]);
  });

  it("law: a stream that never opens is a failure the caller sees", async () => {
    respond(
      "GET /centraid/_gateway/storage/status/events",
      () => new Response("", { status: 503 })
    );

    await expect(
      storage.streamStorageCustody(
        () => undefined,
        new AbortController().signal
      )
    ).rejects.toThrow(/storage custody stream failed/u);
  });

  it("law: an aborted stream ends quietly instead of throwing at the UI", async () => {
    const controller = new AbortController();
    controller.abort();
    respond("GET /centraid/_gateway/storage/status/events", () => {
      throw new Error("aborted by the browser");
    });

    await expect(
      storage.streamStorageCustody(() => undefined, controller.signal)
    ).resolves.toBeUndefined();
  });
});

describe("backup control-plane seam", () => {
  it("law: every backup verb rides its documented route and method", async () => {
    await backup.getGatewayBackupStatus();
    await backup.runGatewayBackupNow();
    await backup.verifyGatewayBackupsNow();
    await backup.verifyGatewayBackupBucket("vault-1");

    expect(wireLog()).toStrictEqual([
      "GET /centraid/_gateway/backup",
      "POST /centraid/_gateway/backup/run",
      "POST /centraid/_gateway/backup/verify",
      "POST /centraid/_gateway/backup/verify-bucket/vault-1",
    ]);
  });

  it("law: a policy patch sends only the keys the owner changed", async () => {
    await backup.updateGatewayBackupPolicy("vault-1", { rpoSeconds: 60 });

    expect(
      sentJson("PUT /centraid/_gateway/backup/policy/vault-1")
    ).toStrictEqual({ rpoSeconds: 60 });
  });

  it("law: a policy patch declares JSON and carries the bearer token", async () => {
    await backup.updateGatewayBackupPolicy("vault-1", { verifyEveryDays: 3 });

    const headers = sent(
      "PUT /centraid/_gateway/backup/policy/vault-1"
    ).headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer token-1");
  });

  it("law: an accepted run resolves on the 202, before the run finishes", async () => {
    await expect(backup.runGatewayBackupNow()).resolves.toStrictEqual({
      accepted: true,
    });
  });

  it("law: an unconfigured backup engine is a typed conflict, not a silent no-op", async () => {
    respond(
      "POST /centraid/_gateway/backup/run",
      () => new Response("backup is not configured", { status: 409 })
    );

    await expect(backup.runGatewayBackupNow()).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("law: confirming the recovery kit posts the kit, password, and loss consent", async () => {
    await expect(
      backup.confirmGatewayRecoveryKit({
        kit: { keys: ["k1"] },
        password: "hunter2",
        lossConsent: true,
      })
    ).resolves.toMatchObject({ confirmedAt: 1_700_000_000 });
    expect(
      sentJson("POST /centraid/_gateway/backup/kit-confirmed")
    ).toStrictEqual({
      kit: { keys: ["k1"] },
      password: "hunter2",
      lossConsent: true,
    });
  });
});
