// `Shared with them`, drawn from the GRANT PLANE — the phone's half (#825).
//
// The web `components/PersonGrants.tsx` is the reference, and everything that
// is not a React Native rendering difference is imported rather than restated:
// the read (`grant-dashboard.ts`), every sentence (`_shared/grant-copy.ts`),
// and the sheet itself (`kit/share/GrantSheet.tsx`). One fact, one wording,
// both seats.
//
// This is the person screen's grant dashboard: every live grant reaching this
// party, the channel that carries them, and the two acts the ruling gives
// People — `Share` and `Revoke`. An unreached channel reads as an opportunity
// rather than an error, and it names the act that opens it: linking the
// person's account here is what makes them shareable (#903).
//
// FOUR STATES, FOUR SENTENCES: a read in flight draws the skeleton; a phone
// with no gateway base says so; a refusal prints the route's own words; only a
// read that came back empty says nothing is shared.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";

import {
  reachLabel,
  reachNote,
  REVOKE_CANCEL_ACTION,
  REVOKE_CONFIRM_ACTION,
  revokeConfirmBody,
  revokeConfirmTitle,
  nothingSharedYet,
  audienceNotKnown,
} from "@centraid/blueprints/apps/_shared/grant-copy";
import type { GrantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import { GRANTS_UNAVAILABLE_HERE } from "@centraid/blueprints/apps/_shared/grant-gateway";
import type { GrantRecord } from "@centraid/blueprints/apps/_shared/grant-plane";
import {
  grantNoun,
  grantRowMeta,
  grantRowSub,
  grantSubjects,
  partyAudiences,
  readPartyGrants,
} from "@centraid/blueprints/apps/people/grant-dashboard";
import type { PartyGrantsState } from "@centraid/blueprints/apps/people/grant-dashboard";
import {
  SECTIONS,
  SENTENCES,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";

import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { nativeGrantDoor } from "../../kit/share/grant-seat";
import GrantSheet from "../../kit/share/GrantSheet";
import PeopleConfirm from "./PeopleConfirm";
import {
  Caption,
  EmptyLine,
  PeopleSection,
  PersonRow,
  Verb,
} from "./PeopleKit";

export interface PersonGrantsProps {
  partyId: string;
  personName: string;
  roster: readonly { party_id: string; name: string }[];
  open: boolean;
  onToggle: () => void;
  door?: GrantDoor;
}

export default function PersonGrants(
  props: PersonGrantsProps
): React.JSX.Element {
  const replica = useReplica();
  const gatewayBase = replica.gatewayBase ?? "";
  const door = useMemo(
    () => props.door ?? nativeGrantDoor(gatewayBase),
    [props.door, gatewayBase]
  );
  const available = Boolean(props.door) || gatewayBase.length > 0;

  const [state, setState] = useState<PartyGrantsState>({ kind: "loading" });
  const [sheetVisible, setSheetVisible] = useState(false);
  const [confirming, setConfirming] = useState<GrantRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const partyId = props.partyId;
  const asked = useRef(partyId);
  const read = useCallback(
    async (showPending: boolean): Promise<void> => {
      asked.current = partyId;
      if (showPending) setState({ kind: "loading" });
      if (!available) {
        setState({ kind: "unavailable", message: GRANTS_UNAVAILABLE_HERE });
        return;
      }
      const answer = await readPartyGrants(door, partyId);
      if (asked.current === partyId) setState(answer);
    },
    [available, door, partyId]
  );

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (active) await read(true);
    });
    return () => {
      active = false;
    };
  }, [read]);

  const grants = state.kind === "read" ? state.grants : [];
  const subjects = grantSubjects(grants);
  const audiences = partyAudiences([
    { party_id: props.partyId, name: props.personName },
    ...props.roster.filter((person) => person.party_id !== props.partyId),
  ]);

  const revoke = async (grant: GrantRecord): Promise<void> => {
    setBusy(true);
    const outcome = await door.revoke(grant.grantId);
    setBusy(false);
    setConfirming(null);
    postStatus(outcome.message);
    await read(false);
  };

  const rows = (): React.ReactNode => {
    if (state.kind === "loading")
      return <SkeletonRows accessibilityLabel={SECTIONS.shared} rows={2} />;
    if (state.kind === "unknown-party")
      return <EmptyLine text={audienceNotKnown(props.personName)} />;
    if (state.kind !== "read") return <EmptyLine text={state.message} />;
    const note = reachNote(state.reach);
    return (
      <View>
        {/* The channel, in the kit's words. `Not reached yet · Link their
            account in People to share with them.` is an opportunity, not an
            error — and this screen is where that act lives. */}
        <Caption
          text={
            note
              ? `${reachLabel(state.reach)} · ${note}`
              : reachLabel(state.reach)
          }
        />
        {grants.length === 0 ? (
          <EmptyLine text={nothingSharedYet(props.personName)} />
        ) : (
          grants.map((grant, index) => (
            <PersonRow
              key={grant.grantId}
              name={grantNoun(grant)}
              sub={grantRowSub(grant)}
              subNumeric
              meta={grantRowMeta(grant)}
              trailing={
                <Verb
                  label={REVOKE_CONFIRM_ACTION}
                  disabled={busy}
                  accessibilityLabel={`${REVOKE_CONFIRM_ACTION} ${grantNoun(grant)}`}
                  onPress={() => setConfirming(grant)}
                />
              }
              last={index === grants.length - 1}
            />
          ))
        )}
        {subjects.length === 0 ? (
          <Caption text={SENTENCES.shareStartsWhereItLives} />
        ) : null}
      </View>
    );
  };

  return (
    <View>
      <PeopleSection
        title={SECTIONS.shared}
        {...(state.kind === "read" ? { count: grants.length } : {})}
        collapsible
        open={props.open}
        onToggle={props.onToggle}
        {...(subjects.length
          ? {
              add: (
                <Verb
                  label={VERBS.share}
                  onPress={() => setSheetVisible(true)}
                />
              ),
            }
          : {})}
      >
        {rows()}
      </PeopleSection>

      {/* THE THIRD MODAL CONFIRM, in the kit's own words: a removal crossing
          to a vault this device does not own is ASKED FOR, and the confirm
          says so before the decision rather than after it. */}
      <PeopleConfirm
        visible={confirming !== null}
        title={confirming ? revokeConfirmTitle(props.personName) : ""}
        body={
          confirming
            ? revokeConfirmBody(props.personName, grantNoun(confirming))
            : ""
        }
        verb={REVOKE_CONFIRM_ACTION}
        cancelLabel={REVOKE_CANCEL_ACTION}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void revoke(confirming);
        }}
      />

      <GrantSheet
        visible={sheetVisible}
        onClose={() => {
          setSheetVisible(false);
          void read(false);
        }}
        audiences={audiences}
        subjects={subjects}
        audienceId={props.partyId}
        onStatus={postStatus}
        door={door}
      />
    </View>
  );
}
