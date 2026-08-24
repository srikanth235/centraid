import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  answerCommonsInvitation,
  claimCommonsInvitation,
  approveGatewayLink,
  createGatewayDeviceTicket,
  getGatewayDeviceWorkStatus,
  listGatewayDevices,
  listGatewayEdges,
  listGatewayLinks,
  listGatewayOwners,
  listCommonsInvitations,
  listCommonsRecovery,
  proposeGatewayLink,
  recoverCommons,
  renameGatewayDevice,
  revokeGatewayDevice,
  setGatewayDeviceCompute,
} from "../../../gateway-client.js";
import HouseholdScreen from "../../screens/HouseholdScreen.js";
import type { HouseholdReport } from "../../screens/HouseholdScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { useOwnerScopes } from "../useOwnerScopes.js";
import VaultModal, {
  DEFAULT_VAULT_ICON,
  randomVaultColor,
} from "./VaultModal.js";
import { addVault } from "./vaultModals.js";
import { startVisibilityTicker } from "./visibility-ticker.js";

// React-owned Household route (issue #599, Decision 14; ownership #726). The
// roster half is the device/owner surface; the vaults half reads the owner's
// scope registry, which is also what
// every "which vault?" picker resolves against — one source, so the page and
// the pickers can never disagree about what this owner can reach.
/** How often the humanized ages advance. Minute granularity, because that is
 *  the granularity `seenAge` actually reports. */
const AGE_TICK_MS = 60_000;

export interface HouseholdRouteProps {
  /** Drawn as the "Where it lives" section of the merged Vault surface. */
  embedded?: boolean;
  /** Embedded only — the section's disclosure and its report upward. */
  collapsed?: boolean;
  onToggle?: () => void;
  onReport?: (report: HouseholdReport) => void;
  /** Embedded only — the census's record count, for the custody line. */
  records?: number | null;
}

export default function HouseholdRoute({
  embedded = false,
  collapsed,
  onToggle,
  onReport,
  records,
}: HouseholdRouteProps = {}): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const scopes = useOwnerScopes();
  const [now, setNow] = useState(() => Date.now());
  // "New vault" lives here with the rest of the vault vocabulary. `addVault`
  // operates on the gateway this client already addresses, which is the one
  // Household is describing, so there is no gateway to pick first.
  const [newVaultOpen, setNewVaultOpen] = useState(false);
  const canCreateVault = typeof window.CentraidApi.createVault === "function";
  const ownVaultIds = scopes.scopes.map((scope) => scope.id);

  // A MINUTE, not a second (v11). The roster's ages are bare and singular now
  // — "an hour ago", "yesterday", "2 days ago" — so a second-by-second tick
  // recomputed a string that changes once an hour, sixty times a minute. It
  // stays suspended while the tab is hidden (#528 Phase D wakeup hygiene) and
  // catches up the moment it returns.
  useEffect(
    () => startVisibilityTicker(() => setNow(Date.now()), AGE_TICK_MS),
    []
  );

  const content = (
    <>
      {newVaultOpen ? (
        <VaultModal
          mode="add"
          initial={{ color: randomVaultColor(), icon: DEFAULT_VAULT_ICON }}
          onCancel={() => setNewVaultOpen(false)}
          onCommit={(data) => {
            setNewVaultOpen(false);
            void (async () => {
              try {
                await addVault(data);
                showToast(`Vault created · ${data.name}`);
              } catch (error) {
                showToast(
                  `Couldn't create vault: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            })();
          }}
        />
      ) : null}
      <HouseholdScreen
        now={now}
        {...(embedded ? { embedded: true as const } : {})}
        {...(collapsed === undefined ? {} : { collapsed })}
        {...(onToggle ? { onToggle } : {})}
        {...(onReport ? { onReport } : {})}
        {...(records === undefined ? {} : { records })}
        vaults={scopes.scopes}
        defaultScopeId={scopes.defaultScopeId}
        vaultsLoading={scopes.loading}
        {...(canCreateVault ? { onNewVault: () => setNewVaultOpen(true) } : {})}
        onOpenStorage={() => navigate({ kind: "storage" })}
        onOpenVaultSettings={() =>
          navigate({ kind: "settings", page: "vault" })
        }
        loadDevices={listGatewayDevices}
        onRevokeDevice={revokeGatewayDevice}
        onRenameDevice={renameGatewayDevice}
        onCurrentDeviceRevoked={() =>
          import("../../../replica/shell-session.js").then((replica) =>
            replica.purgeCurrentReplicaDevice()
          )
        }
        loadOwners={listGatewayOwners}
        onCreateDeviceTicket={createGatewayDeviceTicket}
        onUpdateDeviceCompute={setGatewayDeviceCompute}
        loadDeviceWorkStatus={getGatewayDeviceWorkStatus}
        sharing={{
          now,
          ownVaultIds,
          loadLinks: listGatewayLinks,
          onProposeLink: proposeGatewayLink,
          onApproveLink: approveGatewayLink,
          loadEdges: listGatewayEdges,
          loadCommonsInvitations: listCommonsInvitations,
          onClaimCommonsInvitation: claimCommonsInvitation,
          onAnswerCommonsInvitation: answerCommonsInvitation,
          loadCommonsRecovery: listCommonsRecovery,
          onRecoverCommons: recoverCommons,
        }}
      />
    </>
  );
  return embedded ? content : <PageScroll>{content}</PageScroll>;
}
