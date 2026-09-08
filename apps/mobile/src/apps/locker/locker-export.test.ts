// THE EXPORT ACT, EXERCISED — the write half of the surface whose render half
// is `LockerExportView.test.tsx`. What this pins: the act is online-only
// because the flag rides the SHARED builder, so a mass reveal has no
// representation in the durable outbox at any layer; a park is narrated as a
// park; nothing back means no file; and the plaintext goes straight to the file
// door, never held by the call.

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
    lockerAuth: vi.fn<Door["lockerAuth"]>(),
    lockerItem: vi.fn<Door["lockerItem"]>(),
  };
  return door as unknown as Door;
});

type Reads = typeof import("./locker-reads");
vi.mock(import("./locker-reads"), () => {
  const reads = {
    ITEMS_WINDOW: 300,
    ITEMS_WINDOW_MAX: 2000,
    nextWindow: (current: number) => current,
    attachLockerReadPlane: vi.fn<Reads["attachLockerReadPlane"]>(),
    lockerItems: vi.fn<Reads["lockerItems"]>(),
    lockerSearch: vi.fn<Reads["lockerSearch"]>(),
    lockerTrash: vi.fn<Reads["lockerTrash"]>(),
  };
  return reads as unknown as Reads;
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

/** Records what it was asked to write and answers with one online-only
 *  outcome, in `postAction`'s own result shape. */
type SessionWrite = (
  appId: string,
  input: Record<string, unknown>
) => Promise<unknown>;

/** One entry the write door received, in the order it arrived. */
interface WriteCall {
  appId: string;
  input: Record<string, unknown>;
}

function session(output: unknown): {
  session: Session;
  writes: WriteCall[];
} {
  const writes: WriteCall[] = [];
  const write: SessionWrite = (appId, input) => {
    writes.push({ appId, input });
    return Promise.resolve({
      intentId: "online-only:locker:export",
      status: "executed",
      output,
    });
  };
  return { session: { write } as unknown as Session, writes };
}

const PAYLOAD = {
  exported_at: "2026-08-27T09:41:00.000Z",
  item_count: 1,
  items: [{ item_id: "item-1", title: "Mail", password: "hunter2" }],
};

const posted = (): string =>
  status.post.mock.calls.map((call) => String(call[0])).join(" | ");

/** The files the door was handed — the seat's only durable output. */
const written = (): Array<{ csv: string; name: string }> =>
  files.hand.mock.calls.map(([name, csv]) => ({
    csv: String(csv),
    name: String(name),
  }));

describe("exporting from this seat", () => {
  beforeEach(() => {
    files.hand.mockReset();
    status.post.mockReset();
  });

  it("issues the export online-only, with the two options it was given", async () => {
    const { session: live, writes } = session({ output: PAYLOAD });
    await exportLockerVault(live, { includeHistory: true });
    expect(writes).toStrictEqual([
      {
        appId: "locker",
        input: {
          action: "export",
          input: { confirm: true, include_history: true },
          onlineOnly: true,
        },
      },
    ]);
  });

  it("hands the plaintext straight to the file door and says it was written", async () => {
    const { session: live } = session({ output: PAYLOAD });
    await exportLockerVault(live, {});
    expect(written().map((file) => file.name)).toStrictEqual([
      "locker-2026-08-27.csv",
    ]);
    expect(written()[0]?.csv).toContain("hunter2");
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
