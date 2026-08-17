import { Fragment, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { IconName } from "@centraid/design";

import type { AppearancePrefs } from "../../../app-shell-context.js";
import { isWebHost } from "../../host-platform.js";
import SettingsAppearanceScreen from "../../screens/SettingsAppearanceScreen.js";
import SettingsEnrichmentScreen from "../../screens/SettingsEnrichmentScreen.js";
import SettingsHarnessesScreen from "../../screens/SettingsHarnessesScreen.js";
import SettingsProfileScreen from "../../screens/SettingsProfileScreen.js";
import SettingsVaultScreen from "../../screens/SettingsVaultScreen.js";
import Icon from "../../ui/Icon.js";
import { useShellActions } from "../actions.js";
import { disconnectConfirmCopy } from "../gatewayRegistry.js";
import { openPrompt } from "../prompt.js";
import { PageEmpty, PageLoading } from "../status.js";
import { useAsyncData } from "../useAsyncData.js";
import { useShellCapabilities } from "../useCapabilities.js";
import { loadSelfProfile, saveSelfProfile } from "./profileData.js";
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

// React-owned Settings — the inner-sidebar shell. Replaces the vanilla
// renderSettings (app-settings.ts): a grouped category nav beside a content
// pane that shows one page at a time (page head + the page's controls).
// Pairing a phone is NOT a
// page here: it is a one-off act, so it lives in the account menu as
// PairDeviceModal. Component health
// and logs used to live here as a "Gateway" section — they now live on the
// sidebar's Gateway page itself, as tabs (GatewayScreen.tsx), so the two
// "Gateway" surfaces stop being unrelated pages that share a name.

export type SettingsPageId =
  | "appearance"
  | "vault"
  | "harnesses"
  | "enrichment";

interface PageDef {
  id: SettingsPageId;
  label: string;
  section: string;
  icon: IconName;
  /**
   * Three words, carried by the NAV ROW rather than the page head. A rail
   * entry that names only its page makes a member open pages to find where a
   * setting lives; three words under the label answer that from the rail.
   */
  subtitle: string;
}

/*
 * Marks. Four rules, in the order they bite:
 *
 * 1. No two rows share a glyph. `Agents` and `Enrichment` both wore `Sparkle`,
 *    so half the rail was a coin flip. `Sparkle` is the ASK/assistant mark
 *    (`ICON_CONCEPTS.ask`), which is what enrichment is — a machine reading
 *    your data for you — so it stays there and Agents moves.
 * 2. A row wears the glyph its subject already wears elsewhere. Harnesses are
 *    marked `Cpu` where they are picked (AutomationEditorHarnessPicker), and
 *    the frame's Vault destination is `DESTINATION_MARKS.data` = `Database`.
 *    Settings → Vault said `Users`: a people glyph on a page that edits a
 *    container's name and colour, and the same word wearing two marks in one
 *    product.
 * 3. Neighbours must be distinguishable at 15px, not merely different. `User`
 *    beside `Users` is one silhouette at two counts — unreadable at rail size,
 *    which is the size it is always read at.
 * 4. A glyph the shell spends as a VERB cannot be a category here: `Eye` means
 *    "open this record" everywhere else, so it is not available for a nav row
 *    however well "what Centraid reads for you" reads.
 */
const PAGES: readonly PageDef[] = [
  {
    id: "appearance",
    label: "You",
    section: "Account",
    icon: "User",
    subtitle: "Name, colour, theme",
  },
  {
    id: "vault",
    label: "Vault",
    section: "Account",
    icon: "Database",
    subtitle: "Name, colour, copies",
  },
  {
    id: "harnesses",
    label: "Agents",
    section: "Models",
    icon: "Cpu",
    subtitle: "Harnesses and lanes",
  },
  {
    id: "enrichment",
    label: "Enrichment",
    section: "Models",
    icon: "Sparkle",
    subtitle: "What is read, and where",
  },
];
// Workspace, Import and Storage provider were hidden pages for several
// releases and are now gone (issue #807): a page nothing routes to is not a
// page. "This device" went the same way, though not identically: Pair a phone,
// What's new and Log out restated the stem's account menu, which still carries
// all three, and the offline copy moved to Vault → On this device, next to
// Disconnect. "Forget this device" is the one row that was neither — it was the
// standalone local-only purge, and retiring it is a real reduction. Its effect
// survives because `logOut` runs the same `forgetThisDeviceLocally` behind the
// same confirm copy, so the act is still reachable from the account menu.
// `resolveSettingsPage` still collapses their deep links, and every other
// unknown id, onto the first page.
//
// Profile and Appearance are now ONE page, "You": once Appearance lost the
// card surface it held a single segment, and two pages carrying three controls
// between them is a rail padded to look substantial. It keeps the `appearance`
// id so old deep links (including `profile`, via the collapse above) still
// land on the page that holds what they asked for. That emptied the Workspace
// section, so its header went with it.

// Pages whose every EDIT writes on its own: picks save on the pick, text
// fields on blur or Enter. The badge is a claim about the whole page, so it
// belongs only where nothing is left waiting on a Save button — both of these
// dropped theirs. Destructive acts (erase, disconnect) are not edits and keep
// their explicit buttons and confirms; they do not disqualify a page.
const AUTO_SAVE = new Set<SettingsPageId>(["appearance", "vault"]);
const SECTIONS = ["Account", "Models"];

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
  // `{kind: 'settings', page: 'enrichment'}` — the app popover's "Open
  // Enrichment settings", issue #807) doesn't need a type-only import of this
  // module's private page union; validated against `PAGES` below.
  initialPage?: string;
  /** Dismiss the dialog. Backdrop, the close button, and Escape all call it. */
  onClose?: () => void;
  /**
   * Drop the active vault's connection from this device (issue #665).
   *
   * The primitive is connection-wide — every vault the same host serves goes
   * with it — so the CONFIRM lives here, where the vault and its siblings are
   * known by name; this callback is the unguarded act. Resolves `true` once the
   * connection is gone, so the dialog can close itself instead of hovering over
   * a vault this device no longer reaches.
   */
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const capabilities = useShellCapabilities();

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
  // Settings → Vault (issue #382) — scoped to the ACTIVE vault only; the
  // cross-vault list + gateway "Connections" group both moved to the
  // switcher. `vaultNonce` re-fetches after a save (the preview + dirty
  // check need the freshly-saved values as the new baseline) and on any
  // vault/gateway change broadcast (switching vaults while this page is
  // open should re-seed the form, not silently edit the wrong vault).
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
  // Settings → You, the profile half. Read once per mount: the screen keeps the saved values
  // as its own new baseline, so a refetch here would only unmount the form at
  // the moment it is confirming the save.
  const selfProfile = useAsyncData(loadSelfProfile, []);
  // The foot stamp. Read once per mount: neither the running build's version
  // nor the gateway's host changes while the modal is open, and a gateway
  // switch closes the shell's routes underneath it anyway.
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

  // Settings → Vault → On this device. `getGatewayAuth` is the only host call
  // that reports this browser's local state, and it is cheap enough to read on
  // every mount rather than caching a second copy of the same truth.
  const thisDeviceState = useAsyncData(loadThisDeviceData, []);
  const thisDevice =
    thisDeviceState.status === "ready" ? thisDeviceState.data : undefined;
  // Flip this device's offline copy. Resolves with the value that actually
  // took effect so the switch never shows a state the device is not in: a
  // failed write comes back as the value we started from, plus a toast.
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
  // "On this device → Disconnect" (issue #665). Offered only when the active
  // vault sits on a REMOTE connection — the primordial local gateway is this
  // machine, and there is nothing to disconnect from. The act is
  // connection-wide, so the confirm names every sibling vault that goes with
  // it; `disconnectConfirmCopy` owns that wording.
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
                    <span className={styles.settingsNavText}>
                      <span className={styles.settingsNavLabel}>{p.label}</span>
                      <span className={styles.settingsNavSub}>
                        {p.subtitle}
                      </span>
                    </span>
                  </button>
                ))}
              </Fragment>
            ))}
            <div className={styles.settingsNavFoot}>
              <span className={styles.settingsNavVer}>
                {stamp.status === "ready" ? stamp.data : "Centraid"}
              </span>
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
            </header>

            <div className={styles.settingsPage} data-testid="settings-page">
              {page === "appearance" ? (
                // Profile first, theme second: the name and colour are what
                // everyone else sees, the theme is what only this browser
                // sees. The theme group renders whatever the roster does —
                // a connection with no roster loses the profile group, not
                // the page.
                <>
                  {selfProfile.status === "loading" ? (
                    <PageLoading label="Loading your profile…" />
                  ) : selfProfile.status === "ready" && selfProfile.data ? (
                    <SettingsProfileScreen
                      profile={selfProfile.data}
                      onSave={saveProfile}
                    />
                  ) : (
                    <PageEmpty message="This connection doesn’t expose a household roster, so there is no name or color to edit here." />
                  )}
                  <SettingsAppearanceScreen
                    themeMode={prefs.themeMode}
                    onSetThemeMode={(m) => setPrefs({ themeMode: m })}
                    automations={capabilities.automations}
                  />
                </>
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
                  showToast={showToast}
                />
              ) : page === "enrichment" ? (
                <SettingsEnrichmentScreen
                  load={loadEnrichmentSettings}
                  saveProfile={saveEngineProfile}
                  // The engine's model and level ARE the Agents page's pins:
                  // same prefs keys, one answer, written from whichever page
                  // the member happens to be reading.
                  setEngineModel={setHarnessModel}
                  setEngineEffort={(harness, value) =>
                    setHarnessConfigPin(harness, "thought_level", value)
                  }
                  setRule={writeEnrichRule}
                  deleteRule={dropEnrichRule}
                  showToast={showToast}
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
      </dialog>
    </>
  );
}
