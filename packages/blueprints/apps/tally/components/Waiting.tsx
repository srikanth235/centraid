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
// ACCEPT AND DECLINE ARE NOT DRAWN AS BUTTONS, because the app client has no
// per-intent approval door: a steward answers in the shell's own Approvals
// inbox (`window.centraid.openApprovals`). So a steward-only act says why it
// stopped here and hands over — and where the host provides no inbox at all,
// it says that instead of drawing a control that cannot fire. The verbs that
// ARE real are the outbox's own (`contrib-model.ts`), and each one is drawn
// only where its door exists.
import type { ReactNode } from "react";

import {
  CONTRIB_APPROVALS_NOTE,
  CONTRIB_EMPTY,
  CONTRIB_META,
  CONTRIB_NO_DOOR,
  CONTRIB_SECTIONS,
  CONTRIB_VERBS,
} from "../compose-copy.ts";
import type {
  ContribRow,
  ContribSections,
  ContribVerb,
} from "../contrib-model.ts";
import { metaSentence } from "../format.ts";
import { Note, Rows, Section } from "./Blocks.tsx";
import { LedgerRow } from "./LedgerRow.tsx";
import type { RowAct } from "./LedgerRow.tsx";

export interface WaitingScreenProps {
  sections: ContribSections;
  /** Does this host hold an approval inbox at all? */
  hasApprovals: boolean;
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
        {sections.waiting.length > 0 ? (
          <Note>
            {props.hasApprovals ? CONTRIB_APPROVALS_NOTE : CONTRIB_NO_DOOR}
          </Note>
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
    </div>
  );
}
