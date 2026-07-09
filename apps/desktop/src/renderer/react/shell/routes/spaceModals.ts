import type { IconName } from '@centraid/design-tokens';
import { listVaults, updateVault } from '../../../gateway-client.js';
import type { ProfileRowDTO } from '../../screen-contracts.js';
import type { SpaceModalCommit, SpaceModalInitial } from './SpaceModal.js';

// Gateway I/O for the Spaces (#280: a space IS a vault) add / rename / delete
// flows. The modal chrome is the React <SpaceModal>; SettingsRoute owns the
// modal state and calls these helpers on submit. Vault create/delete are admin
// acts over the IPC bridge (local gateway only); metadata rides updateVault.

/** Prefill an edit modal from the raw vault so blurb/color/icon are the truth. */
export async function loadSpaceInitial(row: ProfileRowDTO): Promise<SpaceModalInitial> {
  try {
    const vs = await listVaults();
    const v = (vs ?? []).find((x) => x.vaultId === row.id);
    return {
      name: row.name,
      icon: (v?.icon ?? row.icon) as IconName,
      color: v?.color ?? row.color,
      blurb: v?.blurb ?? '',
    };
  } catch {
    return { name: row.name, icon: row.icon as IconName, color: row.color };
  }
}

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
