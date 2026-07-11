import { Fragment, type JSX, useMemo, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import type { AccentKey, AppearancePrefs, ThemeName } from '../../../app-shell-context.js';
import Icon from '../../ui/Icon.js';
import ImportScreen from '../../screens/ImportScreen.js';
import PhoneScreen from '../../screens/PhoneScreen.js';
import SettingsAppearanceScreen from '../../screens/SettingsAppearanceScreen.js';
import SettingsConnectionsScreen from '../../screens/SettingsConnectionsScreen.js';
import SettingsLayoutScreen from '../../screens/SettingsLayoutScreen.js';
import SettingsProfilesScreen from '../../screens/SettingsProfilesScreen.js';
import SettingsProvidersScreen from '../../screens/SettingsProvidersScreen.js';
import { useShellActions } from '../actions.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import type { ProfileRowDTO } from '../../screen-contracts.js';
import { importCallbacks, loadProfilesData, phoneCallbacks } from './settingsAccountData.js';
import {
  beginConnectionAuthorize,
  loadConnectionProvidersData,
  loadConnectionsData,
  makeDetachConnection,
  submitConnectionForm,
  updateConnectionStatus,
} from './settingsConnectionsData.js';
import { createSpace, deleteSpace, loadSpaceInitial, saveSpace } from './spaceModals.js';
import SpaceModal, {
  DEFAULT_SPACE_ICON,
  randomSpaceColor,
  type SpaceModalInitial,
} from './SpaceModal.js';
import { activateRunner, loadProviders, setAgentModel } from './settingsProvidersData.js';
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
  | 'profiles'
  | 'phone'
  | 'import'
  | 'connections'
  | 'providers';

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
    id: 'profiles',
    label: 'Spaces',
    section: 'Account',
    icon: 'Users',
    subtitle:
      'Separate spaces — each one a vault with its own apps, chats, and data. Switch, add, rename, recolor, or remove spaces; manage the connections that host them.',
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
    id: 'providers',
    label: 'Agents',
    section: 'Models',
    icon: 'Sparkle',
    subtitle:
      'The coding-agent CLIs the gateway can drive. Detection checks whether each CLI is runnable on the gateway’s host — Centraid is agnostic to how they authenticate.',
  },
];

const AUTO_SAVE = new Set<SettingsPageId>(['appearance', 'layout', 'workspace']);
const SECTIONS = ['Workspace', 'Account', 'Models'];

export interface SettingsRouteProps {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
  initialPage?: SettingsPageId;
}

export default function SettingsRoute({
  prefs,
  setPrefs,
  initialPage,
}: SettingsRouteProps): JSX.Element {
  const [page, setPage] = useState<SettingsPageId>(initialPage ?? 'appearance');
  const def = PAGES.find((p) => p.id === page);
  const { showToast, navigate, confirm } = useShellActions();
  const phoneProps = useMemo(() => phoneCallbacks(showToast), [showToast]);
  const importProps = useMemo(() => importCallbacks(showToast), [showToast]);
  const detachConnection = useMemo(() => makeDetachConnection(confirm), [confirm]);
  const [spacesNonce, setSpacesNonce] = useState(0);
  const spaces = useAsyncData(loadProfilesData, [spacesNonce]);
  const refreshSpaces = (): void => setSpacesNonce((n) => n + 1);
  // The add/rename modal state (null = closed). `row` is set for edit/delete.
  const [spaceModal, setSpaceModal] = useState<{
    mode: 'add' | 'edit';
    row?: ProfileRowDTO;
    initial: SpaceModalInitial;
  } | null>(null);

  const openAddSpace = (): void =>
    setSpaceModal({
      mode: 'add',
      initial: { icon: DEFAULT_SPACE_ICON, color: randomSpaceColor() },
    });
  const openEditSpace = (row: ProfileRowDTO): void => {
    void loadSpaceInitial(row).then((initial) => setSpaceModal({ mode: 'edit', row, initial }));
  };
  const removeSpace = (row: ProfileRowDTO): void => {
    void (async () => {
      const ok = await confirm({
        title: 'Delete space?',
        message: `Delete "${row.name}"? Its vault and everything in it are removed. This can’t be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteSpace(row.id);
        showToast(`Deleted · ${row.name}`);
        refreshSpaces();
      } catch (err) {
        showToast(`Delete failed: ${String(err)}`);
      }
    })();
  };
  const commitSpace = (data: Parameters<typeof createSpace>[0]): void => {
    const modal = spaceModal;
    if (!modal) return;
    void (async () => {
      try {
        if (modal.mode === 'add') {
          await createSpace(data);
          setSpaceModal(null);
          showToast(`Space created · ${data.name}`);
          refreshSpaces();
          navigate({ kind: 'home' });
        } else if (modal.row) {
          await saveSpace(modal.row.id, data);
          setSpaceModal(null);
          showToast(`Saved · ${data.name}`);
          refreshSpaces();
        }
      } catch (err) {
        showToast(`Save failed: ${String(err)}`);
      }
    })();
  };

  return (
    <>
      <div className={styles.settingsMain}>
        <aside className={styles.settingsNav}>
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

          <div className={styles.settingsPage}>
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
            ) : page === 'profiles' ? (
              spaces.status === 'loading' ? (
                <PageLoading label="Loading spaces…" />
              ) : spaces.status === 'error' ? (
                <PageEmpty message={`Couldn’t load spaces: ${spaces.error}`} />
              ) : (
                <SettingsProfilesScreen
                  profiles={spaces.data.profiles}
                  connections={spaces.data.connections}
                  onSwitch={(id) => void window.CentraidApi.setActiveVault({ vaultId: id })}
                  onConnect={(id) => void window.CentraidApi.setActiveGateway({ id })}
                  onRemoveConnection={(id) => void window.CentraidApi.removeGateway({ id })}
                  // Add / rename / delete drive the React <SpaceModal> below; the
                  // gateway I/O + re-scope live in spaceModals.ts.
                  onAdd={openAddSpace}
                  onEdit={(id) => {
                    const row = spaces.data.profiles.find((p) => p.id === id);
                    if (row) openEditSpace(row);
                  }}
                  onDelete={(id) => {
                    const row = spaces.data.profiles.find((p) => p.id === id);
                    if (row) removeSpace(row);
                  }}
                />
              )
            ) : (
              <PageEmpty message="This settings page is being migrated to React." />
            )}
          </div>
        </section>
      </div>
      {spaceModal ? (
        <SpaceModal
          mode={spaceModal.mode}
          initial={spaceModal.initial}
          onCancel={() => setSpaceModal(null)}
          onCommit={commitSpace}
          {...(spaceModal.mode === 'edit' && spaceModal.row && !spaceModal.row.primordial
            ? {
                onDelete: () => {
                  const row = spaceModal.row!;
                  setSpaceModal(null);
                  removeSpace(row);
                },
              }
            : {})}
        />
      ) : null}
    </>
  );
}
