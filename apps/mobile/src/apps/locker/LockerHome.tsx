// The four PLACES of Locker's band, on one route (README-Locker §1).
//
// Items, Review, Generate and Search are destinations WITHIN this screen
// rather than pushed stack entries — the same shape `TasksHome.tsx` uses — so
// a band tap swaps what is drawn instead of growing the stack. Item, Add/edit,
// Trash, Access history and the three elsewhere-surfaces ARE pushed, because
// each is a subject with a back row rather than a place.
//
// Everything about the boundary is `LockerScreen.tsx`'s: this file never asks
// whether the vault is locked, because behind a wall it is not rendered.
import React, { useCallback, useMemo, useState } from "react";

import {
  isConflicted,
  isParked,
} from "@centraid/blueprints/apps/locker/format";
import { defaultGenOptions } from "@centraid/blueprints/apps/locker/gen-model";
import type { GenOptions } from "@centraid/blueprints/apps/locker/gen-model";
import type {
  ItemFilter,
  LockerRow as LockerRowData,
} from "@centraid/blueprints/apps/locker/types";

import { postStatus } from "../../kit/components/status-line";
import { usePendingChanges } from "../../kit/replica/pending-changes";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { LockerScreenProps as LockerRouteProps } from "../../navigation";
import { copyLockerSecret } from "./locker-clipboard";
import { lockerBiometricsSupported } from "./locker-device-auth";
import {
  enrolLockerDevice,
  searchLocker,
  setLockerGenerated,
  showMoreLockerItems,
} from "./locker-store";
import {
  lockerPendingCount,
  lockerPendingLine,
  lockerScreenState,
} from "./locker-view-model";
import LockerGenView from "./LockerGenView";
import LockerItemsView from "./LockerItemsView";
import LockerReviewView from "./LockerReviewView";
import LockerScreen from "./LockerScreen";
import LockerSearchView from "./LockerSearchView";
import { useLockerVault } from "./useLockerVault";

export default function LockerHome({
  navigation,
  route,
}: LockerRouteProps<"LockerHome">): React.JSX.Element {
  const vault = useLockerVault();
  const replica = useReplica();
  const { pending } = usePendingChanges(replica.session);
  const [filter, setFilter] = useState<ItemFilter>({ kind: "all" });
  const [genOptions, setGenOptions] = useState<GenOptions>(defaultGenOptions);
  const destination = route.params?.destination ?? "items";

  const pendingCount = lockerPendingCount(pending);
  const pendingWait = lockerPendingLine(pending);
  const state = lockerScreenState({
    conflicted: vault.rows.some(isConflicted),
    denied: vault.denied !== null,
    loaded: vault.loaded,
    online: replica.online,
    parked: vault.rows.some(isParked),
    pending: pendingCount,
    reauth: vault.reauth,
    rows: vault.rows.length,
    stale: vault.stale,
  });

  const openItem = useCallback(
    (row: LockerRowData): void => {
      navigation.navigate("LockerItem", {
        itemId: row.item_id,
        title: row.title,
        type: row.type,
      });
    },
    [navigation]
  );

  const copy = useCallback((value: string): void => {
    void copyLockerSecret(value, "Password").then((outcome) => {
      postStatus(outcome.text);
    });
  }, []);

  const body = useMemo(() => {
    if (destination === "watch") {
      return (
        <LockerReviewView
          lastReadAt={vault.lastReadAt}
          onOpen={openItem}
          pending={pendingCount}
          rows={vault.rows}
          state={state}
        />
      );
    }
    if (destination === "gen") {
      return (
        <LockerGenView
          onCopy={copy}
          onOptions={setGenOptions}
          onPutOnItem={(value) =>
            navigation.navigate("LockerEdit", { generated: value })
          }
          onValue={setLockerGenerated}
          options={genOptions}
          value={vault.bag.generated}
        />
      );
    }
    if (destination === "search") {
      return (
        <LockerSearchView
          onOpen={openItem}
          onSearch={(term) => void searchLocker(term)}
          results={vault.bag.searchResults}
          term={vault.bag.searchTerm}
        />
      );
    }
    return (
      <LockerItemsView
        filter={filter}
        lastReadAt={vault.lastReadAt}
        loaded={vault.loaded}
        offerDevice={vault.credentialId === null && lockerBiometricsSupported()}
        onEnrolDevice={() => void enrolLockerDevice()}
        onFilter={setFilter}
        onImport={() =>
          navigation.navigate("LockerSurface", { surface: "import" })
        }
        onNew={() => navigation.navigate("LockerEdit", {})}
        onOpen={openItem}
        onShowMore={() => void showMoreLockerItems()}
        pending={pendingCount}
        waiting={pendingWait}
        rows={vault.rows}
        state={state}
        truncated={vault.truncated}
      />
    );
  }, [
    copy,
    destination,
    filter,
    genOptions,
    navigation,
    openItem,
    pendingCount,
    pendingWait,
    state,
    vault.bag.generated,
    vault.bag.searchResults,
    vault.bag.searchTerm,
    vault.credentialId,
    vault.lastReadAt,
    vault.loaded,
    vault.rows,
    vault.truncated,
  ]);

  return (
    <LockerScreen
      current={destination}
      route={ROUTE_OF[destination]}
      onBack={() => {
        if (destination === "items") navigation.popTo("Home");
        else navigation.popTo("LockerHome", { destination: "items" });
      }}
    >
      {body}
    </LockerScreen>
  );
}

const ROUTE_OF = {
  gen: "gen",
  items: "items",
  search: "search",
  watch: "watch",
} as const;
