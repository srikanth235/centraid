// THE FOUR PLACES OF TALLY'S BAND, on one route (spec §1).
//
// Balances, Activity, Groups and Waiting are destinations WITHIN this screen
// rather than pushed stack entries — the same shape `TasksHome.tsx` and
// `LockerHome.tsx` use — so a band tap swaps what is drawn instead of growing
// the stack. Every other surface IS pushed, because each is a subject with a
// back row rather than a place.
//
// THE ACTS THAT ASK FIRST ASK HERE. Add a friend, New group, Leave, Archive
// and Remind each open the one confirm/composer sheet, in §6's own words, and
// each dispatches through the shared write door. Nothing on this screen builds
// a payload of its own.
//
// Everything about the denied gate is `TallyScreen.tsx`'s: this file never asks
// whether the grant is gone, because behind the gate it is not rendered.

import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  COMPOSE_OUTCOMES,
  FRIEND_BODY,
  FRIEND_COMMIT,
  FRIEND_HEAD,
  GROUP_BODY,
  GROUP_COLOURS,
  GROUP_COMMIT,
  GROUP_HEAD,
  GROUP_ICONS,
  NUDGE_BODY,
  NUDGE_COMMIT,
  PLACEHOLDERS,
  FIELD_KEYS,
  nudgeTitle,
} from "@centraid/blueprints/apps/tally/compose-copy";
import type {
  ContribRow,
  ContribVerb,
} from "@centraid/blueprints/apps/tally/contrib-model";
import {
  ACTIVITY,
  GROUPS,
  WAITING,
} from "@centraid/blueprints/apps/tally/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tally/shelves";
import {
  ARCHIVE_BODY,
  ARCHIVE_BODY_2,
  ARCHIVE_TITLE,
  LEAVE_BODY,
  LEAVE_BODY_2,
  LEAVE_TITLE,
  UNARCHIVE_BODY,
  UNARCHIVE_TITLE,
  VERBS,
} from "@centraid/blueprints/apps/tally/view-copy";
import {
  addFriendWrite,
  archiveGroupWrite,
  createGroupWrite,
  leaveGroupWrite,
  nudgeWrite,
} from "@centraid/blueprints/apps/tally/writes";

import { postStatus } from "../../kit/components/status-line";
import { usePendingChanges } from "../../kit/replica/pending-changes";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import type { TallyScreenProps } from "../../navigation";
import ActivityView from "./ActivityView";
import BalancesView from "./BalancesView";
import GroupsView from "./GroupsView";
import { loadTallyActivity, showMoreTallyActivity } from "./tally-store";
import {
  tallyHasConflict,
  tallyHasParked,
  tallyPendingCount,
  tallyScreenState,
  tallyWaiting,
} from "./tally-view-model";
import { issueTallyWrite } from "./tally-writes";
import type { TallyAsk } from "./TallyAskSheet";
import TallyAskSheet from "./TallyAskSheet";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";
import WaitingView from "./WaitingView";

/** Which shelf each band place IS, for the app bar's word and its sentence.
 *  The ids are the SHARED table's, so a place cannot invent a name here. */
function shelfOf(destination: string): ShelfId {
  if (destination === "activity") return ACTIVITY;
  if (destination === "groups") return GROUPS;
  if (destination === "contrib") return WAITING;
  return null;
}

export default function TallyHome({
  navigation,
  route,
}: TallyScreenProps<"TallyHome">): React.JSX.Element {
  const vault = useTallyVault();
  const replica = useReplica();
  const { pending } = usePendingChanges(replica.session);
  const [ask, setAsk] = useState<TallyAsk | null>(null);
  const destination = route.params?.destination ?? "balances";

  // Activity has a payload of its own; the other three stand on the spine.
  useEffect(() => {
    if (destination === "activity" && vault.activity === null)
      void loadTallyActivity();
  }, [destination, vault.activity]);

  const pendingCount = tallyPendingCount(pending);
  const nets = useMemo(
    () => [
      ...vault.dashboard.friends.map((friend) => friend.net_minor),
      ...vault.dashboard.groups.map((group) => group.owner_net_minor),
    ],
    [vault.dashboard]
  );
  const rows = useMemo(() => {
    if (destination === "activity") return vault.activity?.activity.length ?? 0;
    if (destination === "groups") return vault.dashboard.groups.length;
    if (destination === "contrib") return pending.length;
    return vault.dashboard.friends.length + vault.dashboard.groups.length;
  }, [destination, pending.length, vault.activity, vault.dashboard]);

  const state = tallyScreenState({
    conflicted: tallyHasConflict(pending),
    denied: vault.denied !== null,
    loaded: vault.loaded,
    online: replica.online,
    parked: tallyHasParked(pending),
    pending: pendingCount,
    rows,
    stale: vault.stale,
    ...(destination === "balances" || destination === "groups" ? { nets } : {}),
  });

  const notice = {
    lastReadAt: vault.lastReadAt,
    pending: pendingCount,
    state,
  };

  const write = useCallback(
    (built: Parameters<typeof issueTallyWrite>[1], executed: string) =>
      void issueTallyWrite(replica.session, built, { executed }),
    [replica.session]
  );

  const names = useMemo(
    () =>
      new Map(
        vault.dashboard.friends.map((friend) => [friend.party_id, friend.name])
      ),
    [vault.dashboard.friends]
  );

  const onVerb = useCallback(
    (verb: ContribVerb, row: ContribRow): void => {
      const session = replica.session;
      // `approve` and `decline` cannot reach here: this seat's doors set
      // `decide: false`, so `contrib-model` never puts either on a row.
      if (verb === "approvals" || verb === "approve" || verb === "decline") {
        navigation.navigate("Settings", { screen: "Approvals" });
        return;
      }
      // The outbox's own doors are addressed by VAULT as well as by intent —
      // this phone holds several — so the row is looked back up in the source
      // it was folded from rather than the vault being guessed at.
      const change = pending.find((entry) => entry.id === row.intentId);
      if (!session || !change) return;
      if (verb === "cancel") {
        void session
          .cancelPendingChange(change.id, change.vaultId, change.kind)
          .then(() => postStatus(COMPOSE_OUTCOMES.cancelled));
        return;
      }
      if (verb === "retry") {
        void session
          .retryPendingWrite(change.id, change.vaultId)
          .then(() => postStatus(COMPOSE_OUTCOMES.retried));
        return;
      }
      void session
        .discardPendingWrite(change.id, change.vaultId)
        .then(() => postStatus(COMPOSE_OUTCOMES.discarded));
    },
    [navigation, pending, replica.session]
  );

  const askAddFriend = (): void =>
    setAsk({
      body: [FRIEND_BODY],
      confirm: FRIEND_COMMIT,
      field: { label: FIELD_KEYS.name, placeholder: PLACEHOLDERS.friend },
      onConfirm: (name) =>
        write(addFriendWrite(name), COMPOSE_OUTCOMES.friendAdded),
      title: FRIEND_HEAD,
    });

  const askNewGroup = (): void =>
    setAsk({
      body: [GROUP_BODY],
      chips: [
        {
          initial: String(GROUP_ICONS[0]?.[0] ?? "home"),
          key: "icon",
          label: FIELD_KEYS.icon,
          options: GROUP_ICONS,
        },
        {
          initial: String(GROUP_COLOURS[0]?.[0] ?? "indigo"),
          key: "color",
          label: FIELD_KEYS.colour,
          options: GROUP_COLOURS,
        },
      ],
      confirm: GROUP_COMMIT,
      field: { label: FIELD_KEYS.name, placeholder: PLACEHOLDERS.group },
      onConfirm: (name, picks) =>
        write(
          createGroupWrite({
            color: picks.color ?? "indigo",
            icon: picks.icon ?? "home",
            memberIds: [],
            name,
          }),
          COMPOSE_OUTCOMES.groupCreated
        ),
      title: GROUP_HEAD,
    });

  const askLeave = (groupId: string): void =>
    setAsk({
      body: [LEAVE_BODY, LEAVE_BODY_2],
      confirm: VERBS.leave,
      onConfirm: () => write(leaveGroupWrite(groupId), COMPOSE_OUTCOMES.left),
      title: LEAVE_TITLE,
    });

  const askArchive = (groupId: string, archived: boolean): void =>
    setAsk({
      body: archived ? [UNARCHIVE_BODY] : [ARCHIVE_BODY, ARCHIVE_BODY_2],
      confirm: archived ? VERBS.unarchive : VERBS.archive,
      onConfirm: () =>
        write(
          archiveGroupWrite(groupId, !archived),
          archived ? COMPOSE_OUTCOMES.unarchived : COMPOSE_OUTCOMES.archived
        ),
      title: archived ? UNARCHIVE_TITLE : ARCHIVE_TITLE,
    });

  const askRemind = (friend: {
    party_id: string;
    name: string;
    net_minor: number;
  }): void =>
    setAsk({
      body: [NUDGE_BODY],
      confirm: NUDGE_COMMIT,
      // A nudge ALWAYS parks, so the outcome the status line states is the
      // parked one — never "sent", in any tense.
      onConfirm: () =>
        write(
          nudgeWrite({
            asOfMinor: friend.net_minor,
            partyId: friend.party_id,
          }),
          COMPOSE_OUTCOMES.added
        ),
      title: nudgeTitle(friend.name),
    });

  const body = ((): React.JSX.Element => {
    if (destination === "activity") {
      return (
        <ActivityView
          data={
            vault.activity ?? {
              activity: [],
              currency: vault.dashboard.currency,
              me: vault.dashboard.me,
            }
          }
          loaded={vault.activity !== null}
          notice={notice}
          now={vault.now}
          onShowMore={showMoreTallyActivity}
          window={vault.window}
        />
      );
    }
    if (destination === "groups") {
      return (
        <GroupsView
          data={vault.dashboard}
          notice={notice}
          onArchive={(groupId, _name, archived) =>
            askArchive(groupId, archived)
          }
          onLeave={(groupId) => askLeave(groupId)}
          onNewGroup={askNewGroup}
          onOpenGroup={(groupId, name) =>
            navigation.navigate("TallyGroup", { groupId, name })
          }
        />
      );
    }
    if (destination === "contrib") {
      return (
        <WaitingView
          names={names}
          notice={notice}
          nudges={vault.dashboard.nudges ?? []}
          onVerb={onVerb}
          sections={tallyWaiting(
            pending.map((change) => ({
              id: change.id,
              label: change.label,
              status: change.status,
              ...(change.reason ? { reason: change.reason } : {}),
            })),
            vault.dashboard.me
          )}
        />
      );
    }
    return (
      <BalancesView
        data={vault.dashboard}
        notice={notice}
        onAddExpense={() => navigation.navigate("TallyAdd")}
        onAddFriend={askAddFriend}
        onNewGroup={askNewGroup}
        onOpenFriend={(partyId, name) =>
          navigation.navigate("TallyFriend", { name, partyId })
        }
        onOpenGroup={(groupId, name) =>
          navigation.navigate("TallyGroup", { groupId, name })
        }
        onRemind={askRemind}
        onSettle={() => navigation.navigate("TallySettle")}
        state={state}
      />
    );
  })();

  return (
    <TallyScreen
      current={destination}
      shelf={shelfOf(destination)}
      onBack={() => {
        // A place's back row is the way out of the app, not up the stack:
        // Balances IS the root, and the other three are its siblings.
        if (destination === "balances") navigation.popTo("Home");
        else navigation.popTo("TallyHome", { destination: "balances" });
      }}
    >
      {body}
      <TallyAskSheet ask={ask} onClose={() => setAsk(null)} />
    </TallyScreen>
  );
}
