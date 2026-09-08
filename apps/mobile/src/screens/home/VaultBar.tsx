// The vault lockup, as chrome an APP can mount — not just the springboard.
//
// `VaultHeader`'s own header states the rule this file acts on: "the two facts
// true on EVERY route: which vault, which gateway". The springboard was the
// only route that drew them, so inside an app the member lost both — which
// vault they were reading and whether its gateway was reachable — and the two
// product-wide verbs (search everything, new chat) went with them.
//
// DELIBERATELY LIGHT, and that is a constraint rather than a preference. All
// three verbs arrive as handlers from `VaultChrome`, mounted once at the root:
//
//   * no `useNavigation` here, so a surface that draws the header does not have
//     to mock a navigator to render in a test (six RNTL suites failed to even
//     parse when it did);
//   * no overlay imports here, so no app frame pulls the launcher catalog, the
//     blueprint search index or the gateway client into its module graph, and
//     eight app frames do not mount eight vault switchers between them.

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
