// Where a document ends and a credential begins (Docs spec §14's `locker`),
// and the two capability-gated shelves that hang off the same rule — the filing
// Docs would propose, and the people a document names.
//
// THREE SCREENS IN ONE FILE because they are three answers to one question:
// what does Docs hold, and what does it deliberately not hold. The Locker
// boundary is the rule; proposed filing and named people are the two places a
// machine would write something BESIDE a document, which is the same boundary
// drawn one step in.
//
// None of the three can show live content: two are gated on capabilities that
// are off, and the Locker boundary is a statement about what Docs will never
// do, which has no live state by definition. What they can do is be exact
// about the line, which is the whole value — a member who does not know where
// the line is will put a passport number in a document title.
import type { ReactNode } from "react";

import { DCAPS } from "../capabilities.ts";
import { Note, Panel, Rows, Screen, Section } from "./Blocks.tsx";
import type { Row } from "./Blocks.tsx";

const FILING_CAP = DCAPS.find((cap) => cap.id === "filing");
const NAMES_CAP = DCAPS.find((cap) => cap.id === "names");

/** §14 — the boundary itself. */
export function LockerBoundaryRoute(): ReactNode {
  const rows: Row[] = [
    {
      id: "cross",
      label: "Adding a number to Locker from a scan",
      sub: "you type it; nothing reads it out of the image. Two records, one receipt, and neither app holds both halves",
      meta: "how you cross it",
    },
    {
      id: "shared",
      label: "Attachments over the same content",
      sub: "Notes and Locker hold files through the same content items — one copy of the bytes, three apps pointing at it",
      meta: "shared",
    },
  ];
  return (
    <Screen label="Docs and Locker">
      <Panel
        eyebrow="The boundary"
        title="The scan is a document; the number is a credential"
        body="The photographed page is a document — bytes, versions, a folder — and the number is a short secret in Locker."
        facts={[
          {
            k: "in docs",
            v: "the scan · its bytes, its versions, its folder, its purge date",
          },
          { k: "in locker", v: "the number · locked, with an expiry" },
          {
            k: "what docs will never do",
            v: "hold a credential, or read one out of a scan",
            net: true,
          },
          {
            k: "what locker will never do",
            v: "hold bytes it cannot lock, or preview a shelf",
            net: true,
          },
        ]}
      />
      <Section
        label="Crossing it"
        meta="one command, two records, one receipt"
      />
      <Rows ariaLabel="Crossing the boundary" rows={rows} />
      <Note>
        The rule is worth stating plainly because the failure is silent: a
        passport number typed into a document title is a secret sitting in a
        searchable field, and nothing would refuse it.
      </Note>
    </Screen>
  );
}

/** §10.7's `filing` capability, as a shelf. */
export function FilingRoute(): ReactNode {
  return (
    <Screen label="Proposed filing">
      <Panel
        net
        eyebrow="Switched off"
        title="Nothing has been proposed"
        body={`${FILING_CAP?.what} It is switched off, so nothing has been read and nothing is waiting for you.`}
        facts={[
          { k: "where it would run", v: FILING_CAP?.where ?? "on this device" },
          {
            k: "what leaves the device",
            v: FILING_CAP?.leaves ?? "nothing",
          },
          {
            k: "what it would write",
            v: FILING_CAP?.writes ?? "a proposal you accept, edit or reject",
          },
          {
            k: "what it will never do",
            v: "re-file a document you have already filed",
            net: true,
          },
        ]}
      />
      <Note>
        The shape is Photos' face review: one proposal, the evidence beside it,
        nothing written until you say so — and a rejection is remembered, so the
        same proposal is not made twice.
      </Note>
    </Screen>
  );
}

/** §10.7's `names` capability, as a shelf. */
export function NamesRoute(): ReactNode {
  return (
    <Screen label="Who your documents name">
      <Panel
        net
        eyebrow="Switched off"
        title="Docs has not looked at who your documents name"
        body={`${NAMES_CAP?.what} It is switched off, so no document here points at a person.`}
        facts={[
          { k: "where it would run", v: NAMES_CAP?.where ?? "on this device" },
          { k: "what leaves the device", v: NAMES_CAP?.leaves ?? "nothing" },
          {
            k: "what it would write",
            v:
              NAMES_CAP?.writes ??
              "a link to a People record, with the passage",
          },
          {
            k: "what the other end is",
            v: "a People record — the link is the first cross-app one Docs makes",
          },
        ]}
      />
      <Note>
        Every link would carry the exact passage it was read from, so the
        evidence travels with the claim: a document said to name someone can be
        checked against the sentence that said so.
      </Note>
    </Screen>
  );
}
