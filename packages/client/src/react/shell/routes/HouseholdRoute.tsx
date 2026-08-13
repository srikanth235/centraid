import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  answerCommonsInvitation,
  claimCommonsInvitation,
  answerPendingEdge,
  approveGatewayLink,
  createGatewayDeviceTicket,
  getGatewayDeviceWorkStatus,
  getReceiveSetting,
  listGatewayDevices,
  listGatewayEdges,
  listGatewayLinks,
  listGatewayOwners,
  listCommonsInvitations,
  listCommonsRecovery,
  listPendingEdges,
  proposeGatewayLink,
  recoverCommons,
  renameGatewayDevice,
  revokeGatewayDevice,
  setGatewayDeviceCompute,
  setReceiveSetting,
} from "../../../gateway-client.js";
import HouseholdScreen from "../../screens/HouseholdScreen.js";
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
// roster half is the device/owner surface that used to hang off the Gateway
// page; the vaults half reads the owner's scope registry, which is also what
// every "which vault?" picker resolves against — one source, so the page and
// the pickers can never disagree about what this owner can reach.
export default function HouseholdRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const scopes = useOwnerScopes();
  const [now, setNow] = useState(() => Date.now());
  // "New vault" moved here with the rest of the vault vocabulary — it used to
  // hang off a gateway header row in the retired switcher. `addVault`
  // operates on the gateway this client already addresses, which is the one
  // Household is describing, so there is no gateway to pick first any more.
  const [newVaultOpen, setNewVaultOpen] = useState(false);
  const canCreateVault = typeof window.CentraidApi.createVault === "function";
  const ownVaultIds = scopes.scopes.map((scope) => scope.id);

  // 1s ticker for the devices card's humanized ages, suspended while the tab is
  // hidden (issue #528 Phase D wakeup hygiene) — same discipline as Gateway.
  useEffect(() => startVisibilityTicker(() => setNow(Date.now())), []);

  return (
    <PageScroll>
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
          loadReceiveSetting: getReceiveSetting,
          onSetReceiveSetting: setReceiveSetting,
          loadEdges: listGatewayEdges,
          loadPending: listPendingEdges,
          onAnswerPending: answerPendingEdge,
          loadCommonsInvitations: listCommonsInvitations,
          onClaimCommonsInvitation: claimCommonsInvitation,
          onAnswerCommonsInvitation: answerCommonsInvitation,
          loadCommonsRecovery: listCommonsRecovery,
          onRecoverCommons: recoverCommons,
        }}
      />
    </PageScroll>
  );
}
