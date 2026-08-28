// ACCESS HISTORY — `locker/access` (SURFACES.md: custodian AND origin).
//
// THIS SEAT READS THE RECEIPTS NOW. The `access` query is a manifested Locker
// query like `items` or `trash`, so it comes through the same one door
// (`locker-gateway.ts`) and needs the same live session. What used to stand
// here — the register, the no-values rule, and a sentence naming where the same
// receipts are read — is still on the screen, above the list rather than in
// place of it.
//
// The read is online-only by construction and this seat has no cached answer to
// fall back to, which is exactly right: a cached history would be a list of what
// this device happened to hold, drawn as the vault's whole record.
//
// Every sentence is the shared table's; the projection is the shared model's.
// The screen itself does nothing but mount the read and hand over what landed.

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
    // Withheld offline rather than attempted and failed: the journal is not on
    // this device, so there is nothing here for a retry to reach.
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
