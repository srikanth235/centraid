import { type JSX, useMemo, useState } from 'react';
import type { IconName } from '@centraid/design-tokens';
import type { AccentKey, AppearancePrefs, ThemeName } from '../../../app-shell-context.js';
import Icon from '../../ui/Icon.js';
import ImportScreen from '../../screens/ImportScreen.js';
import PhoneScreen from '../../screens/PhoneScreen.js';
import SettingsAppearanceScreen from '../../screens/SettingsAppearanceScreen.js';
import SettingsLayoutScreen from '../../screens/SettingsLayoutScreen.js';
import SettingsProfilesScreen from '../../screens/SettingsProfilesScreen.js';
import SettingsProvidersScreen from '../../screens/SettingsProvidersScreen.js';
import { useShellActions } from '../actions.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import { importCallbacks, loadProfilesData, phoneCallbacks } from './settingsAccountData.js';
import { openSpaceModal, requestDeleteSpace, type SpaceModalDeps } from './spaceModals.js';
import { activateRunner, loadProviders, setAgentModel } from './settingsProvidersData.js';

// React-owned Settings — the inner-sidebar shell. Replaces the vanilla
// renderSettings (app-settings.ts): a grouped category nav beside a content
// pane that shows one page at a time (page head + the page's controls). The
// Workspace + Models pages (Appearance/Layout/Providers) are native here; the
// Account pages (Spaces/Phone/Import) land in a follow-up.

type SettingsPageId =
  | 'appearance'
  | 'layout'
  | 'workspace'
  | 'profiles'
  | 'phone'
  | 'import'
  | 'providers';

interface PageDef {
  id: SettingsPageId;
  label: string;
  section: string;
  icon: IconName;
  subtitle: string;
}

const PAGES: readonly PageDef[] = [
  { id: 'appearance', label: 'Appearance', section: 'Workspace', icon: 'Mood', subtitle: 'Visual treatment for Centraid chrome and the app tiles on your home screen.' },
  { id: 'layout', label: 'Layout', section: 'Workspace', icon: 'Code', subtitle: 'Density and surface treatment across every Centraid screen.' },
  { id: 'workspace', label: 'Workspace', section: 'Workspace', icon: 'Folder', subtitle: 'Sidebar and navigation.' },
  { id: 'profiles', label: 'Spaces', section: 'Account', icon: 'Users', subtitle: 'Separate spaces — each one a vault with its own apps, chats, and data.' },
  { id: 'phone', label: 'Phone', section: 'Account', icon: 'Phone', subtitle: 'Use your published apps from your phone over an end-to-end encrypted tunnel.' },
  { id: 'import', label: 'Import', section: 'Account', icon: 'Save', subtitle: 'Bring your existing data into the vault — everything stages for review before it lands.' },
  { id: 'providers', label: 'Agents', section: 'Models', icon: 'Sparkle', subtitle: 'The coding-agent CLIs the gateway can drive.' },
];

const AUTO_SAVE = new Set<SettingsPageId>(['appearance', 'layout', 'workspace']);
const SECTIONS = ['Workspace', 'Account', 'Models'];

export interface SettingsRouteProps {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
  initialPage?: SettingsPageId;
}

export default function SettingsRoute({ prefs, setPrefs, initialPage }: SettingsRouteProps): JSX.Element {
  const [page, setPage] = useState<SettingsPageId>(initialPage ?? 'appearance');
  const def = PAGES.find((p) => p.id === page);
  const { showToast, navigate } = useShellActions();
  const phoneProps = useMemo(() => phoneCallbacks(showToast), [showToast]);
  const importProps = useMemo(() => importCallbacks(showToast), [showToast]);
  const [spacesNonce, setSpacesNonce] = useState(0);
  const spaces = useAsyncData(loadProfilesData, [spacesNonce]);
  const spaceDeps: SpaceModalDeps = useMemo(
    () => ({
      onChanged: () => setSpacesNonce((n) => n + 1),
      navigateHome: () => navigate({ kind: 'home' }),
    }),
    [navigate],
  );

  return (
    <div className="cd-settings-main">
      <aside className="cd-settings-nav">
        <div className="cd-settings-nav-head">
          <div className="cd-settings-nav-eyebrow">Settings</div>
          <div className="cd-settings-nav-title">Personal</div>
        </div>
        {SECTIONS.map((section) => (
          <div key={section} className="cd-settings-nav-section">
            <div className="cd-settings-nav-section-label">{section}</div>
            {PAGES.filter((p) => p.section === section).map((p) => (
              <button
                key={p.id}
                type="button"
                className="cd-settings-nav-item"
                data-active={String(p.id === page)}
                onClick={() => setPage(p.id)}
              >
                <Icon name={p.icon} size={15} />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <section className="cd-settings-content">
        <header className="cd-settings-page-head">
          <div className="cd-settings-page-titlerow">
            <h1 className="cd-settings-page-title">{def?.label ?? 'Settings'}</h1>
            {AUTO_SAVE.has(page) ? (
              <span className="cd-settings-autosaved">
                <Icon name="Check" size={10} strokeWidth={2.5} />
                <span>Auto-saved</span>
              </span>
            ) : null}
          </div>
          {def ? <p className="cd-settings-page-sub">{def.subtitle}</p> : null}
        </header>

        <div className="cd-settings-page">
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
                // Add / rename / delete open the vanilla `window.Profiles` modal
                // cluster; the gateway I/O + re-scope live in spaceModals.ts.
                onAdd={() => openSpaceModal('add', undefined, spaceDeps)}
                onEdit={(id) => {
                  const row = spaces.data.profiles.find((p) => p.id === id);
                  if (row) openSpaceModal('edit', row, spaceDeps);
                }}
                onDelete={(id) => {
                  const row = spaces.data.profiles.find((p) => p.id === id);
                  if (row) requestDeleteSpace(row, spaceDeps);
                }}
              />
            )
          ) : (
            <PageEmpty message="This settings page is being migrated to React." />
          )}
        </div>
      </section>
    </div>
  );
}
