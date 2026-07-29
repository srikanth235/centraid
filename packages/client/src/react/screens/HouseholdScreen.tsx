import { tileFinish } from "@centraid/design-tokens";
import type { IconName } from "@centraid/design-tokens";
import type { JSX } from "react";

import { roleBadge, roleSentence } from "../shell/memberScope.js";
import type { MemberScope } from "../shell/memberScope.js";
import Icon from "../ui/Icon.js";
import DevicesCard from "./DevicesCard.js";
import type { DevicesCardProps } from "./DevicesCard.js";

import styles from "./HouseholdScreen.module.css";

// Household (issue #599) — one page for the people side of this installation.
// It shows every space at once, together with the people who hold roles in
// them and the hardware acting on those people's behalf.
//
// Two sections, in the order the questions get asked:
//
//   People & devices — the roster card, moved here from the Gateway page. It
//     was never a runtime-health question; Gateway now answers only "is the
//     gateway up" (heartbeat, components, logs, alerts).
//   Spaces — every space this member holds a role in, their access in ownership
//     words, and the settings surfaces that already exist for it.

export interface HouseholdScreenProps {
  /** Live clock (route ticks it) — drives the devices card's humanized ages. */
  now: number;
  /** Spaces the calling member holds a role in, own space first. */
  spaces: MemberScope[];
  /** The shell's default/active scope pointer — badges one card "Default". */
  defaultScopeId: string;
  /** True until the scope registry's first fetch settles. */
  spacesLoading?: boolean;
  /** Local disk footprint + limits (Gateway → Storage). */
  onOpenStorage: () => void;
  /** Open the "new space" sheet. Omitted (a gateway this client can't create
   *  spaces on) hides the affordance rather than offering a failing button. */
  onNewSpace?: () => void;
  /** Settings → Space. Only offered for the default space: that settings page
   *  edits whichever space the client currently resolves to, so pointing it at
   *  another card's space would quietly edit the wrong one. */
  onOpenSpaceSettings?: () => void;
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

function SpaceCard({
  space,
  isDefault,
  onOpenStorage,
  onOpenSpaceSettings,
}: {
  space: MemberScope;
  isDefault: boolean;
  onOpenStorage: () => void;
  onOpenSpaceSettings?: () => void;
}): JSX.Element {
  const finish = tileFinish(space.color ?? "#4E68DD", "gradient");
  return (
    <section className={styles.space}>
      <div className={styles.spaceTop}>
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
            name={(space.icon as IconName) || "Sparkle"}
            size={16}
            strokeWidth={1.9}
          />
        </span>
        <span className={styles.spaceText}>
          <span className={styles.spaceName} title={space.label}>
            {space.label}
          </span>
          <span className={styles.spaceRole}>{roleSentence(space.role)}</span>
        </span>
        <span
          className={styles.badge}
          data-default={isDefault ? "true" : undefined}
        >
          {isDefault ? "Default" : roleBadge(space.role)}
        </span>
      </div>
      <div className={styles.spaceLinks}>
        <button
          type="button"
          className={styles.link}
          onClick={() => onOpenStorage()}
        >
          <Icon name="Save" size={12} />
          Storage &amp; backups
        </button>
        {onOpenSpaceSettings ? (
          <button
            type="button"
            className={styles.link}
            onClick={() => onOpenSpaceSettings()}
          >
            <Icon name="Settings" size={12} />
            Space settings
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default function HouseholdScreen(
  props: HouseholdScreenProps
): JSX.Element {
  const { spaces, defaultScopeId } = props;
  const spaceCount = spaces.length;
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Users" size={16} />
          </span>
          <h1>Household</h1>
        </div>
        <div className={styles.headMeta}>
          The people who share this installation, the devices acting for them,
          and the spaces they can reach.
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>People &amp; devices</h2>
        </div>
        {props.loadDevices && props.onRevokeDevice ? (
          <DevicesCard
            now={props.now}
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
            This gateway doesn’t report a roster.
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>Spaces</h2>
          {spaceCount > 0 ? (
            <span className={styles.sectionMeta}>
              {spaceCount} {spaceCount === 1 ? "space" : "spaces"} you can reach
            </span>
          ) : null}
          {props.onNewSpace ? (
            <button
              type="button"
              className={styles.link}
              onClick={() => props.onNewSpace?.()}
            >
              <Icon name="Plus" size={12} />
              New space
            </button>
          ) : null}
        </div>
        {spaceCount > 0 ? (
          <div className={styles.spaces}>
            {spaces.map((space) => (
              <SpaceCard
                key={space.id}
                space={space}
                isDefault={space.id === defaultScopeId}
                onOpenStorage={props.onOpenStorage}
                {...(space.id === defaultScopeId && props.onOpenSpaceSettings
                  ? { onOpenSpaceSettings: props.onOpenSpaceSettings }
                  : {})}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            {props.spacesLoading
              ? "Loading spaces…"
              : "No spaces are mounted on this gateway."}
          </div>
        )}
      </div>
    </div>
  );
}
