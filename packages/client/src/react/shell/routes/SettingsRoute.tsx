import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { IconName } from "@centraid/design";

import type { AppearancePrefs } from "../../../app-shell-context.js";
import { isWebHost } from "../../host-platform.js";
import SettingsAccessScreen from "../../screens/SettingsAccessScreen.js";
import SettingsAppearanceScreen from "../../screens/SettingsAppearanceScreen.js";
import SettingsEnrichmentScreen from "../../screens/SettingsEnrichmentScreen.js";
import SettingsHarnessesScreen from "../../screens/SettingsHarnessesScreen.js";
import SettingsProfileScreen from "../../screens/SettingsProfileScreen.js";
import SettingsVaultScreen from "../../screens/SettingsVaultScreen.js";
import Icon from "../../ui/Icon.js";
import PanelBlock from "../../ui/PanelBlock.js";
import ShellModal from "../../ui/ShellModal.js";
import { useShellActions } from "../actions.js";
import { disconnectConfirmCopy } from "../gatewayRegistry.js";
import { openPrompt } from "../prompt.js";
import { PageEmpty, PageLoading } from "../status.js";
import { useAsyncData } from "../useAsyncData.js";
import { useShellCapabilities } from "../useCapabilities.js";
import { loadSelfProfile, saveSelfProfile } from "./profileData.js";
import {
  accessReader,
  accessRegistryReader,
  loadAccessLens,
} from "./settingsAccessData.js";
import {
  loadActiveVaultData,
  loadSettingsStamp,
  loadThisDeviceData,
  setOfflineCopy,
} from "./settingsAccountData.js";
import {
  loadEnrichmentSettings,
  saveEngineProfile,
  writeEnrichRule,
  dropEnrichRule,
} from "./settingsEnrichmentData.js";
import {
  activateHarness,
  loadHarnesses,
  setHarnessModel,
  setHarnessConfigPin,
  setSubsystemModel,
  setSubsystemConfigPin,
  setSubsystemHarness,
  setSubsystemHarnessLadder,
} from "./settingsHarnessesData.js";
import { removeVault, saveVault } from "./vaultModals.js";

import styles from "./SettingsRoute.module.css";

// Settings — a category rail beside one page at a time. Pairing a phone lives
// in the account menu; component health and logs belong to `GatewayScreen`, so
// two "Gateway" surfaces never share a name.

export type SettingsPageId =
  | "appearance"
  | "vault"
  | "access"
  | "harnesses"
  | "enrichment";

interface PageDef {
  id: SettingsPageId;
  label: string;
  icon: IconName;
  /** Three words, on the NAV ROW: a rail that names only its pages makes the
   *  member open each one to find where a setting lives. */
  subtitle: string;
}

/*
 * Mark rules: no two rows share a glyph; a row wears the glyph its subject wears
 * elsewhere; neighbours stay distinguishable at 15px; and a glyph the shell
 * spends as a VERB (`Eye`) is never available for a category.
 */
const PAGES: readonly PageDef[] = [
  {
    id: "appearance",
    label: "You",
    icon: "User",
    subtitle: "Name, colour, theme",
  },
  {
    id: "vault",
    label: "Vault",
    icon: "Database",
    subtitle: "Name, colour, copies",
  },
  {
    // ACCESS, not "Sharing": harnesses and own devices are not shares (#883).
    id: "access",
    label: "Access",
    icon: "Key",
    subtitle: "Who may reach what",
  },
  {
    id: "harnesses",
    label: "Agents",
    icon: "Cpu",
    subtitle: "Harnesses and lanes",
  },
  {
    id: "enrichment",
    label: "Enrichment",
    icon: "Sparkle",
    subtitle: "What is read, and where",
  },
];
// Five pages: a page nothing routes to is not a page. Profile and Appearance
// are ONE page, keeping the `appearance` id so old deep links land;
// `resolveSettingsPage` collapses unknown ids onto the first page.

// EVERY PAGE AUTO-SAVES, so the note is the modal's, never a per-page badge.
// Destructive acts are not edits: they keep their verbs.
const AUTO_SAVED_NOTE = "Auto-saved";

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
  // Loosely typed so a deep link needs no import of the page union; validated
  // against `PAGES`.
  initialPage?: string;
  onClose?: () => void;
  /** The UNGUARDED act (#665): the primitive is connection-wide, so the confirm
   *  lives here, where the siblings are known by name. */
  onDisconnectVault: (gatewayId: string) => Promise<boolean>;
}

export default function SettingsRoute({
  prefs,
  setPrefs,
  initialPage,
  onClose,
  onDisconnectVault,
}: SettingsRouteProps): JSX.Element {
  const [page, setPage] = useState<SettingsPageId>(() =>
    resolveSettingsPage(initialPage)
  );
  const [footNote, setFootNote] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const capabilities = useShellCapabilities();

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
  // Scoped to the ACTIVE vault (#382). `vaultNonce` re-fetches after a save and
  // on any vault/gateway broadcast: switching vaults with this page open
  // re-seeds the form rather than editing the wrong vault.
  const [vaultNonce, setVaultNonce] = useState(0);
  const activeVault = useAsyncData(loadActiveVaultData, [vaultNonce]);
  const refreshVault = (): void => setVaultNonce((n) => n + 1);
  useEffect(() => {
    const offVault = window.CentraidApi.onVaultChanged?.(refreshVault);
    const offGateway = window.CentraidApi.onGatewayChanged?.(refreshVault);
    return () => {
      offVault?.();
      offGateway?.();
    };
  }, []);
  const saveActiveVault = (data: {
    name: string;
    icon: IconName;
    color: string;
    blurb: string;
  }): void => {
    if (activeVault.status !== "ready" || !activeVault.data) return;
    const vaultId = activeVault.data.vaultId;
    void saveVault(vaultId, data)
      .then(() => {
        showToast(`Saved · ${data.name}`);
        refreshVault();
      })
      .catch((error: unknown) =>
        showToast(
          `Save failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  };
  const selfProfile = useAsyncData(loadSelfProfile, []);
  const stamp = useAsyncData(loadSettingsStamp, []);
  const saveProfile = async (input: {
    name: string;
    avatarColor: string;
  }): Promise<void> => {
    if (selfProfile.status !== "ready" || !selfProfile.data) return;
    await saveSelfProfile({
      avatarColor: input.avatarColor,
      gatewayId: selfProfile.data.gatewayId,
      ownerId: selfProfile.data.ownerId,
      name: input.name,
    });
  };

  /* Rows come from the replica through People's scope; the per-locus revoke
     sentences come from the grant registry, in the vault's own words (#883). */
  const loadAccess = useCallback(
    async () =>
      loadAccessLens(await accessReader(), await accessRegistryReader()),
    []
  );

  const thisDeviceState = useAsyncData(loadThisDeviceData, []);
  const thisDevice =
    thisDeviceState.status === "ready" ? thisDeviceState.data : undefined;
  const changeOfflineCopy = async (next: boolean): Promise<boolean> => {
    try {
      return await setOfflineCopy(next);
    } catch (error) {
      showToast(
        `Couldn't change the offline copy: ${error instanceof Error ? error.message : String(error)}`
      );
      return !next;
    }
  };
  // REMOTE connections only: nothing to disconnect from the local gateway.
  // `disconnectConfirmCopy` owns the sibling wording (#665).
  const disconnectActiveVault = (): void => {
    if (activeVault.status !== "ready" || !activeVault.data) return;
    const { connection, name: vaultName } = activeVault.data;
    if (!connection) return;
    void (async () => {
      const ok = await confirm({
        confirmLabel: "Disconnect",
        danger: true,
        message: disconnectConfirmCopy(vaultName, connection.siblingNames),
        title: `Disconnect ${JSON.stringify(vaultName)}?`,
      });
      if (!ok) return;
      const done = await onDisconnectVault(connection.gatewayId);
      if (done) onClose?.();
    })();
  };

  const deleteActiveVault = (): void => {
    if (activeVault.status !== "ready" || !activeVault.data) return;
    const { vaultId, name } = activeVault.data;
    void (async () => {
      const typed = await openPrompt({
        title: `Type ${JSON.stringify(name)} to erase this vault`,
        placeholder: name,
        confirmLabel: "Erase permanently",
      });
      if (typed !== name) return;
      try {
        await removeVault(vaultId, typed);
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
      <ShellModal
        layer="inline"
        dialogRef={dialogRef}
        className={styles.settingsShell}
        ariaModal
        label="Settings"
        data={{ "data-testid": "settings-dialog" }}
      >
        {/* The modal's own bar, not a heading in the scrolling page: the note
            stays readable and the close target never scrolls away. */}
        <header className={styles.settingsHead}>
          <h1 className={styles.settingsTitle}>Settings</h1>
          <span className={styles.settingsAutosaved}>
            <Icon name="Check" size={10} strokeWidth={2.5} />
            <span>{AUTO_SAVED_NOTE}</span>
          </span>
          <button
            type="button"
            className={styles.dialogClose}
            aria-label="Close settings"
            onClick={() => onClose?.()}
          >
            <Icon name="X" size={15} />
          </button>
        </header>
        <div className={styles.settingsMain}>
          <aside className={styles.settingsNav} data-testid="settings-nav">
            {/* Flat: section labels over four entries are a taxonomy. */}
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.settingsNavItem}
                data-active={String(p.id === page)}
                onClick={() => setPage(p.id)}
              >
                <Icon name={p.icon} size={15} />
                <span className={styles.settingsNavText}>
                  <span className={styles.settingsNavLabel}>{p.label}</span>
                  <span className={styles.settingsNavSub}>{p.subtitle}</span>
                </span>
              </button>
            ))}
          </aside>

          <section className={styles.settingsContent}>
            <header className={styles.settingsPageHead}>
              <h2 className={styles.settingsPageTitle}>
                {def?.label ?? "Settings"}
              </h2>
            </header>

            <div className={styles.settingsPage} data-testid="settings-page">
              {page === "appearance" ? (
                <>
                  {selfProfile.status === "loading" ? (
                    <PageLoading label="Loading your profile…" />
                  ) : selfProfile.status === "ready" && selfProfile.data ? (
                    <SettingsProfileScreen
                      profile={selfProfile.data}
                      onSave={saveProfile}
                    />
                  ) : (
                    <PanelBlock
                      wide
                      eyebrow="No household roster"
                      title="This connection has no roster"
                      body="Your name and colour live there, so there is nothing to change here."
                    />
                  )}
                  <SettingsAppearanceScreen
                    themeMode={prefs.themeMode}
                    onSetThemeMode={(m) => setPrefs({ themeMode: m })}
                    automations={capabilities.automations}
                  />
                </>
              ) : page === "access" ? (
                <SettingsAccessScreen load={loadAccess} />
              ) : page === "harnesses" ? (
                <SettingsHarnessesScreen
                  loadStatus={() => loadHarnesses()}
                  refreshModels={() => loadHarnesses({ refresh: true })}
                  activateHarness={activateHarness}
                  setHarnessModel={setHarnessModel}
                  setHarnessConfigPin={setHarnessConfigPin}
                  setSubsystemModel={setSubsystemModel}
                  setSubsystemConfigPin={setSubsystemConfigPin}
                  setSubsystemHarness={setSubsystemHarness}
                  setSubsystemHarnessLadder={setSubsystemHarnessLadder}
                  showToast={setFootNote}
                />
              ) : page === "enrichment" ? (
                <SettingsEnrichmentScreen
                  load={loadEnrichmentSettings}
                  saveProfile={saveEngineProfile}
                  setEngineModel={setHarnessModel}
                  setEngineEffort={(harness, value) =>
                    setHarnessConfigPin(harness, "thought_level", value)
                  }
                  setRule={writeEnrichRule}
                  deleteRule={dropEnrichRule}
                  showToast={setFootNote}
                />
              ) : page === "vault" ? (
                activeVault.status === "loading" ? (
                  <PageLoading label="Loading this vault…" />
                ) : activeVault.status === "error" ? (
                  <PageEmpty
                    message={`Couldn’t load this vault: ${activeVault.error}`}
                  />
                ) : activeVault.data ? (
                  <SettingsVaultScreen
                    vault={activeVault.data}
                    onSave={saveActiveVault}
                    {...(activeVault.data.deletable
                      ? { onDelete: deleteActiveVault }
                      : {})}
                    {...(activeVault.data.connection
                      ? { onDisconnect: disconnectActiveVault }
                      : {})}
                    {...(isWebHost()
                      ? {
                          offlineCopy: thisDevice?.offlineCopy ?? false,
                          onOfflineCopy: changeOfflineCopy,
                        }
                      : {})}
                  />
                ) : (
                  <PageEmpty message="No active vault." />
                )
              ) : (
                <PageEmpty message="This settings page is being migrated to React." />
              )}
            </div>
          </section>
        </div>
        {/* A refusal is about the control just touched, so it belongs to the
            modal, not the shell's toast. */}
        <footer className={styles.settingsFoot}>
          {footNote ? (
            <p className={styles.settingsFootNote} role="alert">
              {footNote}
            </p>
          ) : null}
          <span className={styles.settingsStamp}>
            {stamp.status === "ready" ? stamp.data : "Centraid"}
          </span>
        </footer>
      </ShellModal>
    </>
  );
}
