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
