// `resolveIdentity` decides the replica DB namespace. It must not derive that
// namespace from a display name or an ephemeral tunnel port: either one makes
// every launch quietly abandon the replica the last launch built.
//
// Everything native is mocked outright rather than partially: the default
// `@centraid/mobile` vitest project carries no react-native transform (see
// vitest.projects.ts), so a single `importOriginal` on a module that reaches
// expo-secure-store or op-sqlite drags Flow source into the graph and the file
// fails to parse before a test runs.

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

const resolveGatewayBase = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>()
);
const noteActiveIdentity = vi.hoisted(() =>
  vi.fn<(input: { gatewayId: string; vaultId: string }) => Promise<void>>(
    async () => undefined
  )
);

vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => ({
    default: {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
  })
);

vi.mock(import("../../lib/gateway") as Promise<unknown>, () => ({
  authHeader: () => ({ Authorization: "Bearer test-mobile" }),
  resolveGatewayBase,
}));

vi.mock(import("@centraid/client/replica/native") as Promise<unknown>, () => ({
  fetchReplicaBootstrapPage: async () => ({ vaultId: "vault-1" }),
}));

vi.mock(import("../../lib/replica/native-hash") as Promise<unknown>, () => ({
  nativeReplicaDigest: async (value: string) => value,
}));

vi.mock(
  import("../../lib/replica/op-sqlite-driver") as Promise<unknown>,
  () => ({ nativeReplicaDatabasePath: async () => "replica.sqlite3" })
);

vi.mock(import("../../lib/vault-links") as Promise<unknown>, () => ({
  LAST_BASE: "replica.lastBase",
  MANUAL_GATEWAY_ID: "manual",
  noteActiveIdentity,
}));

const { resolveIdentity } = await import("./replica-mount");

const ENDPOINT_ID =
  "2315e0468b58adbbf0411da619288dbbb334b40d14ff4ca51cf32a0693367a01";

const info = {
  version: "0.1.0",
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
  endpointId: ENDPOINT_ID,
  capabilities: {
    webSessions: true,
    devicePairing: true,
    tunnel: true,
    backupWal: true,
    assistOAuth: true,
    automationTurns: true,
    multiVaultReplica: true,
    crossVaultPlacements: true,
  },
};

/** Stub `/centraid/_gateway/info`; `body === undefined` means a 500. */
function stubInfo(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === undefined
        ? new Response("boom", { status: 500 })
        : Response.json(body)
    )
  );
}

const pairedVault = {
  id: "sp_1",
  gatewayId: ENDPOINT_ID,
  desktopName: "Personal",
  deviceId: "device-1",
  vaultId: "vault-1",
};

describe("resolveIdentity picks a durable gateway namespace", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resolveGatewayBase.mockReset();
    noteActiveIdentity.mockClear();
  });

  test("a paired vault's own gateway id is authoritative", async () => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:51890");
    stubInfo(info);

    const identity = await resolveIdentity(pairedVault);

    expect(identity.gatewayId).toBe(ENDPOINT_ID);
    expect(identity.online).toBe(true);
  });

  // THE FIRST BOOTSTRAP AFTER PAIRING lands in the fallback branch, because
  // pairing stores a real gateway id with `vaultId: ""` for the probe to fill
  // in. Put `getDesktopName()` first in that order and this exact moment
  // DEMOTES a durable endpoint id to the desktop's display name and writes it
  // back through `noteActiveIdentity`.
  test("a freshly paired vault keeps its endpoint id, not the desktop name", async () => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:51890");
    stubInfo(info);

    const identity = await resolveIdentity({ ...pairedVault, vaultId: "" });

    expect(identity.gatewayId).toBe(ENDPOINT_ID);
    expect(identity.gatewayId).not.toBe("Personal");
    expect(noteActiveIdentity).toHaveBeenCalledWith({
      gatewayId: ENDPOINT_ID,
      vaultId: "vault-1",
    });
  });

  test("an unpaired install adopts the gateway's reported endpoint id", async () => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:65277");
    stubInfo(info);

    await expect(resolveIdentity(undefined)).resolves.toMatchObject({
      gatewayId: ENDPOINT_ID,
    });
  });

  // The regression that started this: two launches, two tunnel ports, and the
  // namespace followed the port instead of the gateway.
  test("the namespace survives the tunnel moving to a new ephemeral port", async () => {
    stubInfo(info);

    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:65277");
    const first = await resolveIdentity(undefined);
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:51890");
    const second = await resolveIdentity(undefined);

    expect(second.gatewayId).toBe(first.gatewayId);
    expect(second.auth.baseUrl).not.toBe(first.auth.baseUrl);
  });

  test.each([
    {
      name: "reports no endpoint id",
      body: { ...info, endpointId: undefined },
    },
    { name: "cannot be read at all", body: undefined },
  ])("falls back to a stable id when the gateway $name", async ({ body }) => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:65277");
    stubInfo(body);

    const identity = await resolveIdentity(undefined);

    expect(identity.gatewayId).toBe("manual");
    expect(identity.gatewayId).not.toContain("127.0.0.1");
  });
});
