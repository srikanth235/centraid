// ACCESS HISTORY — `locker/access` (SURFACES.md: custodian AND origin).
// Never give this read a cached fallback: it would draw what this device
// happened to hold as the vault's whole record.
import React, { useEffect, useMemo } from "react";

import { titlesOf } from "@centraid/blueprints/apps/locker/access-model";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { LockerScreenProps } from "../../navigation";
import { loadLockerAccess } from "./locker-surfaces";
import LockerAccessView from "./LockerAccessView";
import LockerScreen from "./LockerScreen";
import { useLockerVault } from "./useLockerVault";

export default function LockerAccessScreen({
  navigation,
}: LockerScreenProps<"LockerAccess">): React.JSX.Element {
  const vault = useLockerVault();
  const replica = useReplica();
  const online = replica.online;

  useEffect(() => {
    if (online) void loadLockerAccess();
  }, [online]);

  const titles = useMemo(() => titlesOf(vault.rows), [vault.rows]);

  return (
    <LockerScreen
      current="more"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route="access"
    >
      <LockerAccessView
        entries={vault.bag.accessEntries}
        error={vault.accessError}
        offline={!online}
        titles={titles}
        window={vault.accessWindow}
      />
    </LockerScreen>
  );
}
