import { Fragment, type JSX, useEffect, useMemo, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import type { AccentKey, AppearancePrefs, ThemeName } from '../../../app-shell-context.js';
import Icon from '../../ui/Icon.js';
import ImportScreen from '../../screens/ImportScreen.js';
import PhoneScreen from '../../screens/PhoneScreen.js';
import SettingsAppearanceScreen from '../../screens/SettingsAppearanceScreen.js';
import SettingsConnectionsScreen from '../../screens/SettingsConnectionsScreen.js';
import SettingsLayoutScreen from '../../screens/SettingsLayoutScreen.js';
import SettingsProvidersScreen from '../../screens/SettingsProvidersScreen.js';
import SettingsSpaceScreen from '../../screens/SettingsSpaceScreen.js';
import SettingsStorageScreen from '../../screens/SettingsStorageScreen.js';
import { useShellActions } from '../actions.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import { importCallbacks, loadActiveSpaceData, phoneCallbacks } from './settingsAccountData.js';
import {
  beginConnectionAuthorize,
  loadConnectionProvidersData,
  loadConnectionsData,
  makeDetachConnection,
  submitConnectionForm,
  updateConnectionStatus,
} from './settingsConnectionsData.js';
import { deleteSpace, saveSpace } from './spaceModals.js';
import {
  activateRunner,
  loadProviders,
  setAgentModel,
  setSubsystemModel,
  setSubsystemRunner,
} from './settingsProvidersData.js';
import {
  attachVaultConnection,
  confirmStorageRecoveryKit,
  createStorageConnection,
  detachVaultConnection,
  loadVaultBlobStoreData,
  loadStorageConnectionsData,
  makeDeleteStorageConnection,
  testStorageConnection,
} from './settingsStorageData.js';
import styles from './SettingsRoute.module.css';

// React-owned Settings — the inner-sidebar shell. Replaces the vanilla
// renderSettings (app-settings.ts): a grouped category nav beside a content
// pane that shows one page at a time (page head + the page's controls). The
// Workspace + Models pages (Appearance/Layout/Providers) are native here; the
// Account pages (Spaces/Phone/Import) land in a follow-up. Component health
// and logs used to live here as a "Gateway" section — they now live on the
// sidebar's Gateway page itself, as tabs (GatewayScreen.tsx), so the two
// "Gateway" surfaces stop being unrelated pages that share a name.

type SettingsPageId =
  | 'appearance'
  | 'layout'
  | 'workspace'
  | 'space'
  | 'phone'
  | 'import'
  | 'connections'
  | 'providers'
  | 'storage';

interface PageDef {
  id: SettingsPageId;
  label: string;
  section: string;
  icon: IconName;
  subtitle: string;
}

const PAGES: readonly PageDef[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    section: 'Workspace',
    icon: 'Mood',
    subtitle: 'Visual treatment for Centraid chrome and the app tiles on your home screen.',
  },
  {
    id: 'layout',
    label: 'Layout',
    section: 'Workspace',
    icon: 'Code',
    subtitle: 'Density and surface treatment across every Centraid screen.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    section: 'Workspace',
    icon: 'Folder',
    subtitle: 'Sidebar and navigation.',
  },
  {
    id: 'space',
    label: 'Space',
    section: 'Account',
    icon: 'Users',
    subtitle:
      'This space’s presentation — name, icon, color, and description. Switch, add, rename, or remove OTHER spaces and gateways from the switcher at the top of the sidebar (⌘⇧G).',
  },
  {
    id: 'phone',
    label: 'Phone',
    section: 'Account',
    icon: 'Phone',
    subtitle: 'Use your published apps from your phone over an end-to-end encrypted tunnel.',
  },
  {
    id: 'import',
    label: 'Import',
    section: 'Account',
    icon: 'Save',
    subtitle:
      'Bring your existing data into the vault — everything stages for review before it lands.',
  },
  {
    id: 'connections',
    label: 'Connections',
    section: 'Account',
    icon: 'Plug',
    subtitle:
      'Data sources the vault pulls from — Gmail, Calendar, GitHub, and anything else you connect yourself.',
  },
  {
    id: 'storage',
    label: 'Storage',
    section: 'Account',
    icon: 'Webhook',
    subtitle:
      'Keep this vault on this device only, or an encrypted copy hosted with your storage provider.',
  },
  {
    id: 'providers',
    label: 'Agents',
    section: 'Models',
    icon: 'Sparkle',
    subtitle:
      'The coding-agent CLIs the gateway can drive, plus which model each one uses by default and per chat surface. Detection checks whether each CLI is runnable on the gateway’s host — Centraid is agnostic to how they authenticate.',
  },
];

const AUTO_SAVE = new Set<SettingsPageId>(['appearance', 'layout', 'workspace']);
const SECTIONS = ['Workspace', 'Account', 'Models'];

function isSettingsPageId(id: string | undefined): id is SettingsPageId {
  return PAGES.some((p) => p.id === id);
}

export interface SettingsRouteProps {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
  // Loosely typed (not `SettingsPageId`) so a router-level deep link (e.g.
  // `{kind: 'settings', page: 'storage'}` — issue #367 §D3, the Gateway
  // page's Storage card) doesn't need a type-only import of this module's
  // private page union; validated against `PAGES` below.
  initialPage?: string;
}

export default function SettingsRoute({
  prefs,
  setPrefs,
  initialPage,
}: SettingsRouteProps): JSX.Element {
  const [page, setPage] = useState<SettingsPageId>(
    isSettingsPageId(initialPage) ? initialPage : 'appearance',
  );
  const def = PAGES.find((p) => p.id === page);
  const { showToast, navigate, confirm } = useShellActions();
  const phoneProps = useMemo(() => phoneCallbacks(showToast), [showToast]);
  const importProps = useMemo(() => importCallbacks(showToast), [showToast]);
  const detachConnection = useMemo(() => makeDetachConnection(confirm), [confirm]);
  const deleteStorageConnectionGated = useMemo(
    () => makeDeleteStorageConnection(confirm),
    [confirm],
  );
  // Settings → Space (issue #382) — scoped to the ACTIVE vault only; the
  // cross-vault list + gateway "Connections" group both moved to the
  // switcher. `spaceNonce` re-fetches after a save (the preview + dirty
  // check need the freshly-saved values as the new baseline) and on any
  // vault/gateway change broadcast (switching spaces while this page is
  // open should re-seed the form, not silently edit the wrong vault).
  const [spaceNonce, setSpaceNonce] = useState(0);
  const activeSpace = useAsyncData(loadActiveSpaceData, [spaceNonce]);
  const refreshSpace = (): void => setSpaceNonce((n) => n + 1);
  useEffect(() => {
    const offVault = window.CentraidApi.onVaultChanged?.(refreshSpace);
    const offGateway = window.CentraidApi.onGatewayChanged?.(refreshSpace);
    return () => {
      offVault?.();
      offGateway?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#382) mount-once subscription, refreshSpace is stable via setState's functional form
  }, []);
  const saveActiveSpace = (data: {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  }): void => {
    if (activeSpace.status !== 'ready' || !activeSpace.data) return;
    const vaultId = activeSpace.data.vaultId;
    void saveSpace(vaultId, data)
      .then(() => {
        showToast(`Saved · ${data.name}`);
        refreshSpace();
      })
      .catch((err: unknown) =>
        showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  };
  const deleteActiveSpace = (): void => {
    if (activeSpace.status !== 'ready' || !activeSpace.data) return;
    const { vaultId, name } = activeSpace.data;
    void (async () => {
      const ok = await confirm({
        title: 'Delete this space?',
        message: `Delete "${name}"? Its vault and everything in it are removed. This can’t be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteSpace(vaultId);
        showToast(`Deleted · ${name}`);
        navigate({ kind: 'home' });
      } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  return (
    <>
      <div className={styles.settingsMain}>
        <aside className={styles.settingsNav} data-testid="settings-nav">
          <div className={styles.settingsNavHead}>
            <div className={styles.settingsNavEyebrow}>Settings</div>
            <div className={styles.settingsNavTitle}>Personal</div>
          </div>
          {SECTIONS.map((section) => (
            // Fragment, not a wrapping div: the section label and its nav
            // items must be flat siblings inside <aside>, matching the
            // vanilla DOM (app-settings.ts innerNav.append(...) flat list).
            // A wrapping div here previously made the mono-font section-label
            // style cascade onto the nav item buttons via `font: inherit`.
            <Fragment key={section}>
              <div className={styles.settingsNavSection}>{section}</div>
              {PAGES.filter((p) => p.section === section).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={styles.settingsNavItem}
                  data-active={String(p.id === page)}
                  onClick={() => setPage(p.id)}
                >
                  <Icon name={p.icon} size={15} />
                  <span>{p.label}</span>
                </button>
              ))}
            </Fragment>
          ))}
          <div className={styles.settingsNavFoot}>
            <span className={styles.settingsNavVer}>v0.5.2</span>
          </div>
        </aside>

        <section className={styles.settingsContent}>
          <header className={styles.settingsPageHead}>
            <div className={styles.settingsPageTitlerow}>
              <h1 className={styles.settingsPageTitle}>{def?.label ?? 'Settings'}</h1>
              {AUTO_SAVE.has(page) ? (
                <span className={styles.settingsAutosaved}>
                  <Icon name="Check" size={10} strokeWidth={2.5} />
                  <span>Auto-saved</span>
                </span>
              ) : null}
            </div>
            {def ? <p className={styles.settingsPageSub}>{def.subtitle}</p> : null}
          </header>

          <div className={styles.settingsPage} data-testid="settings-page">
            {page === 'appearance' ? (
              <SettingsAppearanceScreen
                accent={prefs.accent}
                coolBlueCast={prefs.coolBlueCast}
                theme={prefs.theme}
                tileVariant={prefs.tileVariant}
                onMatchSystem={() => {
                  const next: ThemeName = window.matchMedia('(prefers-color-scheme: light)').matches
                    ? ('light' as ThemeName)
                    : ('dark' as ThemeName);
                  setPrefs({ theme: next });
                  return next;
                }}
                onSetAccent={(k) => setPrefs({ accent: k as AccentKey })}
                onSetCoolCast={(v) => setPrefs({ coolBlueCast: v })}
                onSetTheme={(t) => setPrefs({ theme: t as ThemeName })}
                onSetTile={(v) => setPrefs({ tileVariant: v })}
              />
            ) : page === 'layout' ? (
              <SettingsLayoutScreen
                cardVariant={prefs.cardVariant}
                density={prefs.density}
                sidebarOpen={prefs.sidebarOpen}
                onSetCards={(v) => setPrefs({ cardVariant: v })}
                onSetDensity={(v) => setPrefs({ density: v })}
                onSetSidebar={(v) => setPrefs({ sidebarOpen: v })}
              />
            ) : page === 'providers' ? (
              <SettingsProvidersScreen
                loadStatus={() => loadProviders()}
                refreshModels={() => loadProviders({ refresh: true })}
                refreshTools={() => loadProviders({ refreshTools: true })}
                activateRunner={activateRunner}
                setAgentModel={setAgentModel}
                setSubsystemModel={setSubsystemModel}
                setSubsystemRunner={setSubsystemRunner}
              />
            ) : page === 'phone' ? (
              <PhoneScreen {...phoneProps} />
            ) : page === 'import' ? (
              <ImportScreen {...importProps} />
            ) : page === 'connections' ? (
              <SettingsConnectionsScreen
                loadConnections={loadConnectionsData}
                loadProviders={loadConnectionProvidersData}
                configureConnection={submitConnectionForm}
                setConnectionStatus={updateConnectionStatus}
                detachConnection={detachConnection}
                beginAuthorize={beginConnectionAuthorize}
                showToast={showToast}
              />
            ) : page === 'storage' ? (
              <SettingsStorageScreen
                loadConnections={loadStorageConnectionsData}
                createConnection={createStorageConnection}
                deleteConnection={deleteStorageConnectionGated}
                testConnection={testStorageConnection}
                confirmRecoveryKit={confirmStorageRecoveryKit}
                loadVaultBlobStore={loadVaultBlobStoreData}
                attachVaultConnection={attachVaultConnection}
                detachVaultConnection={detachVaultConnection}
                showToast={showToast}
              />
            ) : page === 'space' ? (
              activeSpace.status === 'loading' ? (
                <PageLoading label="Loading this space…" />
              ) : activeSpace.status === 'error' ? (
                <PageEmpty message={`Couldn’t load this space: ${activeSpace.error}`} />
              ) : activeSpace.data ? (
                <SettingsSpaceScreen
                  space={activeSpace.data}
                  onSave={saveActiveSpace}
                  {...(activeSpace.data.deletable ? { onDelete: deleteActiveSpace } : {})}
                />
              ) : (
                <PageEmpty message="No active space." />
              )
            ) : (
              <PageEmpty message="This settings page is being migrated to React." />
            )}
          </div>
        </section>
      </div>
    </>
  );
}
