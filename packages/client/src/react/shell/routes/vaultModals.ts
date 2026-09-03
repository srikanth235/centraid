import { updateVault } from "../../../gateway-client.js";
import type { VaultModalCommit } from "./VaultModal.js";

export async function addVault(data: VaultModalCommit): Promise<void> {
  const create = window.CentraidApi.createVault;
  if (typeof create !== "function") {
    throw new Error(
      "Creating a vault needs the desktop app or the centraid-gateway CLI."
    );
  }
  const created = await create({ name: data.name });
  await updateVault({
    vaultId: created.vaultId,
    color: data.color,
    icon: data.icon,
    blurb: data.blurb || null,
  });
  await window.CentraidApi.setActiveVault({ vaultId: created.vaultId });
}

export async function saveVault(
  id: string,
  data: VaultModalCommit
): Promise<void> {
  await updateVault({
    vaultId: id,
    name: data.name,
    color: data.color,
    icon: data.icon,
    blurb: data.blurb || null,
  });
  await window.CentraidApi.notifyVaultMetadataChanged();
}

export async function removeVault(id: string, name: string): Promise<void> {
  await window.CentraidApi.deleteVault({ vaultId: id, name });
}
