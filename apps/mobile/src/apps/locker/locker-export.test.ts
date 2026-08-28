// THE EXPORT ACT, EXERCISED (#882) — the write half of the surface whose render
// half is `LockerExportView.test.tsx`.
//
// What this pins:
//
//  1. IT IS ONLINE-ONLY, and not by a decision the call site makes: the flag
//     rides the SHARED builder, so the native session's online-only door is what
//     refuses to enqueue it. A mass reveal has no representation in the durable
//     outbox at any layer.
//  2. A PARK IS NARRATED AS A PARK. Off the owner's device the command parks;
//     saying "written" would claim an act that did not run, and no file is
//     handed over.
//  3. NOTHING BACK MEANS NO FILE. A refusal or an empty answer never produces a
//     file, and never claims one was written.
//  4. THE PLAINTEXT IS NEVER HELD — it goes straight to the file door inside the
//     call, and the call keeps no reference to it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXPORT_NOTHING,
  EXPORT_PARKED,
  EXPORT_WRITTEN,
} from "@centraid/blueprints/apps/locker/route-copy";

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
type Door = typeof import("./locker-gateway");
vi.mock(import("./locker-gateway"), () => {
  const door = {
    ITEMS_WINDOW: 300,
    ITEMS_WINDOW_MAX: 2000,
    nextWindow: (current: number) => current,
    lockerAuth: vi.fn<Door["lockerAuth"]>(),
    lockerItem: vi.fn<Door["lockerItem"]>(),
    lockerItems: vi.fn<Door["lockerItems"]>(),
    lockerSearch: vi.fn<Door["lockerSearch"]>(),
    lockerTrash: vi.fn<Door["lockerTrash"]>(),
  };
  return door as unknown as Door;
});

type Files = typeof import("./locker-files");
const files = vi.hoisted(() => ({
  hand: vi.fn<Files["handOffLockerExport"]>(),
}));
vi.mock(import("./locker-files"), () => {
  const door = {
    IMPORT_MAX_BYTES: 0,
    ImportFileRefusedError: Error,
    handOffLockerExport: files.hand,
    pickLockerImportFile: vi.fn<Files["pickLockerImportFile"]>(),
  };
  return door as unknown as Files;
});

type StatusLine = typeof import("../../kit/components/status-line");
const status = vi.hoisted(() => ({
  post: vi.fn<(text: string) => void>(),
}));
vi.mock(import("../../kit/components/status-line"), async () => {
  const real = await vi.importActual<StatusLine>(
    "../../kit/components/status-line"
  );
  return { ...real, postStatus: status.post } as unknown as StatusLine;
});

const { exportLockerVault } = await import("./locker-writes");

type Session = Parameters<typeof exportLockerVault>[0];

/** A session that records what it was asked to write and answers with one
 *  online-only outcome. `postAction` is what the real session does with an
 *  online-only write; the shape here is its result shape. */
type SessionWrite = (
  appId: string,
  input: Record<string, unknown>
) => Promise<unknown>;

function session(output: unknown): {
  session: Session;
  write: ReturnType<typeof vi.fn<SessionWrite>>;
} {
  const write = vi.fn<SessionWrite>().mockResolvedValue({
    intentId: "online-only:locker:export",
    status: "executed",
    output,
  });
  return { session: { write } as unknown as Session, write };
}

const PAYLOAD = {
  exported_at: "2026-08-27T09:41:00.000Z",
  item_count: 1,
  items: [{ item_id: "item-1", title: "Mail", password: "hunter2" }],
};

const posted = (): string =>
  status.post.mock.calls.map((call) => String(call[0])).join(" | ");

describe("exporting from this seat", () => {
  beforeEach(() => {
    files.hand.mockReset();
    status.post.mockReset();
  });

  it("issues the export online-only, with the two options it was given", async () => {
    const { session: live, write } = session({ output: PAYLOAD });
    await exportLockerVault(live, { includeHistory: true });
    expect(write).toHaveBeenCalledWith("locker", {
      action: "export",
      input: { confirm: true, include_history: true },
      onlineOnly: true,
    });
  });

  it("hands the plaintext straight to the file door and says it was written", async () => {
    const { session: live } = session({ output: PAYLOAD });
    await exportLockerVault(live, {});
    expect(files.hand).toHaveBeenCalledOnce();
    const [name, csv] = files.hand.mock.calls[0] ?? [];
    expect(name).toBe("locker-2026-08-27.csv");
    expect(String(csv)).toContain("hunter2");
    expect(posted()).toContain(EXPORT_WRITTEN);
  });

  it("narrates a park as a park, and writes no file", async () => {
    const { session: live } = session({ status: "parked" });
    await exportLockerVault(live, {});
    expect(files.hand).not.toHaveBeenCalled();
    expect(posted()).toBe(EXPORT_PARKED);
  });

  it("claims nothing when nothing came back", async () => {
    const { session: live } = session({ status: "executed" });
    await exportLockerVault(live, {});
    expect(files.hand).not.toHaveBeenCalled();
    expect(posted()).toBe(EXPORT_NOTHING);
  });

  it("reports the vault's own refusal rather than an empty file", async () => {
    const { session: live } = session({
      status: "denied",
      reason: "Confirmation is required.",
    });
    await exportLockerVault(live, {});
    expect(files.hand).not.toHaveBeenCalled();
    expect(posted()).toContain("Confirmation is required.");
    expect(posted()).not.toContain(EXPORT_WRITTEN);
  });

  it("refuses without a paired gateway rather than pretending", async () => {
    await exportLockerVault(undefined, {});
    expect(files.hand).not.toHaveBeenCalled();
    expect(posted()).toContain("not paired");
  });
});
