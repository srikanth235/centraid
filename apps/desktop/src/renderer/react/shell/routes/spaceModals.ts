import type { IconName } from '@centraid/design-tokens';
import { listVaults, updateVault } from '../../../gateway-client.js';
import type { ProfileRowDTO } from '../../bridge.js';

// The Spaces (#280: a space IS a vault) add / rename / delete flows for the
// React SettingsRoute. The presentation (modal + delete dialog chrome) is the
// vanilla `window.Profiles` cluster; this module supplies the gateway I/O
// (createVault/updateVault/deleteVault) exactly as the retired app.ts did, then
// asks the caller to refresh + re-scope. Module-level control handles keep a
// second invocation from stacking a duplicate modal.

export interface SpaceModalDeps {
  /** Re-list the spaces after a label/create/delete change. */
  onChanged: () => void;
  /** Re-scope the shell to Home (a new/switched vault empties the grid). */
  navigateHome: () => void;
}

let modalCtl: { close: () => void } | null = null;
let deleteCtl: { close: () => void } | null = null;

function randomColor(): string {
  const colors = window.Profiles.PROFILE_COLORS;
  return colors[Math.floor(Math.random() * colors.length)] ?? colors[0] ?? '#4E68DD';
}

function toProfileView(row: ProfileRowDTO): ProfileView {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon as IconName,
    blurb: '',
    kind: 'local',
    primordial: row.primordial,
  };
}

async function commit(
  mode: 'add' | 'edit',
  row: ProfileRowDTO | undefined,
  data: { name: string; icon: IconName; color: string; blurb: string },
  deps: SpaceModalDeps,
): Promise<void> {
  try {
    if (mode === 'add') {
      // Vault create is an admin act over the IPC bridge (local gateway only).
      const created = await window.CentraidApi.createVault({ name: data.name });
      await updateVault({
        vaultId: created.vaultId,
        color: data.color,
        icon: data.icon,
        blurb: data.blurb || null,
      });
      modalCtl?.close();
      modalCtl = null;
      window.Profiles.toast({ msg: `Space created · ${data.name}`, kind: 'ok' });
      // A freshly created space becomes the addressed vault, re-scoping Home.
      await window.CentraidApi.setActiveVault({ vaultId: created.vaultId });
      deps.onChanged();
      deps.navigateHome();
    } else if (row) {
      await updateVault({
        vaultId: row.id,
        name: data.name,
        color: data.color,
        icon: data.icon,
        blurb: data.blurb || null,
      });
      modalCtl?.close();
      modalCtl = null;
      window.Profiles.toast({ msg: `Saved · ${data.name}`, kind: 'ok' });
      deps.onChanged();
    }
  } catch (err) {
    window.Profiles.toast({ msg: `Save failed: ${String(err)}`, kind: 'del' });
  }
}

async function confirmDelete(row: ProfileRowDTO, deps: SpaceModalDeps): Promise<void> {
  try {
    await window.CentraidApi.deleteVault({ vaultId: row.id });
    deleteCtl?.close();
    deleteCtl = null;
    window.Profiles.toast({ msg: `Deleted · ${row.name}`, kind: 'del' });
    deps.onChanged();
  } catch (err) {
    window.Profiles.toast({ msg: `Delete failed: ${String(err)}`, kind: 'del' });
  }
}

/** Open the vanilla delete-confirm dialog for a space. */
export function requestDeleteSpace(row: ProfileRowDTO, deps: SpaceModalDeps): void {
  deleteCtl?.close();
  deleteCtl = window.Profiles.openDeleteDialog({
    profile: toProfileView(row),
    onCancel: () => {
      deleteCtl?.close();
      deleteCtl = null;
    },
    onConfirm: () => void confirmDelete(row, deps),
  });
}

/** Open the vanilla add/rename modal for a space. */
export function openSpaceModal(
  mode: 'add' | 'edit',
  row: ProfileRowDTO | undefined,
  deps: SpaceModalDeps,
): void {
  modalCtl?.close();
  const open = (initial: {
    name?: string;
    icon?: IconName;
    color?: string;
    blurb?: string;
  }): void => {
    modalCtl = window.Profiles.openModal({
      mode,
      initial,
      onCancel: () => {
        modalCtl?.close();
        modalCtl = null;
      },
      onCommit: (data) => void commit(mode, row, data, deps),
      onDelete:
        mode === 'edit' && row && !row.primordial
          ? () => {
              modalCtl?.close();
              modalCtl = null;
              requestDeleteSpace(row, deps);
            }
          : null,
    });
  };

  if (mode === 'edit' && row) {
    // Refetch the raw vault so rename prefills the true blurb/color/icon
    // (the list DTO folds blurb into subLine).
    void listVaults()
      .then((vs) => {
        const v = (vs ?? []).find((x) => x.vaultId === row.id);
        open({
          name: row.name,
          icon: (v?.icon ?? row.icon) as IconName,
          color: v?.color ?? row.color,
          blurb: v?.blurb ?? '',
        });
      })
      .catch(() => open({ name: row.name, icon: row.icon as IconName, color: row.color }));
  } else {
    open({ icon: window.Profiles.DEFAULT_ICON, color: randomColor() });
  }
}
