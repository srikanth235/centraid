import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  approveGatewayLink,
  createGatewayDeviceTicket,
  getGatewayDeviceWorkStatus,
  listGatewayDevices,
  listGatewayLinks,
  listGatewayOwners,
  proposeGatewayLink,
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

const AGE_TICK_MS = 60_000;

export interface HouseholdRouteProps {
  embedded?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onReport?: (report: HouseholdReport) => void;
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
  const [newVaultOpen, setNewVaultOpen] = useState(false);
  const canCreateVault = typeof window.CentraidApi.createVault === "function";
  const ownVaultIds = scopes.scopes.map((scope) => scope.id);

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
        }}
      />
    </>
  );
  return embedded ? content : <PageScroll>{content}</PageScroll>;
}
