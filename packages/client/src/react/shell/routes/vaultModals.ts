import { updateVault } from "../../../gateway-client.js";
import type { VaultModalCommit } from "./VaultModal.js";

// Gateway I/O for the Vaults (#280: a vault IS a vault) add / rename / delete
// flows. The modal chrome is the React <VaultModal>; App.tsx (switcher "New
// vault…") and SettingsRoute.tsx (the active-vault Vault page, #382)
// own the modal state and call these helpers on submit. Vault create/delete
// are owner acts over the IPC bridge (local gateway only); metadata rides
// updateVault.

/** Create a vault and make it the addressed vault (re-scopes Home). */
export async function addVault(data: VaultModalCommit): Promise<void> {
  // Hosts that cannot administer vaults (the web PWA) omit `createVault`
  // entirely; callers hide the affordance, and this is the honest backstop.
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

/** Rename / retheme an existing vault. */
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
  // updateVault is a direct renderer->gateway HTTP call, not IPC, so unlike
  // create/switch/delete it never broadcasts VAULT_CHANGED on its own — the
  // sidebar head would keep showing the old name/color until an unrelated
  // event refreshed it (found via live E2E, #382 follow-up).
  await window.CentraidApi.notifyVaultMetadataChanged();
}

export async function removeVault(id: string, name: string): Promise<void> {
  await window.CentraidApi.deleteVault({ vaultId: id, name });
}
