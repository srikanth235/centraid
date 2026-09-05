// THE BOUNDARY, EXERCISED (README-Locker §2).
//
// Five claims, each of which a plausible refactor could undo silently:
//
//  1. IT BOOTS LOCKED. There is no argument, payload or replay that produces
//     an open session out of the status read alone.
//  2. A HIDDEN WINDOW ENDS IT AT ONCE — not at the next timer tick — and takes
//     the browsable window with it, so no list is left standing behind a lock.
//  3. A LOCK WIPES THE ENUMERATED BAG. Every secret-bearing field named in
//     `session.SECRET_BEARING_KEYS` is empty afterwards, and the assertion is
//     over that list rather than over a hand-written one, so a new field
//     cannot be added without this test noticing.
//  4. A PERMIT IS SPENT. After one reveal the permit is gone, so a second
//     field costs a second confirmation.
//  5. A DENIED READ IS DATA. It becomes a screen, not an error, and it does
//     not empty the vault's own state.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SECRET_BEARING_KEYS,
  emptySecretBag,
} from "@centraid/blueprints/apps/locker/session";

vi.mock(import("expo-clipboard"), () => {
  const board = {
    getStringAsync: () => Promise.resolve(""),
    setStringAsync: () => Promise.resolve(true),
  };
  return board as unknown as typeof import("expo-clipboard");
});
vi.mock(import("expo-secure-store"), () => {
  const store = {
    canUseBiometricAuthentication: () => false,
    deleteItemAsync: () => Promise.resolve(),
    getItemAsync: () => Promise.resolve(null),
    setItemAsync: () => Promise.resolve(),
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: "when-passcode-set",
  };
  return store as unknown as typeof import("expo-secure-store");
});
vi.mock(import("expo-crypto"), () => {
  const crypto = {
    getRandomBytesAsync: () => Promise.resolve(new Uint8Array(32)),
  };
  return crypto as unknown as typeof import("expo-crypto");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});

// Each mock takes the REAL function's signature, so a wire shape that drifts
// is a typecheck failure here rather than a green test against a module the
// app no longer has.
type Gateway = typeof import("./locker-gateway");
const wire = vi.hoisted(() => ({
  auth: vi.fn<Gateway["lockerAuth"]>(),
  item: vi.fn<Gateway["lockerItem"]>(),
}));
type Reads = typeof import("./locker-reads");
const reads = vi.hoisted(() => ({
  items: vi.fn<Reads["lockerItems"]>(),
  search: vi.fn<Reads["lockerSearch"]>(),
  trash: vi.fn<Reads["lockerTrash"]>(),
}));
// The door is replaced WHOLE rather than spread over the real module: the
// real one reaches `lib/gateway`, which pulls Expo's fetch shim into a node
// run for no benefit — this test is about the boundary, not the transport.
vi.mock(import("./locker-gateway"), () => {
  const door = {
    lockerAuth: wire.auth,
    lockerItem: wire.item,
  };
  return door as unknown as Gateway;
});
// The three window reads are the REPLICA's now (#928): the boundary asks its
// own device, and this suite is about the boundary, not the read plane.
vi.mock(import("./locker-reads"), () => {
  const plane = {
    ITEMS_WINDOW: 300,
    ITEMS_WINDOW_MAX: 2000,
    nextWindow: (current: number) => Math.min(2000, current + 300),
    attachLockerReadPlane: vi.fn<Reads["attachLockerReadPlane"]>(),
    lockerItems: reads.items,
    lockerSearch: reads.search,
    lockerTrash: reads.trash,
  };
  return plane as unknown as Reads;
});

const {
  confirmLockerPermit,
  askLockerPermit,
  loadLockerItems,
  lockNow,
  onLockerAppState,
  openLocker,
  readLockerVault,
  resetLockerVault,
  unlockLocker,
} = await import("./locker-store");

const ROW = {
  item_id: "item-1",
  type: "login" as const,
  title: "Mail",
  subtitle: "me@example.test",
};

async function openSession(): Promise<void> {
  wire.auth.mockResolvedValue({
    ok: true,
    configured: true,
    sessionToken: "s1",
  });
  reads.items.mockResolvedValue({ items: [ROW], truncated: false });
  await unlockLocker("a-long-enough-passphrase");
}

describe("the Locker boundary on this seat", () => {
  beforeEach(() => {
    resetLockerVault();
    wire.auth.mockReset();
    wire.item.mockReset();
    reads.items.mockReset();
  });

  it("boots locked, whatever the status read says about a passphrase", async () => {
    wire.auth.mockResolvedValue({ ok: true, configured: true });
    await openLocker();
    expect(readLockerVault().session.phase).toBe("locked");
    expect(readLockerVault().bag.sessionToken).toBeNull();
    expect(readLockerVault().rows).toStrictEqual([]);
  });

  it("puts a vault with no passphrase at the first-run gate", async () => {
    wire.auth.mockResolvedValue({ ok: true, configured: false });
    await openLocker();
    expect(readLockerVault().session.phase).toBe("setup");
  });

  it("opens on an unlock and reads the window", async () => {
    await openSession();
    expect(readLockerVault().session.phase).toBe("open");
    expect(readLockerVault().rows).toHaveLength(1);
    expect(readLockerVault().loaded).toBe(true);
  });

  it("locks at once when the window is hidden, and takes the list with it", async () => {
    await openSession();
    onLockerAppState("background");
    expect(readLockerVault().masked).toBe(true);
    expect(readLockerVault().session.phase).toBe("locked");
    expect(readLockerVault().rows).toStrictEqual([]);
    expect(readLockerVault().loaded).toBe(false);
  });

  it("empties every enumerated secret-bearing field on a lock", async () => {
    await openSession();
    askLockerPermit({ itemId: "item-1", field: "password" });
    wire.auth.mockResolvedValue({
      ok: true,
      itemToken: "t1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    wire.item.mockResolvedValue({
      item: {
        item_id: "item-1",
        type: "login",
        title: "Mail",
        password: "hunter2",
      },
    });
    await confirmLockerPermit("a-long-enough-passphrase");
    expect(readLockerVault().bag.revealed.password).toBe("hunter2");

    lockNow();
    const bag = readLockerVault().bag as unknown as Record<string, unknown>;
    const empty = emptySecretBag() as unknown as Record<string, unknown>;
    for (const key of SECRET_BEARING_KEYS) {
      expect(bag[key]).toStrictEqual(empty[key]);
    }
  });

  it("spends the permit on the read it authorised", async () => {
    await openSession();
    askLockerPermit({ itemId: "item-1", field: "password" });
    wire.auth.mockResolvedValue({ ok: true, itemToken: "t1" });
    wire.item.mockResolvedValue({
      item: {
        item_id: "item-1",
        type: "login",
        title: "Mail",
        password: "hunter2",
      },
    });
    await confirmLockerPermit("a-long-enough-passphrase");
    // One shot: nothing is left to point at a second field.
    expect(readLockerVault().bag.permit).toBeNull();
    expect(readLockerVault().bag.permitRequest).toBeNull();
  });

  it("turns a vault refusal into a screen rather than an error", async () => {
    await openSession();
    reads.items.mockResolvedValue({
      vaultDenied: { code: "DENIED", message: "The grant was revoked." },
    });
    await loadLockerItems();
    expect(readLockerVault().denied?.message).toBe("The grant was revoked.");
    expect(readLockerVault().readError).toBe("");
    expect(readLockerVault().session.phase).toBe("open");
  });

  it("reads the window without a session token, and never behind the lock", async () => {
    // The window is the app GRANT's (#928): the read carries no token. The
    // LOCK is what withholds it, so a locked seat asks for nothing at all.
    await openSession();
    expect(reads.items).toHaveBeenCalledWith(300);
    lockNow();
    reads.items.mockClear();
    await loadLockerItems();
    expect(reads.items).not.toHaveBeenCalled();
    expect(readLockerVault().rows).toStrictEqual([]);
  });
});
