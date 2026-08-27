// WAITING — the multi-writer surface (Tally spec §1, FLOWS.md).
//
// NOT A QUEUE WIDGET, and not a badge with a number on it. Every row is an
// intent from somebody's own vault, and it says whose it is, where it is, and
// what it is waiting on. That is why this surface holds a band slot at all:
// it is the only place in Tally where a write can be somebody else's and
// stuck, and there is nowhere else to look for it.
//
// EMPTY IS THE HEALTHY STATE. Three empty sections are the ordinary Tuesday,
// so each one says so in its own words rather than the screen collapsing into
// a single generic nothing.
//
// APPROVE AND DECLINE ARE THE STEWARD'S ANSWER, given here, through
// `decideCommonsIntent`. Every verb on every row is drawn only where its own
// door exists: a host without the decide door draws neither button and offers
// no substitute for them, because a control that cannot fire teaches a member
// something false and a fallback that faked it would be worse (protocol C1).
//
// REMINDERS PREPARED IS A FOURTH SECTION, and it is not an intent list. A
// nudge always parks — Tally has no delivery path — so what the dashboard
// returns is a record of intentions, and the section says "prepared" in every
// row and "sent" in none of them.
import type { ReactNode } from "react";

import {
  CONTRIB_EMPTY,
  CONTRIB_META,
  CONTRIB_NO_DOOR,
  CONTRIB_SECTIONS,
  CONTRIB_VERBS,
  NUDGE_EMPTY,
  NUDGE_META,
  NUDGE_SECTION,
  nudgePrepared,
} from "../compose-copy.ts";
import type {
  ContribRow,
  ContribSections,
  ContribVerb,
} from "../contrib-model.ts";
import { metaSentence } from "../format.ts";
import type { Nudge, Person } from "../types.ts";
import { NUDGE_PARKED } from "../view-copy.ts";
import { Note, Rows, Section } from "./Blocks.tsx";
import { LedgerRow } from "./LedgerRow.tsx";
import type { RowAct } from "./LedgerRow.tsx";

export interface WaitingScreenProps {
  sections: ContribSections;
  /** Does this host hold an approval inbox at all? */
  hasApprovals: boolean;
  /** Does it hold the per-intent Approve/Decline door? */
  canDecide: boolean;
  /** Reminders the owner prepared. Nothing here was ever sent. */
  nudges: readonly Nudge[];
  /** Who each reminder is about, by party id. */
  people: readonly Person[];
  narrow: boolean;
  onVerb: (verb: ContribVerb, row: ContribRow) => void;
}

function acts(props: WaitingScreenProps, row: ContribRow): RowAct[] {
  return row.verbs.map((verb) => ({
    label: CONTRIB_VERBS[verb],
    run: () => props.onVerb(verb, row),
  }));
}

function rowsOf(props: WaitingScreenProps, rows: readonly ContribRow[]) {
  return rows.map((row) => (
    <LedgerRow
      key={row.intentId}
      title={row.title}
      meta={metaSentence([row.who, row.reason])}
      status={{ label: row.status, tone: row.tone }}
      acts={acts(props, row)}
      narrow={props.narrow}
      {...(row.pending
        ? { pendingRow: { pending: true } as Record<string, unknown> }
        : {})}
    />
  ));
}

export function WaitingScreen(props: WaitingScreenProps): ReactNode {
  const { sections } = props;
  return (
    <div>
      <Section
        label={CONTRIB_SECTIONS.waiting}
        meta={CONTRIB_META.waiting}
        count={sections.waiting.length}
        empty={CONTRIB_EMPTY.waiting}
        narrow={props.narrow}
      >
        <Rows>{rowsOf(props, sections.waiting)}</Rows>
        {/* Only where there is genuinely nowhere to answer. With the decide
            door present the row's own buttons ARE the answer, and a note
            pointing elsewhere would be a second one. */}
        {sections.waiting.length > 0 &&
        !props.canDecide &&
        !props.hasApprovals ? (
          <Note>{CONTRIB_NO_DOOR}</Note>
        ) : null}
      </Section>

      <Section
        label={CONTRIB_SECTIONS.inFlight}
        meta={CONTRIB_META.inFlight}
        count={sections.inFlight.length}
        empty={CONTRIB_EMPTY.inFlight}
        narrow={props.narrow}
      >
        <Rows>{rowsOf(props, sections.inFlight)}</Rows>
      </Section>

      <Section
        label={CONTRIB_SECTIONS.ended}
        meta={CONTRIB_META.ended}
        count={sections.ended.length}
        empty={CONTRIB_EMPTY.ended}
        narrow={props.narrow}
      >
        <Rows>{rowsOf(props, sections.ended)}</Rows>
      </Section>

      <Section
        label={NUDGE_SECTION}
        meta={NUDGE_META}
        count={props.nudges.length}
        empty={NUDGE_EMPTY}
        narrow={props.narrow}
      >
        <Rows>
          {props.nudges.map((nudge) => (
            <LedgerRow
              key={nudge.nudge_id}
              title={nudgePrepared(
                props.people.find(
                  (person) => person.party_id === nudge.party_id
                )?.name ?? nudge.party_id,
                nudge.prepared_at.slice(0, 10)
              )}
              meta={metaSentence([nudge.note ?? "", NUDGE_PARKED])}
              narrow={props.narrow}
            />
          ))}
        </Rows>
      </Section>
    </div>
  );
}
