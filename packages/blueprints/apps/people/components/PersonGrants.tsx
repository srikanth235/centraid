// `Shared with them`, drawn from the GRANT PLANE (issue #825, wave 7).
//
// This is the person screen's grant dashboard: every live grant reaching this
// party, the channel that carries them, and the two acts the ruling gives
// People — `Share` and `Revoke`. Both were registered withholdings while a
// share could only be made of a container People does not own; the grant plane
// removed that cause, so the controls are here and they are live.
//
// THE ONE COMPONENT IN THIS APP THAT READS FOR ITSELF, and deliberately: the
// grant plane is not one of People's vault queries — it is the gateway's own
// door, reached through the shared `GrantDoor` the kit is built on
// (`_shared/grant-door.ts`), exactly as the shared `GrantSheet` reaches it.
// Routing it through `logic.ts` would put a second transport in a module whose
// whole contract is `window.centraid.read`.
//
// FOUR STATES, FOUR SENTENCES. A read in flight draws the skeleton; a host with
// no grant bridge says so; a refusal prints whoever refused it, in their words;
// and only a read that came back empty says nothing is shared. `awaiting_channel`
// reads as `Invitation pending` — a share to someone this vault has never
// reached is waiting, not failing, so it never takes the consequence tone.
//
// SHARING IS ONE GESTURE. There is no link step in front of it: the sheet's
// `Share` mints the grant, and the grant mints the invitation as its own first
// fulfillment step (#825 ruling 5). This screen's only job afterwards is to
// show what the plane answered.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  reachLabel,
  reachNote,
  REVOKE_CANCEL_ACTION,
  REVOKE_CONFIRM_ACTION,
  revokeConfirmBody,
  revokeConfirmTitle,
  nothingSharedYet,
} from "../../_shared/grant-copy.ts";
import type { GrantDoor } from "../../_shared/grant-door.ts";
import {
  GRANTS_UNAVAILABLE_HERE,
  grantPlaneAvailable,
  webGrantDoor,
} from "../../_shared/grant-gateway.ts";
import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import type { GrantRecord } from "../../_shared/grant-plane.ts";
import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import {
  grantNoun,
  grantRowMeta,
  grantRowSub,
  grantSubjects,
  partyAudiences,
  readPartyGrants,
} from "../grant-dashboard.ts";
import type { PartyGrantsState } from "../grant-dashboard.ts";
import { SECTIONS, SENTENCES, VERBS } from "../people-copy.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Caption, ConfirmPanel, Row, Section, Verb } from "./Shared.tsx";

export interface PersonGrantsProps {
  partyId: string;
  personName: string;
  /** The roster window, for the sheet's audience list — People's own duty. */
  roster: readonly { party_id: string; name: string }[];
  /** Whether the section is open. The person screen owns the collapse. */
  open: boolean;
  onToggle: () => void;
  /** The frame's one status line. Every outcome is reported there. */
  onStatus: (message: string) => void;
  /** The grant plane. Defaults to this seat's bridge door. */
  door?: GrantDoor;
  /** Whether this host can reach the plane at all. Defaults to the bridge's
   *  own feature detection — supplied only by tests and the e2e harness. */
  available?: boolean;
}

export function PersonGrants(props: PersonGrantsProps): ReactNode {
  const door = useMemo(() => props.door ?? webGrantDoor(), [props.door]);
  const available = props.available ?? grantPlaneAvailable();
  const [state, setState] = useState<PartyGrantsState>({ kind: "loading" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirming, setConfirming] = useState<GrantRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const partyId = props.partyId;
  // The answer is keyed to the person it was asked about, so a read that lands
  // after the member has moved on is dropped rather than drawn under the wrong
  // name.
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
    void read(true);
  }, [read]);

  const grants = state.kind === "read" ? state.grants : [];
  const subjects = grantSubjects(grants);
  // The person this screen is about leads the sheet's list, and the roster
  // follows: the sheet is opened ON them, and the audience picker is how the
  // same subject reaches somebody else.
  const audiences = partyAudiences([
    { party_id: props.partyId, name: props.personName },
    ...props.roster.filter((person) => person.party_id !== props.partyId),
  ]);

  const revoke = async (grant: GrantRecord): Promise<void> => {
    setBusy(true);
    const outcome = await door.revoke(grant.grantId);
    setBusy(false);
    setConfirming(null);
    // The route DERIVES that sentence from what each delivered copy actually
    // did. It is printed verbatim — softening it here would flatten three
    // honest answers into one optimistic one.
    props.onStatus(outcome.message);
    await read(false);
  };

  const body = (): ReactNode => {
    if (state.kind === "loading") return <LoadingSkeleton rows={2} />;
    if (state.kind !== "read")
      return <EmptyState title={state.message} />;
    return (
      <>
        {/* The channel, in the kit's words. `Not reached yet · Sharing sends
            an invitation first.` is an opportunity, not an error — it is the
            sentence that tells a member no link ceremony stands in the way. */}
        <Caption
          text={
            reachNote(state.reach)
              ? `${reachLabel(state.reach)} · ${reachNote(state.reach)}`
              : reachLabel(state.reach)
          }
        />
        {grants.length === 0 ? (
          <EmptyState title={nothingSharedYet(props.personName)} />
        ) : (
          grants.map((grant) => (
            <Row
              key={grant.grantId}
              name={grantNoun(grant)}
              strong
              sub={grantRowSub(grant)}
              subNumeric
              meta={grantRowMeta(grant)}
              trailing={
                <Verb
                  label={REVOKE_CONFIRM_ACTION}
                  disabled={busy}
                  ariaLabel={`${REVOKE_CONFIRM_ACTION} ${grantNoun(grant)}`}
                  onClick={() => setConfirming(grant)}
                />
              }
            />
          ))
        )}
        {subjects.length === 0 ? (
          <Caption text={SENTENCES.shareStartsWhereItLives} />
        ) : null}
      </>
    );
  };

  return (
    <>
      <Section
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
                  onClick={() => setSheetOpen(true)}
                />
              ),
            }
          : {})}
      >
        {body()}
      </Section>

      {/* THE HANDOFF'S THIRD MODAL CONFIRM, now that there is something to
          revoke. Every word of it is the kit's: a removal crossing to a vault
          this device does not own is REQUESTED, and the confirm says so
          before the decision rather than after it. */}
      {confirming ? (
        <ConfirmPanel
          title={revokeConfirmTitle(props.personName)}
          body={revokeConfirmBody(props.personName, grantNoun(confirming))}
          verb={REVOKE_CONFIRM_ACTION}
          cancelLabel={REVOKE_CANCEL_ACTION}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void revoke(confirming)}
        />
      ) : null}

      <GrantSheet
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          void read(false);
        }}
        audiences={audiences}
        subjects={subjects}
        audienceId={props.partyId}
        onStatus={props.onStatus}
        door={door}
      />
    </>
  );
}
