// ACCESS HISTORY AND IMPORT, EXERCISED (#882).
//
// What a plausible refactor could undo silently:
//
//  1. A REFUSED READ IS NOT AN EMPTY HISTORY. Denied, failed and "no receipt
//     yet" are three answers; only one of them is a list, and the other two
//     must leave the list `null` so nothing draws "nothing has happened" over a
//     ledger it never got to read.
//  2. AN EXPIRED SESSION LOCKS. The receipts read is session-bound like every
//     other read here, so `authRequired` ends the session rather than blanking
//     a screen inside a live-looking frame.
//  3. THE IMPORT BRIDGE REFUSES OUT LOUD. A cancel says nothing; a file this
//     phone will not read says which of the two refusals it was; a file the
//     border recognised nothing in stages a draft that is named as a refusal
//     rather than drawn as an empty review.
//  4. NOTHING REACHES THE VAULT UNTIL PUBLISH, and a discard says nothing was
//     written.
//  5. A LOCK TAKES BOTH SURFACES WITH IT — the entries and the staged rows
//     through the SHARED bag's own wipe, the companions beside them.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORT_NO_ROWS } from "@centraid/blueprints/apps/locker/route-copy";

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

// Each mock takes the REAL function's signature, so a wire shape that drifts is
// a typecheck failure here rather than a green test against a door the app no
// longer has.
type Gateway = typeof import("./locker-gateway");
const wire = vi.hoisted(() => ({
  access: vi.fn<Gateway["lockerAccess"]>(),
  auth: vi.fn<Gateway["lockerAuth"]>(),
  batches: vi.fn<Gateway["lockerImportBatches"]>(),
  discard: vi.fn<Gateway["discardLockerImport"]>(),
  publish: vi.fn<Gateway["publishLockerImport"]>(),
  rows: vi.fn<Gateway["lockerImportRows"]>(),
  stage: vi.fn<Gateway["stageLockerImport"]>(),
}));
vi.mock(import("./locker-gateway"), () => {
  const door = {
    ACCESS_WINDOW: 200,
    discardLockerImport: wire.discard,
    lockerAccess: wire.access,
    lockerAuth: wire.auth,
    lockerImportBatches: wire.batches,
    lockerImportRows: wire.rows,
    lockerItem: vi.fn<Gateway["lockerItem"]>(),
    publishLockerImport: wire.publish,
    stageLockerImport: wire.stage,
  };
  return door as unknown as Gateway;
});

type Reads = typeof import("./locker-reads");
const reads = vi.hoisted(() => ({
  items: vi.fn<Reads["lockerItems"]>(),
}));
vi.mock(import("./locker-reads"), () => {
  const plane = {
    ITEMS_WINDOW: 300,
    ITEMS_WINDOW_MAX: 2000,
    nextWindow: (current: number) => Math.min(2000, current + 300),
    attachLockerReadPlane: vi.fn<Reads["attachLockerReadPlane"]>(),
    lockerItems: reads.items,
    lockerSearch: vi.fn<Reads["lockerSearch"]>(),
    lockerTrash: vi.fn<Reads["lockerTrash"]>(),
  };
  return plane as unknown as Reads;
});

// Replaced WHOLE, like the door above: the real module reaches
// `expo-file-system` and `expo-document-picker`, which drag React Native's Flow
// source into a node run for no benefit. This suite is about what the bridge
// SAYS, not how a file is read.
type Files = typeof import("./locker-files");
const files = vi.hoisted(() => ({
  pick: vi.fn<Files["pickLockerImportFile"]>(),
}));
vi.mock(import("./locker-files"), () => {
  const door = {
    IMPORT_MAX_BYTES: 2 * 1024 * 1024,
    ImportFileRefusedError: Error,
    handOffLockerExport: vi.fn<Files["handOffLockerExport"]>(),
    pickLockerImportFile: files.pick,
  };
  return door as unknown as Files;
});

const { lockNow, readLockerVault, resetLockerVault, unlockLocker } =
  await import("./locker-store");
const {
  discardLockerImportDraft,
  loadLockerAccess,
  loadLockerImportDrafts,
  openLockerImportDraft,
  publishLockerImportDraft,
  stageLockerImportFile,
} = await import("./locker-surfaces");

const REVEAL = {
  receipt_id: "r1",
  kind: "reveal" as const,
  action: "locker.reveal",
  decision: "allow" as const,
  item_id: "item-1",
  occurred_at: "2026-08-27T09:41:00.000Z",
  columns: ["password"],
};

async function openSession(): Promise<void> {
  wire.auth.mockResolvedValue({
    ok: true,
    configured: true,
    sessionToken: "s1",
  });
  reads.items.mockResolvedValue({ items: [], truncated: false });
  await unlockLocker("a-long-enough-passphrase");
}

describe("access history on this seat", () => {
  beforeEach(async () => {
    resetLockerVault();
    for (const stub of Object.values(wire)) stub.mockReset();
    files.pick.mockReset();
    await openSession();
  });

  it("lists the receipts a landed read returned, and states its window", async () => {
    wire.access.mockResolvedValue({
      entries: [REVEAL],
      window: 200,
      truncated: false,
    });
    await loadLockerAccess();
    expect(readLockerVault().bag.accessEntries).toStrictEqual([REVEAL]);
    expect(readLockerVault().accessWindow).toStrictEqual({
      truncated: false,
      window: 200,
    });
    expect(readLockerVault().accessError).toBe("");
  });

  it("draws no list over a refusal — a denial is not an empty history", async () => {
    wire.access.mockResolvedValue({
      vaultDenied: { code: "DENIED", message: "The grant was revoked." },
    });
    await loadLockerAccess();
    expect(readLockerVault().bag.accessEntries).toBeNull();
    expect(readLockerVault().accessError).toBe("The grant was revoked.");
  });

  it("keeps the list null when the read itself failed", async () => {
    wire.access.mockRejectedValue(new Error("Could not reach the gateway"));
    await loadLockerAccess();
    expect(readLockerVault().bag.accessEntries).toBeNull();
    expect(readLockerVault().accessError).toContain("Could not reach");
  });

  it("locks when the receipts read says the session is gone", async () => {
    wire.access.mockResolvedValue({ authRequired: true });
    await loadLockerAccess();
    expect(readLockerVault().session.phase).toBe("locked");
    expect(readLockerVault().bag.sessionToken).toBeNull();
  });

  it("asks nothing without a session — there is no unauthenticated ledger", async () => {
    lockNow();
    await loadLockerAccess();
    expect(wire.access).not.toHaveBeenCalled();
  });

  it("takes the receipts with it on a lock", async () => {
    wire.access.mockResolvedValue({ entries: [REVEAL], window: 200 });
    await loadLockerAccess();
    lockNow();
    expect(readLockerVault().bag.accessEntries).toBeNull();
    expect(readLockerVault().accessWindow).toBeNull();
  });
});

describe("the import bridge on this seat", () => {
  beforeEach(async () => {
    resetLockerVault();
    for (const stub of Object.values(wire)) stub.mockReset();
    files.pick.mockReset();
    await openSession();
    wire.batches.mockResolvedValue([]);
    wire.rows.mockResolvedValue([]);
  });

  it("says nothing when the member closed the sheet", async () => {
    files.pick.mockResolvedValue(null);
    await stageLockerImportFile();
    expect(wire.stage).not.toHaveBeenCalled();
    expect(readLockerVault().importNote).toBe("");
    expect(readLockerVault().surfaceBusy).toBe(false);
  });

  it("states a file refusal in place of sending it", async () => {
    files.pick.mockRejectedValue(
      new Error("That file is too large to read on this phone.")
    );
    await stageLockerImportFile();
    expect(wire.stage).not.toHaveBeenCalled();
    expect(readLockerVault().importNote).toContain("too large");
  });

  it("names a draft the border recognised nothing in", async () => {
    files.pick.mockResolvedValue({ filename: "logins.csv", text: "nope" });
    wire.stage.mockResolvedValue({
      batchId: "b1",
      staged: {},
      unrouted: ["x"],
    });
    await stageLockerImportFile();
    expect(readLockerVault().importNote).toBe(IMPORT_NO_ROWS);
  });

  it("stages a draft without writing to the vault", async () => {
    files.pick.mockResolvedValue({ filename: "logins.csv", text: "Title,Url" });
    wire.stage.mockResolvedValue({ batchId: "b1", staged: { create: 12 } });
    await stageLockerImportFile();
    // The staging door received the picked file WHOLE, exactly once.
    expect(wire.stage.mock.calls.flat()).toStrictEqual([
      { filename: "logins.csv", text: "Title,Url" },
    ]);
    expect(readLockerVault().importNote).toContain("nothing is in the vault");
    expect(wire.publish).not.toHaveBeenCalled();
    expect(readLockerVault().openBatchId).toBe("b1");
  });

  it("carries a refused door's own words rather than an empty shelf", async () => {
    wire.batches.mockRejectedValue(new Error("Gateway returned HTTP 404"));
    await loadLockerImportDrafts();
    expect(readLockerVault().importBatches).toStrictEqual([]);
    expect(readLockerVault().importNote).toContain("HTTP 404");
  });

  it("narrows the shelf to drafts — a published batch is history", async () => {
    wire.batches.mockResolvedValue([
      { batchId: "b1", status: "draft", createdAt: "2026-08-27" },
      { batchId: "b0", status: "published", createdAt: "2026-08-26" },
    ]);
    await loadLockerImportDrafts();
    expect(
      (readLockerVault().importBatches ?? []).map((batch) => batch.batchId)
    ).toStrictEqual(["b1"]);
  });

  it("names what the vault HELD when a draft is published", async () => {
    wire.publish.mockResolvedValue({ created: 9, updated: 2, skipped: 3 });
    await publishLockerImportDraft("b1");
    expect(readLockerVault().importNote).toContain("3 held — the vault won");
    expect(readLockerVault().openBatchId).toBeNull();
    expect(readLockerVault().bag.importRows).toBeNull();
  });

  it("says a discarded draft wrote nothing", async () => {
    wire.discard.mockResolvedValue();
    await discardLockerImportDraft("b1");
    // The discard door was named the one batch, and no other.
    expect(wire.discard.mock.calls.flat()).toStrictEqual(["b1"]);
    expect(readLockerVault().importNote).toContain("nothing was written");
  });

  it("takes the staged rows with it on a lock", async () => {
    wire.rows.mockResolvedValue([
      {
        seq: 1,
        entityType: "locker.item",
        externalId: "login:Mail:me",
        disposition: "create",
        mapping: "Title → title",
      },
    ]);
    await openLockerImportDraft("b1");
    expect(readLockerVault().bag.importRows).toHaveLength(1);
    lockNow();
    expect(readLockerVault().bag.importRows).toBeNull();
    expect(readLockerVault().openBatchId).toBeNull();
    expect(readLockerVault().importBatches).toBeNull();
  });
});
