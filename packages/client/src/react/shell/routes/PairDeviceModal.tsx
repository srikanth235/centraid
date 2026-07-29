import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  createGatewayDeviceTicket,
  listGatewayMembers,
} from "../../../gateway-client.js";
import DevicePairPanel from "../../screens/DevicePairPanel.js";
import type { PairSpace } from "../../screens/DevicePairTarget.js";
import { cx } from "../../ui/cx.js";
import { iconSvg } from "../iconSvg.js";
import { useAsyncData } from "../useAsyncData.js";
import { useMemberScopes } from "../useMemberScopes.js";
import { loadSelfProfile } from "./profileData.js";

import controlsCss from "../../styles/controls.module.css";
import spaceModalStyles from "./SpaceModal.module.css";

export interface PairDeviceModalProps {
  onClose: () => void;
}

/**
 * Pairing a device from the account menu, not from Settings.
 *
 * Pairing is a one-off ACT you perform — mint a ticket, scan it, done — the
 * same shape as "Log out" rather than "Appearance", so it left the settings
 * rail for this modal. It hosts the SAME `DevicePairPanel` that Household →
 * Devices offers, deliberately: two ways to reach one surface, not a second
 * implementation that can drift.
 *
 * Not the Electron phone-tunnel screen that used to be Settings → Phone. That
 * one publishes desktop apps over a tunnel and is inert on web (the browser
 * host answers "pairing is managed by the gateway or desktop client"); this is
 * the ticket flow that actually enrolls a phone against this gateway.
 *
 * Landing state is self-pair, which is what makes "add my own phone" cost
 * nothing: the gateway derives the access from the enrollment you already
 * hold, so no member is named and no name is asked for again.
 */
export default function PairDeviceModal({
  onClose,
}: PairDeviceModalProps): JSX.Element {
  const scopes = useMemberScopes();
  const membersState = useAsyncData(listGatewayMembers, []);
  const members = membersState.status === "ready" ? membersState.data : [];
  // Who "For myself" is, so the caller's own row never also appears as a peer.
  const selfState = useAsyncData(loadSelfProfile, []);
  const selfMemberId =
    selfState.status === "ready" ? selfState.data?.memberId : undefined;
  const [now, setNow] = useState(() => Date.now());

  // The panel humanizes its ticket's remaining life, so it needs a clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The scope registry is the same source every "which space?" picker reads,
  // so the grant rows here can never disagree with what this member can reach.
  const spaces: PairSpace[] = scopes.scopes.map((scope) => ({
    vaultId: scope.id,
    vaultName: scope.label,
  }));

  return (
    <div className={spaceModalStyles.profOverlay}>
      <button
        type="button"
        className={spaceModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <dialog
        open
        className={spaceModalStyles.profModal}
        aria-modal="true"
        data-testid="pair-device-modal"
      >
        <div className={spaceModalStyles.profModalHead}>
          <span
            className={spaceModalStyles.profModalHeadIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg("Phone", 14) }}
          />
          <h2 className={spaceModalStyles.profModalTitle}>Pair a device</h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, spaceModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: iconSvg("X", 14) }}
          />
        </div>
        <div className={spaceModalStyles.profModalBody}>
          <DevicePairPanel
            now={now}
            onCreateTicket={createGatewayDeviceTicket}
            onClose={onClose}
            members={members}
            {...(selfMemberId ? { currentMemberId: selfMemberId } : {})}
            spaces={spaces}
          />
        </div>
      </dialog>
    </div>
  );
}
