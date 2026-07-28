import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleCompanionRequest } from "./companion-api.js";
import type * as TypeImport_1016tag from "./storage.js";
import type * as TypeImport_zxw3p4 from "./transport.js";

type JsonTestSeam = (path: string, init?: RequestInit) => Promise<unknown>;
type AppReadTestSeam = (
  app: string,
  query: string,
  input?: unknown
) => Promise<unknown>;
type AppWriteTestSeam = (
  app: string,
  action: string,
  input: unknown
) => Promise<unknown>;

const state = vi.hoisted(() => ({ paired: true }));
const transport = vi.hoisted(() => ({
  closeTransport: vi.fn<typeof TypeImport_zxw3p4.closeTransport>(),
  companionJson: vi.fn<JsonTestSeam>(),
  appRead: vi.fn<AppReadTestSeam>(),
  appWrite: vi.fn<AppWriteTestSeam>(),
}));
const storage = vi.hoisted(() => ({
  purgeCompanionState: vi.fn<typeof TypeImport_1016tag.purgeCompanionState>(),
}));

vi.mock(import("./transport.js"), () => ({
  ...transport,
  companionJson: <T>(...args: Parameters<typeof transport.companionJson>) =>
    transport.companionJson(...args) as Promise<T>,
  appRead: <T>(...args: Parameters<typeof transport.appRead>) =>
    transport.appRead(...args) as Promise<T>,
  appWrite: <T>(...args: Parameters<typeof transport.appWrite>) =>
    transport.appWrite(...args) as Promise<T>,
  pairOverIroh: vi.fn<typeof TypeImport_zxw3p4.pairOverIroh>(),
}));
vi.mock(import("./storage.js"), () => ({
  ...storage,
  isLocked: vi.fn<typeof TypeImport_1016tag.isLocked>(async () => false),
  loadPairing: vi.fn<typeof TypeImport_1016tag.loadPairing>(async () =>
    state.paired
      ? {
          endpointTicket: "ticket",
          endpointId: "endpoint-1",
          enrollmentId: "enrollment-1",
          vaultId: "vault-1",
          pairedAt: "2026-07-19T00:00:00.000Z",
          grantProfile: ["locker"] as const,
        }
      : undefined
  ),
  savePairing: vi.fn<typeof TypeImport_1016tag.savePairing>(),
  setLocked: vi.fn<typeof TypeImport_1016tag.setLocked>(),
}));

describe("Companion unpair", () => {
  beforeEach(() => {
    state.paired = true;
    vi.clearAllMocks();
  });

  it("revokes the exact server enrollment before deleting local identity", async () => {
    transport.companionJson.mockResolvedValueOnce({ removed: true });
    await expect(
      handleCompanionRequest({ type: "unpair" }, {})
    ).resolves.toStrictEqual({
      ok: true,
    });
    expect(transport.companionJson).toHaveBeenCalledWith(
      "/centraid/_gateway/devices/enrollment-1", // ROUTES.gatewayDevices + id
      { method: "DELETE" }
    );
    expect(transport.closeTransport).toHaveBeenCalledOnce();
    expect(storage.purgeCompanionState).toHaveBeenCalledOnce();
  });

  it("retains the retry credential when server revocation fails offline", async () => {
    transport.companionJson.mockRejectedValueOnce(new Error("offline"));
    await expect(
      handleCompanionRequest({ type: "unpair" }, {})
    ).rejects.toThrow("offline");
    expect(storage.purgeCompanionState).not.toHaveBeenCalled();
    expect(state.paired).toBe(true);
  });

  it("accepts a lost success response when revocation handling already purged state", async () => {
    transport.companionJson.mockImplementationOnce(async () => {
      state.paired = false;
      throw new Error("revoked");
    });
    await expect(
      handleCompanionRequest({ type: "unpair" }, {})
    ).resolves.toStrictEqual({
      ok: true,
    });
  });
});
