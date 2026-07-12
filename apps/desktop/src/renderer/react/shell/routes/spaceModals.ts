import { updateVault } from '../../../gateway-client.js';
import type { SpaceModalCommit } from './SpaceModal.js';

// Gateway I/O for the Spaces (#280: a space IS a vault) add / rename / delete
// flows. The modal chrome is the React <SpaceModal>; App.tsx (switcher "New
// space…") and SettingsRoute.tsx (the active-vault Space page, issue #382)
// own the modal state and call these helpers on submit. Vault create/delete
// are admin acts over the IPC bridge (local gateway only); metadata rides
// updateVault.

/** Create a space and make it the addressed vault (re-scopes Home). */
export async function createSpace(data: SpaceModalCommit): Promise<void> {
  const created = await window.CentraidApi.createVault({ name: data.name });
  await updateVault({
    vaultId: created.vaultId,
    color: data.color,
    icon: data.icon,
    blurb: data.blurb || null,
  });
  await window.CentraidApi.setActiveVault({ vaultId: created.vaultId });
}

/** Rename / retheme an existing space. */
export async function saveSpace(id: string, data: SpaceModalCommit): Promise<void> {
  await updateVault({
    vaultId: id,
    name: data.name,
    color: data.color,
    icon: data.icon,
    blurb: data.blurb || null,
  });
}

export async function deleteSpace(id: string): Promise<void> {
  await window.CentraidApi.deleteVault({ vaultId: id });
}
