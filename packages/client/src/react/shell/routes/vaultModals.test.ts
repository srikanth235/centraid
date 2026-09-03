import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import { addVault, removeVault, saveVault } from "./vaultModals.js";

const updateVault = vi.fn<typeof TypeImport_1gl5zx7.updateVault>((_input) =>
  Promise.resolve({
    vaultId: "v1",
    name: "Work",
    ownerPartyId: "party-1",
  })
);
vi.mock(import("../../../gateway-client.js"), () => ({
  listVaults: () =>
    Promise.resolve([
      {
        vaultId: "v1",
        name: "Work",
        ownerPartyId: "party-1",
        color: "#222",
        icon: "Folder",
        blurb: "real",
      },
    ]),
  updateVault: (input: Parameters<typeof TypeImport_1gl5zx7.updateVault>[0]) =>
    updateVault(input),
}));

const createVault = vi.fn<NonNullable<typeof window.CentraidApi.createVault>>(
  () => Promise.resolve({ vaultId: "new1" })
);
const deleteVault = vi.fn<NonNullable<typeof window.CentraidApi.deleteVault>>(
  () => Promise.resolve({ deleted: true })
);
const setActiveVault =
  vi.fn<NonNullable<typeof window.CentraidApi.setActiveVault>>();
const notifyVaultMetadataChanged =
  vi.fn<NonNullable<typeof window.CentraidApi.notifyVaultMetadataChanged>>();

describe("vaultModals", () => {
  beforeEach(() => {
    updateVault.mockClear();
    createVault.mockClear();
    deleteVault.mockClear();
    setActiveVault.mockClear();
    notifyVaultMetadataChanged.mockClear();
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      createVault,
      deleteVault,
      notifyVaultMetadataChanged,
      setActiveVault,
    };
  });

  describe("vaultModals", () => {
    it("addVault creates a vault, paints it, and switches to it", async () => {
      await addVault({
        name: "Play",
        icon: "Star",
        color: "#0f0",
        blurb: "",
      });
      expect(createVault).toHaveBeenCalledWith({ name: "Play" });
      expect(updateVault).toHaveBeenCalledWith({
        vaultId: "new1",
        color: "#0f0",
        icon: "Star",
        blurb: null,
      });
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: "new1" });
    });

    it("saveVault renames the vault without switching, then notifies listeners to refresh", async () => {
      await saveVault("v1", {
        name: "Work HQ",
        icon: "Folder",
        color: "#111",
        blurb: "hq",
      });
      expect(updateVault).toHaveBeenCalledWith({
        vaultId: "v1",
        name: "Work HQ",
        color: "#111",
        icon: "Folder",
        blurb: "hq",
      });
      expect(setActiveVault).not.toHaveBeenCalled();
      expect(notifyVaultMetadataChanged).toHaveBeenCalledOnce();
    });

    it("removeVault removes the vault", async () => {
      await removeVault("v1", "Personal");
      expect(deleteVault).toHaveBeenCalledWith({
        vaultId: "v1",
        name: "Personal",
      });
    });
  });
});
