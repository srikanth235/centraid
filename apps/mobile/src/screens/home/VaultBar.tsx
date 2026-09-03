import React from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useActiveVault } from "./useActiveVault";
import { useVaultChrome } from "./vault-chrome-context";
import VaultHeader from "./VaultHeader";

export default function VaultBar(): React.JSX.Element {
  const vault = useActiveVault();
  const { online } = useReplica();
  const chrome = useVaultChrome();

  const handleSwitchVault = chrome.openVaults;
  const handleSearch = chrome.openSearch;
  const handleNewChat = chrome.openNewChat;

  return (
    <VaultHeader
      vaultName={vault.vaultName}
      gatewayName={vault.gatewayName}
      color={vault.color}
      offline={!online}
      onSwitchVault={handleSwitchVault}
      onSearch={handleSearch}
      onNewChat={handleNewChat}
    />
  );
}
