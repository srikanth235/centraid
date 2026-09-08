// Which vault is active, and on which gateway — the two facts `VaultHeader`
// draws. Lifted out of `Home.tsx` when the lockup stopped being the
// springboard's alone (`VaultBar`): one subscription shape, so an app's header
// and the springboard's cannot disagree about which vault is open.

import { useEffect, useState } from "react";

import { getActiveVaultLink, subscribeVaultLinks } from "../../lib/vault-links";

export interface ActiveVault {
  vaultName: string | undefined;
  gatewayName: string | undefined;
  color: string | undefined;
}

export function useActiveVault(): ActiveVault {
  const [link, setLink] = useState(getActiveVaultLink);
  useEffect(() => subscribeVaultLinks(() => setLink(getActiveVaultLink())), []);
  return {
    color: link?.color,
    gatewayName: link?.desktopName,
    vaultName: link?.vaultName,
  };
}
