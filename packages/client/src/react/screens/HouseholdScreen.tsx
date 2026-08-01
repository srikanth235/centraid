import type { JSX } from "react";

import { tileFinish } from "@centraid/design-tokens";
import type { IconName } from "@centraid/design-tokens";

import {
  canAdministerHousehold,
  roleBadge,
  roleSentence,
} from "../shell/memberScope.js";
import type { MemberScope } from "../shell/memberScope.js";
import Icon from "../ui/Icon.js";
import DevicesCard from "./DevicesCard.js";
import type { DevicesCardProps } from "./DevicesCard.js";

import styles from "./HouseholdScreen.module.css";

// Household (issue #599) — one page for the people side of this installation.
// It shows every vault at once, together with the people who hold roles in
// them and the hardware acting on those people's behalf.
//
// Two sections, in the order the questions get asked:
//
//   People & devices — the roster card, moved here from the Gateway page. It
//     was never a runtime-health question; Gateway now answers only "is the
//     gateway up" (heartbeat, components, logs, alerts).
//   Vaults — every vault this member holds a role in, their access in ownership
//     words, and the settings surfaces that already exist for it.

export interface HouseholdScreenProps {
  /** Live clock (route ticks it) — drives the devices card's humanized ages. */
  now: number;
  /** Vaults the calling member holds a role in, own vault first. */
  vaults: MemberScope[];
  /** The shell's default/active scope pointer — badges one card "Default". */
  defaultScopeId: string;
  /** True until the scope registry's first fetch settles. */
  vaultsLoading?: boolean;
  /** Local disk footprint + limits (Gateway → Storage). */
  onOpenStorage: () => void;
  /** Open the "new vault" sheet. Omitted (a gateway this client can't create
   *  vaults on) hides the affordance rather than offering a failing button. */
  onNewVault?: () => void;
  /** Settings → Vault. Only offered for the default vault: that settings page
   *  edits whichever vault the client currently resolves to, so pointing it at
   *  another card's vault would quietly edit the wrong one. */
  onOpenVaultSettings?: () => void;
  /** Devices-card wiring. Optional so a host that can't list devices (or a
   *  test) renders the page without the roster rather than crashing. */
  loadDevices?: DevicesCardProps["loadDevices"];
  onRevokeDevice?: DevicesCardProps["onRevokeDevice"];
  onRenameDevice?: DevicesCardProps["onRenameDevice"];
  onCurrentDeviceRevoked?: DevicesCardProps["onCurrentDeviceRevoked"];
  loadMembers?: DevicesCardProps["loadMembers"];
  onRemoveMember?: DevicesCardProps["onRemoveMember"];
  onCreateDeviceTicket?: DevicesCardProps["onCreateTicket"];
  onUpdateDeviceCompute?: DevicesCardProps["onUpdateCompute"];
  loadDeviceWorkStatus?: DevicesCardProps["loadWorkStatus"];
}

function VaultCard({
  vault,
  isDefault,
  onOpenStorage,
  onOpenVaultSettings,
}: {
  vault: MemberScope;
  isDefault: boolean;
  onOpenStorage: () => void;
  onOpenVaultSettings?: () => void;
}): JSX.Element {
  const finish = tileFinish(vault.color ?? "#4E68DD", "gradient");
  return (
    <section className={styles.vault}>
      <div className={styles.vaultTop}>
        <span
          className={styles.avatar}
          aria-hidden="true"
          style={{
            background: finish.background,
            boxShadow: finish.boxShadow,
            color: finish.glyphColor,
          }}
        >
          <Icon
            name={(vault.icon as IconName) || "Sparkle"}
            size={16}
            strokeWidth={1.9}
          />
        </span>
        <span className={styles.vaultText}>
          <span className={styles.vaultName} title={vault.label}>
            {vault.label}
          </span>
          <span className={styles.vaultRole}>{roleSentence(vault.role)}</span>
        </span>
        <span
          className={styles.badge}
          data-default={isDefault ? "true" : undefined}
        >
          {isDefault ? "Default" : roleBadge(vault.role)}
        </span>
      </div>
      <div className={styles.vaultLinks}>
        <button
          type="button"
          className={styles.link}
          onClick={() => onOpenStorage()}
        >
          <Icon name="Save" size={12} />
          Storage &amp; backups
        </button>
        {onOpenVaultSettings ? (
          <button
            type="button"
            className={styles.link}
            onClick={() => onOpenVaultSettings()}
          >
            <Icon name="Settings" size={12} />
            Vault settings
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default function HouseholdScreen(
  props: HouseholdScreenProps
): JSX.Element {
  const { vaults, defaultScopeId } = props;
  const vaultCount = vaults.length;
  // Same source of truth as the "Viewer · <vault>" copy below: the scope
  // registry. A member who owns no vault gets read-only roster rows (B11).
  const canAdminister = canAdministerHousehold(vaults);
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Monitor" size={16} />
          </span>
          <h1>Devices</h1>
        </div>
        <div className={styles.headMeta}>
          The people who share this installation, the devices acting for them,
          and the vaults they can reach.
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>People &amp; devices</h2>
        </div>
        {props.loadDevices && props.onRevokeDevice ? (
          <DevicesCard
            now={props.now}
            canAdminister={canAdminister}
            loadDevices={props.loadDevices}
            onRevokeDevice={props.onRevokeDevice}
            {...(props.onRenameDevice
              ? { onRenameDevice: props.onRenameDevice }
              : {})}
            {...(props.onCurrentDeviceRevoked
              ? { onCurrentDeviceRevoked: props.onCurrentDeviceRevoked }
              : {})}
            {...(props.loadMembers ? { loadMembers: props.loadMembers } : {})}
            {...(props.onRemoveMember
              ? { onRemoveMember: props.onRemoveMember }
              : {})}
            {...(props.onCreateDeviceTicket
              ? { onCreateTicket: props.onCreateDeviceTicket }
              : {})}
            {...(props.onUpdateDeviceCompute
              ? { onUpdateCompute: props.onUpdateDeviceCompute }
              : {})}
            {...(props.loadDeviceWorkStatus
              ? { loadWorkStatus: props.loadDeviceWorkStatus }
              : {})}
          />
        ) : (
          <div className={styles.empty}>
            This connection doesn’t report a roster.
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>Vaults</h2>
          {vaultCount > 0 ? (
            <span className={styles.sectionMeta}>
              {vaultCount} {vaultCount === 1 ? "vault" : "vaults"} you can reach
            </span>
          ) : null}
          {props.onNewVault ? (
            <button
              type="button"
              className={styles.link}
              onClick={() => props.onNewVault?.()}
            >
              <Icon name="Plus" size={12} />
              New vault
            </button>
          ) : null}
        </div>
        {vaultCount > 0 ? (
          <div className={styles.vaults}>
            {vaults.map((vault) => (
              <VaultCard
                key={vault.id}
                vault={vault}
                isDefault={vault.id === defaultScopeId}
                onOpenStorage={props.onOpenStorage}
                {...(vault.id === defaultScopeId && props.onOpenVaultSettings
                  ? { onOpenVaultSettings: props.onOpenVaultSettings }
                  : {})}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            {props.vaultsLoading
              ? "Loading vaults…"
              : "No vaults are reachable from this device."}
          </div>
        )}
      </div>
    </div>
  );
}
