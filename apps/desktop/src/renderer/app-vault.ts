// The per-app Vault tab (duaility §12) — the owner consent surface for one
// app, rendered inside the app-settings popover. Three jobs:
//
//   1. show WHAT the app asked for — the manifest-declared `vault` block
//      (purpose, why, scopes), which is a *request*, never access;
//   2. let the owner grant exactly that request (deny-by-default until the
//      grant lands) or revoke it (the cascade runs gateway-side);
//   3. surface this app's parked invocations — commands whose risk exceeds
//      the app's ceiling wait here for the owner's explicit say-so.
//
// The tab only appears for apps whose manifest declares a `vault` block
// (see `app-appview.ts`). Everything here talks to `/centraid/_vault/*`
// through `gateway-client-vault.ts`; when no plane is mounted the pane
// says so instead of erroring.
import {
  approveVaultGrant,
  confirmVaultParked,
  revokeVaultGrant,
  vaultApps,
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
  vaultParked,
  vaultStatus,
  type VaultDemoApp,
  type VaultGrant,
  type VaultParkedEntry,
  type VaultScope,
} from './gateway-client.js';
import { relativeTime } from './app-format.js';

/** The manifest-declared access request (`app.json#vault`). */
export interface ManifestVaultBlock {
  purpose: string;
  why: string;
  scopes: VaultScope[];
}

/** Parse the `vault` block out of a fetched `app.json`, if sound. */
export function manifestVaultBlock(manifest: unknown): ManifestVaultBlock | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const vault = (manifest as { vault?: unknown }).vault;
  if (!vault || typeof vault !== 'object') return null;
  const v = vault as Record<string, unknown>;
  if (typeof v.purpose !== 'string' || !Array.isArray(v.scopes)) return null;
  return {
    purpose: v.purpose,
    why: typeof v.why === 'string' ? v.why : '',
    scopes: v.scopes as VaultScope[],
  };
}

export interface VaultPaneInput {
  el: ElHelper;
  appId: string;
  block: ManifestVaultBlock;
  host: HTMLElement;
  /** Fired after a grant / revoke / confirmation so the app view can reload. */
  onAccessChanged?: () => void;
  /** Reports the parked count so the tab badge can show it. */
  onParkedCount?: (count: number) => void;
  showToast?: (message: string) => void;
}

/** Populate the Vault pane. Re-renders itself after every owner act. */
export async function renderVaultPane(input: VaultPaneInput): Promise<void> {
  const { el, appId, block, host } = input;

  const note = (text: string): HTMLElement => el('div', { class: 'cd-app-settings-note' }, text);

  let status;
  try {
    status = await vaultStatus();
  } catch {
    status = undefined;
  }
  if (!host.isConnected) return;
  // `vaultStatus()` is `undefined` only when the gateway mounts no vault
  // plane (route 404s); otherwise it names the addressed vault (#289).
  if (!status) {
    host.replaceChildren(
      renderRequestSection(el, block),
      note('No vault is mounted on this gateway, so this app has nothing to project.'),
    );
    return;
  }

  let grants: VaultGrant[] = [];
  let parked: VaultParkedEntry[] = [];
  let demo: VaultDemoApp | undefined;
  try {
    const [apps, allParked, demoApps] = await Promise.all([
      vaultApps(),
      vaultParked(),
      vaultDemoStatus().catch(() => [] as VaultDemoApp[]),
    ]);
    // Enrollment stores the Centraid app id as `consent.app.name`.
    grants = apps.find((a) => a.name === appId)?.grants ?? [];
    parked = allParked.filter((p) => p.callerKind === 'app' && p.caller === appId);
    demo = demoApps.find((d) => d.appId === appId);
  } catch {
    host.replaceChildren(note('Could not read the vault consent surface.'));
    return;
  }
  if (!host.isConnected) return;
  input.onParkedCount?.(parked.length);

  const rerender = (): void => void renderVaultPane(input);
  const sections: HTMLElement[] = [renderRequestSection(el, block)];
  sections.push(renderGrantSection(input, grants, rerender, status.name));
  if (parked.length > 0) sections.push(renderParkedSection(input, parked, rerender));
  if (demo && (demo.seedable || demo.rows > 0)) {
    sections.push(renderDemoSection(input, demo, rerender));
  }
  host.replaceChildren(...sections);
}

/**
 * Scenario seeds (issue #290 phase 1): load the blueprint's demo data —
 * written through the demo register, so it is purgeable in one click and
 * never fires automations — or reset what a previous load left behind.
 */
function renderDemoSection(
  input: VaultPaneInput,
  demo: VaultDemoApp,
  rerender: () => void,
): HTMLElement {
  const { el, appId } = input;
  const section = el('div', { class: 'cd-app-settings-section cd-vault-demo' });
  section.append(el('div', { class: 'cd-vault-label' }, 'Demo data'));
  section.append(
    el(
      'div',
      { class: 'cd-app-settings-note' },
      demo.rows > 0
        ? `${demo.rows} demo row${demo.rows === 1 ? '' : 's'} loaded — safe to reset any time; real data is never touched.`
        : 'Load a sample scenario to try the app on realistic data. Demo rows are marked, never fire automations, and reset in one click.',
    ),
  );
  const actions = el('div', { class: 'cd-vault-demo-actions' });
  const act = (label: string, run: () => Promise<unknown>, doneMsg: string): HTMLElement => {
    const btn = el('button', { class: 'cd-vault-grant-btn', type: 'button' }, label);
    btn.addEventListener('click', () => {
      (btn as HTMLButtonElement).disabled = true;
      run()
        .then(() => {
          input.showToast?.(doneMsg);
          input.onAccessChanged?.();
          rerender();
        })
        .catch((err: unknown) => {
          (btn as HTMLButtonElement).disabled = false;
          input.showToast?.(err instanceof Error ? err.message : `${label} failed`);
        });
    });
    return btn;
  };
  if (demo.seedable) {
    actions.append(act('Load demo data', () => vaultDemoLoad(appId), 'Demo data loaded'));
  }
  if (demo.rows > 0) {
    actions.append(act('Reset demo data', () => vaultDemoPurge(appId), 'Demo data reset'));
  }
  section.append(actions);
  return section;
}

/** WHAT the app asked for — why line + requested scopes as chips. */
function renderRequestSection(el: ElHelper, block: ManifestVaultBlock): HTMLElement {
  const section = el('div', { class: 'cd-app-settings-section cd-vault-request' });
  section.append(el('div', { class: 'cd-vault-label' }, 'Requested access'));
  if (block.why) section.append(el('div', { class: 'cd-vault-why' }, block.why));
  const chips = el('div', { class: 'cd-vault-scopes' });
  for (const scope of block.scopes) {
    chips.append(
      el('span', { class: 'cd-vault-scope', 'data-verbs': scope.verbs }, [
        el('span', { class: 'cd-vault-scope-name' }, scopeLabel(scope)),
        el('span', { class: 'cd-vault-scope-verbs' }, scope.verbs),
      ]),
    );
  }
  section.append(chips, el('div', { class: 'cd-vault-purpose' }, `Purpose · ${block.purpose}`));
  return section;
}

/** Grant state + the one owner act it affords (grant, or revoke). */
function renderGrantSection(
  input: VaultPaneInput,
  grants: VaultGrant[],
  rerender: () => void,
  vaultName: string,
): HTMLElement {
  const { el, appId, block } = input;
  const section = el('div', { class: 'cd-app-settings-section cd-vault-grants' });
  // Grants are per vault (the registry can hold several) — name the active
  // one so the owner knows exactly which vault this act covers.
  section.append(el('div', { class: 'cd-vault-label' }, `Access · ${vaultName}`));

  if (grants.length === 0) {
    section.append(
      el(
        'div',
        { class: 'cd-app-settings-note' },
        'No access yet — the vault denies every call until you grant it.',
      ),
    );
    const grantBtn = el('button', { class: 'cd-vault-grant-btn', type: 'button' }, 'Grant access');
    grantBtn.addEventListener('click', () => {
      (grantBtn as HTMLButtonElement).disabled = true;
      approveVaultGrant({ appId, purpose: block.purpose, scopes: block.scopes })
        .then(() => {
          input.showToast?.('Vault access granted');
          input.onAccessChanged?.();
          rerender();
        })
        .catch((err: unknown) => {
          (grantBtn as HTMLButtonElement).disabled = false;
          input.showToast?.(err instanceof Error ? err.message : 'Grant failed');
        });
    });
    section.append(grantBtn);
    return section;
  }

  for (const grant of grants) {
    const row = el('div', { class: 'cd-vault-grant-row' });
    const text = el('div', { class: 'cd-vault-grant-text' }, [
      el('div', { class: 'cd-vault-grant-title' }, `Granted · ${grant.purpose ?? 'purpose'}`),
      el(
        'div',
        { class: 'cd-vault-grant-sub' },
        grant.scopes.map(scopeLabel).join(' · ') +
          (grant.expiresAt ? ` · expires ${grant.expiresAt.slice(0, 10)}` : ''),
      ),
    ]);
    const revokeBtn = el('button', { class: 'cd-vault-revoke-btn', type: 'button' }, 'Revoke');
    revokeBtn.addEventListener('click', () => {
      (revokeBtn as HTMLButtonElement).disabled = true;
      revokeVaultGrant({ grantId: grant.grantId })
        .then(() => {
          input.showToast?.('Vault access revoked');
          input.onAccessChanged?.();
          rerender();
        })
        .catch((err: unknown) => {
          (revokeBtn as HTMLButtonElement).disabled = false;
          input.showToast?.(err instanceof Error ? err.message : 'Revoke failed');
        });
    });
    row.append(text, revokeBtn);
    section.append(row);
  }
  return section;
}

/** Invocations parked for the owner — approve or deny, one by one. */
function renderParkedSection(
  input: VaultPaneInput,
  parked: VaultParkedEntry[],
  rerender: () => void,
): HTMLElement {
  const { el } = input;
  const section = el('div', { class: 'cd-app-settings-section cd-vault-parked' });
  section.append(el('div', { class: 'cd-vault-label' }, 'Waiting for your say-so'));

  for (const entry of parked) {
    const card = el('div', { class: 'cd-vault-parked-card' });
    card.append(
      el('div', { class: 'cd-vault-parked-head' }, [
        el('span', { class: 'cd-vault-parked-command' }, entry.command),
        el('span', { class: 'cd-vault-parked-when' }, relativeTime(entry.parkedAt)),
      ]),
      el('pre', { class: 'cd-vault-parked-input' }, JSON.stringify(entry.input, null, 2)),
    );
    const actions = el('div', { class: 'cd-vault-parked-actions' });
    const decide = (approve: boolean): void => {
      for (const b of actions.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
      confirmVaultParked({ invocationId: entry.invocationId, approve })
        .then(() => {
          input.showToast?.(approve ? 'Approved' : 'Denied');
          input.onAccessChanged?.();
          rerender();
        })
        .catch((err: unknown) => {
          input.showToast?.(err instanceof Error ? err.message : 'Confirmation failed');
          rerender();
        });
    };
    actions.append(
      el(
        'button',
        { class: 'cd-vault-approve-btn', type: 'button', onClick: () => decide(true) },
        'Approve',
      ),
      el(
        'button',
        { class: 'cd-vault-deny-btn', type: 'button', onClick: () => decide(false) },
        'Deny',
      ),
    );
    card.append(actions);
    section.append(card);
  }
  return section;
}

function scopeLabel(scope: VaultScope): string {
  return scope.table ? `${scope.schema}.${scope.table}` : scope.schema;
}
