import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeClock } from "@centraid/test-kit/fake-clock";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type * as TypeImport_detached from "./detached-gateway.js";

/**
 * What "Try again" has to survive (#660): after a burst of failed starts the
 * supervisor latches, and ensureLocalGateway fails instantly without retrying
 * — correct automatically, fatal on the error screen. Contract: fail to give-up,
 * fix the cause, prove an explicit retry starts the gateway for real.
 */
const fixture = vi.hoisted(() => ({
  failWith: undefined as string | undefined,
  attempts: 0,
}));

const detachedHandle = (): TypeImport_detached.DetachedGatewayHandle => ({
  mode: "detached",
  url: "http://127.0.0.1:17832",
  token: "loopback-token",
  pid: 4242,
  host: "127.0.0.1",
  port: 17_832,
  dataDir: "/tmp/centraid-test",
  owned: true,
  close: async () => undefined,
  health: { registerProbe: () => undefined },
  vaults: {
    create: async () => ({ vaultId: "vault-1" }),
    delete: async () => undefined,
  },
});

vi.mock(import("./detached-gateway.js"), () => ({
  preferEmbeddedGateway: () => false,
  getOrCreateDesktopOwnerId: async () => "owner-endpoint",
  ensureDetachedGateway: async () => {
    fixture.attempts += 1;
    if (fixture.failWith !== undefined) throw new Error(fixture.failWith);
    return detachedHandle();
  },
}));
vi.mock(import("./embedded-gateway.js"), () => ({
  startDesktopEmbeddedGateway: async () => {
    throw new Error("the embedded path is not exercised by this suite");
  },
}));
vi.mock(import("./gateway-paths.js"), () => ({
  LOCAL_GATEWAY_ID: "local" as const,
  localGatewayDataDir: () => "/tmp/centraid-test",
  gatewayVaultDir: () => "/tmp/centraid-test/vaults",
  gatewayModelCatalogFile: () => "/tmp/centraid-test/models.json",
}));
vi.mock(import("./gateway-secrets.js"), () => ({
  desktopGatewayKeyStore: () => {
    throw new Error("the embedded path is not exercised by this suite");
  },
}));
vi.mock(import("./gateway-store.js"), () => ({
  setLocalGatewayInfoProvider: () => undefined,
}));
vi.mock(import("./phone-link.js"), () => ({
  phoneLinkStatus: async () => ({ running: false, devices: [] }),
}));
vi.mock(import("./settings.js"), () => ({
  loadPersistedSettings: async () => ({ activeGatewayId: "local" }),
  templatesCacheDir: () => "/tmp/centraid-test/templates",
}));
vi.mock(import("./app-sessions.js"), () => ({
  desktopSessionIdFor: () => "session",
}));

const LOCKED = "a process is holding gateway.db and is not answering";

let clock: FakeClock;

async function failUntilGivenUp(
  ensure: (id: string) => Promise<unknown>
): Promise<void> {
  await expect(ensure("local")).rejects.toThrow(LOCKED);
  await clock.advance(1000);
  await clock.advance(5000);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
}

describe("local gateway manual retry suite", () => {
  beforeEach(() => {
    vi.resetModules();
    clock = useFakeClock();
    fixture.failWith = LOCKED;
    fixture.attempts = 0;
  });

  it("gives up on repeated start failures without pointing at unreachable Settings", async () => {
    const { ensureLocalGateway } = await import("./local-gateway.js");
    await failUntilGivenUp(ensureLocalGateway);
    // The guard answered from the latch — it never went near the gateway.
    expect(fixture.attempts).toBe(3);

    const message = await rejectionMessage(ensureLocalGateway("local"));
    expect(message).toMatch(/failed to start repeatedly and stopped retrying/u);
    expect(message).toContain(`last error: ${LOCKED}`);
    // That screen has no navigation; the message must not send its reader
    // anywhere they cannot go.
    expect(message).not.toContain("Settings");
    expect(fixture.attempts).toBe(3);
  });

  it("clears the give-up state and starts the gateway again on an explicit retry", async () => {
    const { ensureLocalGateway, retryLocalGatewayStart } =
      await import("./local-gateway.js");
    await failUntilGivenUp(ensureLocalGateway);
    expect(fixture.attempts).toBe(3);

    fixture.failWith = undefined;
    await expect(retryLocalGatewayStart("local")).resolves.toBeUndefined();

    expect(fixture.attempts).toBe(4);
    const handle = await ensureLocalGateway("local");
    expect(handle.url).toBe("http://127.0.0.1:17832");
    expect(handle.mode).toBe("detached");
  });

  it("reports the current failure when the cause is still there", async () => {
    const { ensureLocalGateway, retryLocalGatewayStart } =
      await import("./local-gateway.js");
    await failUntilGivenUp(ensureLocalGateway);

    fixture.failWith = "connection-secrets.bin is unreadable";
    // Leaning on the button must not become a respawn loop; the second press
    // gets the first's outcome.
    await expect(
      rejectionMessage(retryLocalGatewayStart("local"))
    ).resolves.toBe("connection-secrets.bin is unreadable");
  });

  it("collapses a second press inside the floor into one start attempt", async () => {
    const { ensureLocalGateway, retryLocalGatewayStart } =
      await import("./local-gateway.js");
    await failUntilGivenUp(ensureLocalGateway);
    fixture.failWith = "still broken";

    await expect(
      rejectionMessage(retryLocalGatewayStart("local"))
    ).resolves.toBe("still broken");
    const afterFirst = fixture.attempts;
    await expect(
      rejectionMessage(retryLocalGatewayStart("local"))
    ).resolves.toBe("still broken");
    expect(fixture.attempts).toBe(afterFirst);
  });
});
