import { type JSX, useEffect, useState } from "react";

import {
  createGatewayDeviceTicket,
  getGatewayDeviceWorkStatus,
  listGatewayDevices,
  listGatewayMembers,
  removeGatewayMember,
  revokeGatewayDevice,
  setGatewayDeviceCompute,
} from "../../../gateway-client.js";
import HouseholdScreen from "../../screens/HouseholdScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { useMemberScopes } from "../useMemberScopes.js";
import SpaceModal, {
  DEFAULT_SPACE_ICON,
  randomSpaceColor,
} from "./SpaceModal.js";
import { createSpace } from "./spaceModals.js";
import { startVisibilityTicker } from "./visibility-ticker.js";

// React-owned Household route (issue #599, Decision 14). The roster half is the
// device/member surface that used to hang off the Gateway page; the spaces half
// reads the member's scope registry, which is also what every "which space?"
// picker resolves against — one source, so the page and the pickers can never
// disagree about what this member can reach.
export default function HouseholdRoute(): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const scopes = useMemberScopes();
  const [now, setNow] = useState(() => Date.now());
  // "New space" moved here with the rest of the space vocabulary — it used to
  // hang off a gateway header row in the retired switcher. `createSpace`
  // operates on the gateway this client already addresses, which is the one
  // Household is describing, so there is no gateway to pick first any more.
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const canCreateSpace = typeof window.CentraidApi.createVault === "function";

  // 1s ticker for the devices card's humanized ages, suspended while the tab is
  // hidden (issue #528 Phase D wakeup hygiene) — same discipline as Gateway.
  useEffect(() => startVisibilityTicker(() => setNow(Date.now())), []);

  return (
    <PageScroll>
      {newSpaceOpen ? (
        <SpaceModal
          mode="add"
          initial={{ color: randomSpaceColor(), icon: DEFAULT_SPACE_ICON }}
          onCancel={() => setNewSpaceOpen(false)}
          onCommit={(data) => {
            setNewSpaceOpen(false);
            void (async () => {
              try {
                await createSpace(data);
                showToast(`Space created · ${data.name}`);
              } catch (err) {
                showToast(
                  `Couldn't create space: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            })();
          }}
        />
      ) : null}
      <HouseholdScreen
        now={now}
        spaces={scopes.scopes}
        defaultScopeId={scopes.defaultScopeId}
        spacesLoading={scopes.loading}
        {...(canCreateSpace ? { onNewSpace: () => setNewSpaceOpen(true) } : {})}
        onOpenStorage={() => navigate({ kind: "storage" })}
        onOpenSpaceSettings={() =>
          navigate({ kind: "settings", page: "space" })
        }
        loadDevices={listGatewayDevices}
        onRevokeDevice={revokeGatewayDevice}
        onCurrentDeviceRevoked={() =>
          import("../../../replica/shell-session.js").then((replica) =>
            replica.purgeCurrentReplicaDevice()
          )
        }
        loadMembers={listGatewayMembers}
        onRemoveMember={removeGatewayMember}
        onCreateDeviceTicket={createGatewayDeviceTicket}
        onUpdateDeviceCompute={setGatewayDeviceCompute}
        loadDeviceWorkStatus={getGatewayDeviceWorkStatus}
      />
    </PageScroll>
  );
}
