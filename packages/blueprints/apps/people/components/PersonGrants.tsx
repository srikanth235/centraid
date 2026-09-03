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
  audienceNotKnown,
} from "../../_shared/grant-copy.ts";
import type { GrantDoor } from "../../_shared/grant-door.ts";
import {
  GRANTS_UNAVAILABLE_HERE,
  grantPlaneAvailable,
  webGrantDoor,
} from "../../_shared/grant-gateway.ts";
import type { GrantRecord } from "../../_shared/grant-plane.ts";
import { GrantSheet } from "../../_shared/GrantSheet.tsx";
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
  roster: readonly { party_id: string; name: string }[];
  open: boolean;
  onToggle: () => void;
  onStatus: (message: string) => void;
  door?: GrantDoor;
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
    props.onStatus(outcome.message);
    await read(false);
  };

  const body = (): ReactNode => {
    if (state.kind === "loading") return <LoadingSkeleton rows={2} />;
    if (state.kind === "unknown-party")
      return <EmptyState title={audienceNotKnown(props.personName)} />;
    if (state.kind !== "read") return <EmptyState title={state.message} />;
    return (
      <>
        {/* Reach copy is an opportunity, not an error — no link ceremony. */}
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
                <Verb label={VERBS.share} onClick={() => setSheetOpen(true)} />
              ),
            }
          : {})}
      >
        {body()}
      </Section>

      {/* Confirm says REQUESTED — the far vault is not this device's. */}
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
