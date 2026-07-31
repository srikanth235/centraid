import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeClock } from "@centraid/test-kit/fake-clock";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type * as TypeImport_detached from "./detached-gateway.js";

/**
 * What "Try again" has to survive (issue #660).
 *
 * The supervisor in `gateway-supervisor-core.ts` deliberately gives up after a
 * burst of failed starts, and `ensureLocalGateway` then fails INSTANTLY from
 * its guard without touching the gateway again. That is correct for automatic
 * callers and fatal for the startup error screen: its one button re-read the
 * settings, the read hit the latched guard, and the member sat on the error
 * screen forever even after they had removed the cause completely.
 *
 * So the contract exercised here is the whole recovery: fail until the
 * supervisor gives up, fix the cause, and prove that an explicit retry starts
 * the gateway for real instead of replaying the latched message.
 */

const fixture = vi.hoisted(() => ({
  /** Set to undefined once the "cause" is fixed. */
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
  // Only reached from the embedded path, which this suite does not take —
  // throwing keeps a real safeStorage/keychain call out of the test and turns
  // an accidental embedded run into a loud failure rather than a silent stub.
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

/** Fail until the supervisor latches `loopBroken`, driving its own retry timers. */
async function failUntilGivenUp(
  ensure: (id: string) => Promise<unknown>
): Promise<void> {
  await expect(ensure("local")).rejects.toThrow(LOCKED);
  // The 1st and 2nd failures each schedule one automatic retry (1s, then 5s);
  // the 3rd failure inside the window is what trips the loop breaker.
  await clock.advance(1000);
  await clock.advance(5000);
}

/** The rejection message, or `""` when the call unexpectedly succeeded. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
}

describe("local gateway manual retry suite", () => {
  beforeEach(() => {
    vi.resetModules();
    // Installed per test, and restored per test by the helper itself — the
    // supervisor's give-up latch is driven entirely by these timers, so a
    // clock leaking past a failing test would hang every test after it.
    clock = useFakeClock();
    fixture.failWith = LOCKED;
    fixture.attempts = 0;
  });

  it("gives up on repeated start failures without pointing at unreachable Settings", async () => {
    const { ensureLocalGateway } = await import("./local-gateway.js");
    await failUntilGivenUp(ensureLocalGateway);
    expect(fixture.attempts).toBe(3);

    const message = await rejectionMessage(ensureLocalGateway("local"));
    expect(message).toMatch(/failed to start repeatedly and stopped retrying/u);
    // The cause still travels with it — this string is quoted verbatim on the
    // startup error screen.
    expect(message).toContain(`last error: ${LOCKED}`);
    // …but that screen has no sidebar and no navigation, so the message must
    // not send its reader anywhere they cannot go.
    expect(message).not.toContain("Settings");
    // The guard answered from the latch — it never went near the gateway.
    expect(fixture.attempts).toBe(3);
  });

  it("clears the give-up state and starts the gateway again on an explicit retry", async () => {
    const { ensureLocalGateway, retryLocalGatewayStart } =
      await import("./local-gateway.js");
    await failUntilGivenUp(ensureLocalGateway);
    expect(fixture.attempts).toBe(3);

    // The member does what the screen implies they can do: fix the cause…
    fixture.failWith = undefined;
    // …and press Try again.
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
    // A retry that cannot succeed rejects with what went wrong THIS time, not
    // with the stale latched message — the fresh words are what the screen
    // re-quotes, so an unchanged cause reads as unchanged.
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
    // Leaning on the button must not become a respawn loop against a daemon
    // that dies on every launch — the second press gets the first's outcome.
    await expect(
      rejectionMessage(retryLocalGatewayStart("local"))
    ).resolves.toBe("still broken");
    expect(fixture.attempts).toBe(afterFirst);
  });
});
