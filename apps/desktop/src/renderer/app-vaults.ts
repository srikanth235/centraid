// The Settings → Vaults page (duaility §12) — the owner's vault registry
// surface. One gateway holds many vaults (each its own SQLite pair); exactly
// one is ACTIVE at a time, and `ctx.vault` inside every handler and
// automation fire rides the active one. Four owner acts live here:
//
//   1. create a vault (it does NOT become active implicitly);
//   2. rename a vault (its `core_vault.display_name`, stored in the vault);
//   3. switch the active vault (apps re-enroll there on first call, but
//      grants are per vault — access stays deny-by-default until granted);
//   4. delete a vault (files removed for good; the active one is protected).
//
// Everything talks to `/centraid/_vault/vaults` through
// `gateway-client-vault.ts`; when no registry is mounted the page says so.
import {
  createVault,
  deleteVault,
  listVaults,
  updateVault,
  type VaultListEntry,
} from './gateway-client.js';

export interface VaultsPageInput {
  el: ElHelper;
  host: HTMLElement;
  showToast?: (message: string) => void;
}

/** Populate the Vaults page. Re-renders itself after every owner act. */
export async function renderVaultsPage(input: VaultsPageInput): Promise<void> {
  const { el, host } = input;
  const note = (text: string): HTMLElement => el('div', { class: 'cd-app-settings-note' }, text);

  let vaults: VaultListEntry[] | undefined;
  try {
    vaults = await listVaults();
  } catch {
    vaults = undefined;
  }
  if (!host.isConnected) return;
  if (!vaults) {
    host.replaceChildren(note('No vault is mounted on this gateway.'));
    return;
  }

  const rerender = (): void => void renderVaultsPage(input);
  const list = el('div', { class: 'cd-vaults-list' });
  for (const vault of vaults) list.append(vaultRow(input, vault, rerender));
  host.replaceChildren(list, createRow(input, rerender));
}

/** One vault: name (click-to-rename), active badge or Switch, Delete. */
function vaultRow(
  input: VaultsPageInput,
  vault: VaultListEntry,
  rerender: () => void,
): HTMLElement {
  const { el } = input;
  const row = el('div', { class: 'cd-vaults-row', 'data-active': String(vault.active) });

  const nameHost = el('div', { class: 'cd-vaults-name' });
  const renderName = (): void => {
    const nameBtn = el(
      'button',
      { class: 'cd-vaults-name-btn', type: 'button', title: 'Rename vault' },
      vault.name,
    );
    nameBtn.addEventListener('click', () => {
      const field = el('input', {
        class: 'cd-vaults-name-input',
        type: 'text',
        value: vault.name,
      }) as HTMLInputElement;
      const commit = (): void => {
        const name = field.value.trim();
        if (name.length === 0 || name === vault.name) {
          renderName();
          return;
        }
        updateVault({ vaultId: vault.vaultId, name })
          .then(() => {
            input.showToast?.('Vault renamed');
            rerender();
          })
          .catch((err: unknown) => {
            input.showToast?.(err instanceof Error ? err.message : 'Rename failed');
            renderName();
          });
      };
      field.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        if (ev.key === 'Escape') renderName();
      });
      field.addEventListener('blur', commit);
      nameHost.replaceChildren(field);
      field.focus();
      field.select();
    });
    nameHost.replaceChildren(nameBtn);
  };
  renderName();

  const actions = el('div', { class: 'cd-vaults-actions' });
  if (vault.active) {
    actions.append(el('span', { class: 'cd-vaults-active-badge' }, 'Active'));
  } else {
    const switchBtn = el(
      'button',
      { class: 'cd-vaults-switch-btn', type: 'button' },
      'Make active',
    );
    switchBtn.addEventListener('click', () => {
      (switchBtn as HTMLButtonElement).disabled = true;
      updateVault({ vaultId: vault.vaultId, active: true })
        .then(() => {
          input.showToast?.(`"${vault.name}" is now the active vault`);
          rerender();
        })
        .catch((err: unknown) => {
          (switchBtn as HTMLButtonElement).disabled = false;
          input.showToast?.(err instanceof Error ? err.message : 'Switch failed');
        });
    });
    actions.append(switchBtn);

    // Deleting is forever (both SQLite files go) — arm on first click,
    // execute on the second. The active vault never shows the button.
    const deleteBtn = el('button', { class: 'cd-vaults-delete-btn', type: 'button' }, 'Delete');
    let armed = false;
    deleteBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        deleteBtn.textContent = 'Delete forever?';
        deleteBtn.dataset.armed = 'true';
        return;
      }
      (deleteBtn as HTMLButtonElement).disabled = true;
      deleteVault({ vaultId: vault.vaultId })
        .then(() => {
          input.showToast?.(`Deleted "${vault.name}"`);
          rerender();
        })
        .catch((err: unknown) => {
          (deleteBtn as HTMLButtonElement).disabled = false;
          input.showToast?.(err instanceof Error ? err.message : 'Delete failed');
          rerender();
        });
    });
    actions.append(deleteBtn);
  }

  row.append(nameHost, actions);
  return row;
}

/** The "new vault" affordance: a name field + Create. */
function createRow(input: VaultsPageInput, rerender: () => void): HTMLElement {
  const { el } = input;
  const field = el('input', {
    class: 'cd-vaults-create-input',
    type: 'text',
    placeholder: 'New vault name…',
  }) as HTMLInputElement;
  const createBtn = el('button', { class: 'cd-vaults-create-btn', type: 'button' }, 'Create vault');
  const create = (): void => {
    const name = field.value.trim();
    (createBtn as HTMLButtonElement).disabled = true;
    createVault(name ? { name } : {})
      .then((created) => {
        input.showToast?.(`Created "${created.name}"`);
        rerender();
      })
      .catch((err: unknown) => {
        (createBtn as HTMLButtonElement).disabled = false;
        input.showToast?.(err instanceof Error ? err.message : 'Create failed');
      });
  };
  createBtn.addEventListener('click', create);
  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') create();
  });
  return el('div', { class: 'cd-vaults-create' }, [field, createBtn]);
}
