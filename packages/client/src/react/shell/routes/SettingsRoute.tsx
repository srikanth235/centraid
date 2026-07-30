import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type { IconName } from "@centraid/design-tokens";

import type { AppearancePrefs } from "../../../app-shell-context.js";
import { isWebHost } from "../../host-platform.js";
import ImportScreen from "../../screens/ImportScreen.js";
import SettingsAppearanceScreen from "../../screens/SettingsAppearanceScreen.js";
import SettingsDeviceScreen from "../../screens/SettingsDeviceScreen.js";
import SettingsProfileScreen from "../../screens/SettingsProfileScreen.js";
import SettingsProvidersScreen from "../../screens/SettingsProvidersScreen.js";
import SettingsSpaceScreen from "../../screens/SettingsSpaceScreen.js";
import SettingsStorageScreen from "../../screens/SettingsStorageScreen.js";
import Icon from "../../ui/Icon.js";
import { useShellActions } from "../actions.js";
import { openPrompt } from "../prompt.js";
import { PageEmpty, PageLoading } from "../status.js";
import { useAsyncData } from "../useAsyncData.js";
import { loadSelfProfile, saveSelfProfile } from "./profileData.js";
import {
  forgetThisDeviceLocally,
  importCallbacks,
  loadActiveSpaceData,
  loadThisDeviceData,
} from "./settingsAccountData.js";
import {
  activateRunner,
  loadProviders,
  setAgentModel,
  setAgentConfigPin,
  setSubsystemModel,
  setSubsystemConfigPin,
  setSubsystemRunner,
  setSubsystemRunnerLadder,
} from "./settingsProvidersData.js";
import {
  attachVaultConnection,
  createStorageConnection,
  detachVaultConnection,
  loadVaultBlobStoreData,
  loadStorageConnectionsData,
  makeDeleteStorageConnection,
  testStorageConnection,
} from "./settingsStorageData.js";
import { deleteSpace, saveSpace } from "./spaceModals.js";

import styles from "./SettingsRoute.module.css";

// React-owned Settings — the inner-sidebar shell. Replaces the vanilla
// renderSettings (app-settings.ts): a grouped category nav beside a content
// pane that shows one page at a time (page head + the page's controls). The
// Workspace + Models pages (Appearance/Layout/Providers) are native here; the
// Account pages (Spaces/Import) land in a follow-up. Pairing a phone is NOT a
// page here: it is a one-off act, so it lives in the account menu as
// PairDeviceModal. Component health
// and logs used to live here as a "Gateway" section — they now live on the
// sidebar's Gateway page itself, as tabs (GatewayScreen.tsx), so the two
// "Gateway" surfaces stop being unrelated pages that share a name.

export type SettingsPageId =
  | "appearance"
  | "workspace"
  | "space"
  | "profile"
  | "device"
  | "import"
  | "providers"
  | "storage";

interface PageDef {
  id: SettingsPageId;
  label: string;
  section: string;
  icon: IconName;
  subtitle: string;
}

const ALL_PAGES: readonly PageDef[] = [
  {
    id: "appearance",
    label: "Appearance",
    section: "Workspace",
    icon: "Mood",
    subtitle:
      "Theme, density, and card surface for Centraid chrome. Apps keep their own light/dark palette.",
  },
  {
    id: "workspace",
    label: "Workspace",
    section: "Workspace",
    icon: "Folder",
    subtitle: "Sidebar and navigation.",
  },
  {
    id: "profile",
    label: "Profile",
    section: "Account",
    icon: "User",
    subtitle:
      "Your name and color, as the rest of your household sees them. The name lives on the household roster, not on this device.",
  },
  {
    id: "space",
    label: "Space",
    section: "Account",
    icon: "Users",
    subtitle:
      "This space’s presentation — name, icon, color, and description. Switch between reachable spaces, or add and manage gateways, from the sidebar switcher (⌘⇧G).",
  },
  // Web only: on desktop the gateway runs in-process, so "this device" has no
  // separate pairing to forget. The switcher's Remove-gateway action covers
  // the desktop case (App.tsx).
  {
    id: "device",
    label: "This device",
    section: "Account",
    icon: "Globe",
    subtitle:
      "What this browser stores locally — its pairing, its offline copy, and its cached previews.",
  },
  {
    id: "import",
    label: "Import",
    section: "Account",
    icon: "Save",
    subtitle:
      "Bring your existing data into the vault — everything stages for review before it lands.",
  },
  // Connections / Connectors moved to a primary sidebar page (ConnectorsRoute).
  // "Storage provider", not "Storage": Gateway owns the local footprint,
  // budget, and backup surfaces now (issues #544 and #608). This hidden route
  // remains narrower: it configures only the provider connection.
  {
    id: "storage",
    label: "Storage provider",
    section: "Account",
    icon: "Webhook",
    subtitle:
      "Keep this vault on this device only, or an encrypted copy hosted with your storage provider.",
  },
  {
    id: "providers",
    label: "Agents",
    section: "Models",
    icon: "Sparkle",
    subtitle:
      "The coding-agent CLIs the gateway can drive, plus which model each one uses by default and per chat surface. Detection checks whether each CLI is runnable on the gateway’s host — Centraid is agnostic to how they authenticate.",
  },
];
const HIDDEN = new Set(["workspace", "import", "storage"]);
const PAGES = ALL_PAGES.filter(
  (page) => !HIDDEN.has(page.id) && (page.id !== "device" || isWebHost())
);

const AUTO_SAVE = new Set<SettingsPageId>(["appearance"]);
const SECTIONS = ["Workspace", "Account", "Models"];

function isSettingsPageId(id: string | undefined): id is SettingsPageId {
  return PAGES.some((p) => p.id === id);
}

export function resolveSettingsPage(
  initialPage: string | undefined
): SettingsPageId {
  return isSettingsPageId(initialPage) ? initialPage : "appearance";
}

export interface SettingsRouteProps {
  prefs: AppearancePrefs;
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
  // Loosely typed (not `SettingsPageId`) so a router-level deep link (e.g.
  // `{kind: 'settings', page: 'storage'}` — issue #367 §D3, the Gateway
  // page's Storage card) doesn't need a type-only import of this module's
  // private page union; validated against `PAGES` below.
  initialPage?: string;
  /** Dismiss the dialog. Backdrop, the close button, and Escape all call it. */
  onClose?: () => void;
}

export default function SettingsRoute({
  prefs,
  setPrefs,
  initialPage,
  onClose,
}: SettingsRouteProps): JSX.Element {
  const [page, setPage] = useState<SettingsPageId>(() =>
    resolveSettingsPage(initialPage)
  );
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Escape closes, and focus lands inside on open so the rail is immediately
  // keyboard-reachable rather than leaving focus behind on the sidebar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose?.();
    };
    document.addEventListener("keydown", onKey);
    const timer = setTimeout(
      () =>
        dialogRef.current
          ?.querySelector<HTMLButtonElement>('[data-active="true"]')
          ?.focus(),
      30
    );
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [onClose]);
  const def = PAGES.find((p) => p.id === page);
  const { showToast, navigate, confirm } = useShellActions();
  const importProps = useMemo(() => importCallbacks(showToast), [showToast]);
  const deleteStorageConnectionGated = useMemo(
    () => makeDeleteStorageConnection(confirm),
    [confirm]
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
  }, []);
  const saveActiveSpace = (data: {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  }): void => {
    if (activeSpace.status !== "ready" || !activeSpace.data) return;
    const vaultId = activeSpace.data.vaultId;
    void saveSpace(vaultId, data)
      .then(() => {
        showToast(`Saved · ${data.name}`);
        refreshSpace();
      })
      .catch((error: unknown) =>
        showToast(
          `Save failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  };
  // Settings → Profile. Read once per mount: the screen keeps the saved values
  // as its own new baseline, so a refetch here would only unmount the form at
  // the moment it is confirming the save.
  const selfProfile = useAsyncData(loadSelfProfile, []);
  const saveProfile = async (input: {
    name: string;
    avatarColor: string;
  }): Promise<void> => {
    if (selfProfile.status !== "ready" || !selfProfile.data) return;
    await saveSelfProfile({
      avatarColor: input.avatarColor,
      gatewayId: selfProfile.data.gatewayId,
      memberId: selfProfile.data.memberId,
      name: input.name,
    });
  };

  // Settings → This device. `getGatewayAuth` is the only host call that reports
  // both halves of this browser's local state, and it is cheap enough to read
  // on every mount rather than caching a second copy of the same truth.
  const thisDeviceState = useAsyncData(loadThisDeviceData, []);
  const thisDevice =
    thisDeviceState.status === "ready" ? thisDeviceState.data : undefined;
  const forgetThisDevice = (): void => {
    void (async () => {
      const ok = await confirm({
        confirmLabel: "Forget",
        danger: true,
        message:
          "This browser drops its device key, offline copy, and cached previews, and returns to onboarding. Your vault is untouched — the enrollment stays on the gateway until you revoke it from Household → Devices.",
        title: "Forget this device?",
      });
      if (!ok) return;
      try {
        await forgetThisDeviceLocally(thisDevice?.gatewayId);
      } catch (error) {
        showToast(
          `Couldn't forget this device: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  };
  const deleteActiveSpace = (): void => {
    if (activeSpace.status !== "ready" || !activeSpace.data) return;
    const { vaultId, name } = activeSpace.data;
    void (async () => {
      const typed = await openPrompt({
        title: `Type ${JSON.stringify(name)} to erase this space`,
        placeholder: name,
        confirmLabel: "Erase permanently",
      });
      if (typed !== name) return;
      try {
        await deleteSpace(vaultId, typed);
        showToast(`Deleted · ${name}`);
        navigate({ kind: "home" });
      } catch (error) {
        showToast(
          `Delete failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  };

  return (
    <>
      <div
        className={styles.backdrop}
        role="presentation"
        onClick={() => onClose?.()}
      />
      <dialog
        open
        ref={dialogRef}
        className={styles.settingsShell}
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-dialog"
      >
        <button
          type="button"
          className={styles.dialogClose}
          aria-label="Close settings"
          onClick={() => onClose?.()}
        >
          <Icon name="X" size={15} />
        </button>
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
                <h1 className={styles.settingsPageTitle}>
                  {def?.label ?? "Settings"}
                </h1>
                {AUTO_SAVE.has(page) ? (
                  <span className={styles.settingsAutosaved}>
                    <Icon name="Check" size={10} strokeWidth={2.5} />
                    <span>Auto-saved</span>
                  </span>
                ) : null}
              </div>
              {def ? (
                <p className={styles.settingsPageSub}>{def.subtitle}</p>
              ) : null}
            </header>

            <div className={styles.settingsPage} data-testid="settings-page">
              {page === "appearance" ? (
                <SettingsAppearanceScreen
                  cardVariant={prefs.cardVariant}
                  density={prefs.density}
                  themeMode={prefs.themeMode}
                  onSetCards={(v) => setPrefs({ cardVariant: v })}
                  onSetDensity={(v) => setPrefs({ density: v })}
                  onSetThemeMode={(m) => setPrefs({ themeMode: m })}
                />
              ) : page === "providers" ? (
                <SettingsProvidersScreen
                  loadStatus={() => loadProviders()}
                  refreshModels={() => loadProviders({ refresh: true })}
                  activateRunner={activateRunner}
                  setAgentModel={setAgentModel}
                  setAgentConfigPin={setAgentConfigPin}
                  setSubsystemModel={setSubsystemModel}
                  setSubsystemConfigPin={setSubsystemConfigPin}
                  setSubsystemRunner={setSubsystemRunner}
                  setSubsystemRunnerLadder={setSubsystemRunnerLadder}
                />
              ) : page === "profile" ? (
                selfProfile.status === "loading" ? (
                  <PageLoading label="Loading your profile…" />
                ) : selfProfile.status === "ready" && selfProfile.data ? (
                  <SettingsProfileScreen
                    profile={selfProfile.data}
                    onSave={saveProfile}
                  />
                ) : (
                  <PageEmpty message="This gateway doesn’t expose a household roster, so there is no profile to edit here." />
                )
              ) : page === "device" ? (
                <SettingsDeviceScreen
                  {...(thisDevice?.gatewayLabel
                    ? { gatewayLabel: thisDevice.gatewayLabel }
                    : {})}
                  offlineCopy={thisDevice?.offlineCopy ?? false}
                  onForget={forgetThisDevice}
                />
              ) : page === "import" ? (
                <ImportScreen {...importProps} />
              ) : page === "storage" ? (
                <SettingsStorageScreen
                  loadConnections={loadStorageConnectionsData}
                  createConnection={createStorageConnection}
                  deleteConnection={deleteStorageConnectionGated}
                  testConnection={testStorageConnection}
                  loadVaultBlobStore={loadVaultBlobStoreData}
                  attachVaultConnection={attachVaultConnection}
                  detachVaultConnection={detachVaultConnection}
                  showToast={showToast}
                />
              ) : page === "space" ? (
                activeSpace.status === "loading" ? (
                  <PageLoading label="Loading this space…" />
                ) : activeSpace.status === "error" ? (
                  <PageEmpty
                    message={`Couldn’t load this space: ${activeSpace.error}`}
                  />
                ) : activeSpace.data ? (
                  <SettingsSpaceScreen
                    space={activeSpace.data}
                    onSave={saveActiveSpace}
                    {...(activeSpace.data.deletable
                      ? { onDelete: deleteActiveSpace }
                      : {})}
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
      </dialog>
    </>
  );
}
