import { promises as fs } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { localGatewayDataDir } from "./gateway-paths.js";
import type * as TypeImport_lwt46p from "./gateway-secrets.js";
import {
  addGateway,
  listGateways,
  removeGateway,
  resolveGateway,
  updateGatewayRelayHint,
} from "./gateway-store.js";
import type * as TypeImport_1pyf3fx from "./iroh-dialer.js";

const fixture = vi.hoisted(() => ({
  file: "",
  localDataDir: "",
  clearCredentials: vi.fn<typeof TypeImport_lwt46p.clearGatewayCredentials>(),
  closeDialer: vi.fn<typeof TypeImport_1pyf3fx.closeIrohDialer>(),
  ensureProxy: vi.fn<typeof TypeImport_1pyf3fx.ensureIrohProxy>(
    async () => "http://127.0.0.1:43123"
  ),
}));

vi.mock(import("./gateway-paths.js"), () => ({
  LOCAL_GATEWAY_ID: "local" as const,
  connectionsFile: () => fixture.file,
  localGatewayDataDir: () => fixture.localDataDir,
}));
vi.mock(import("./gateway-secrets.js"), () => ({
  clearGatewayCredentials: fixture.clearCredentials,
}));
vi.mock(import("./iroh-dialer.js"), () => ({
  ensureIrohProxy: fixture.ensureProxy,
  closeIrohDialer: fixture.closeDialer,
}));

describe("gateway-store", () => {
  beforeEach(async () => {
    const root = await tempDir("desktop-connections-");
    fixture.file = path.join(root, "connections.json");
    fixture.localDataDir = path.join(root, "platform-default-gateway");
    fixture.clearCredentials.mockClear();
    fixture.closeDialer.mockClear();
    fixture.ensureProxy.mockClear();
    localStorage.clear();
  });

  test("main owns one connection registry and renderer storage owns none of it", async () => {
    const endpointId = "a".repeat(64);
    await addGateway({
      label: "VPS",
      endpointId,
      relayHint: "relay-hint-a",
    });
    const profiles = await listGateways();
    expect(profiles.map((profile) => profile.id)).toStrictEqual([
      "local",
      endpointId,
    ]);
    expect(profiles[0]?.rememberDevice).toBe(true);

    const entries = await fs.readdir(path.dirname(fixture.file), {
      recursive: true,
    });
    expect(entries).toStrictEqual(["connections.json"]);
    const rows = JSON.parse(await fs.readFile(fixture.file, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(rows.find((row) => row.id === endpointId)).toMatchObject({
      endpointId,
      relayHint: "relay-hint-a",
    });
    expect(rows.find((row) => row.id === "local")).toMatchObject({
      rememberDevice: true,
    });
    expect(JSON.stringify(rows)).not.toContain('"url"');
    expect(JSON.stringify(rows)).not.toContain('"transport"');
    expect(
      Object.keys(localStorage).filter((key) => key.startsWith("centraid.v1."))
    ).toStrictEqual([]);
  });

  test("relay-hint refresh preserves EndpointId identity and the same row", async () => {
    const endpointId = "b".repeat(64);
    await addGateway({
      label: "VPS",
      endpointId,
      relayHint: "relay-hint-a",
    });
    await updateGatewayRelayHint(endpointId, "relay-hint-b");
    const remote = (await listGateways()).filter(
      (profile) => profile.kind === "remote"
    );
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({
      id: endpointId,
      endpointId,
      relayHint: "relay-hint-b",
    });
  });

  test("remote-only add, use, and forget never creates the platform gateway directory", async () => {
    const endpointId = "c".repeat(64);
    expect(localGatewayDataDir()).toBe(fixture.localDataDir);
    await expect(fs.access(fixture.localDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await addGateway({
      label: "Remote VPS",
      endpointId,
      relayHint: "relay-cache",
    });
    const resolved = await resolveGateway(endpointId);
    expect(resolved).toMatchObject({
      profile: { id: endpointId, endpointId },
      url: "http://127.0.0.1:43123",
      token: "",
    });
    expect(fixture.ensureProxy).toHaveBeenCalledWith(
      endpointId,
      endpointId,
      "relay-cache"
    );
    await expect(fs.access(fixture.localDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await removeGateway(endpointId);
    expect(fixture.closeDialer).toHaveBeenCalledWith(endpointId);
    expect(fixture.clearCredentials).toHaveBeenCalledWith(endpointId);
    expect((await listGateways()).map((profile) => profile.id)).toStrictEqual([
      "local",
    ]);
    await expect(fs.access(fixture.localDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
