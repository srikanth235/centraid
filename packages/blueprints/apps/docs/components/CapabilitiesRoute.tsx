// "What Docs may read" — the four capabilities, four separate consents
// (Docs spec §10.8).
//
// THE SCREEN EXISTS BEFORE THE SWITCHES DO, and that is the point. Other
// surfaces already say "this is switched off" — proposed filing, who a
// document names, and search's "what could not be looked inside" — and every
// one of them was pointing at a destination that did not exist. A member told
// three times that something is off, with nowhere to go and learn what it
// would do, has been told nothing.
//
// What this screen can do today is state the offer in full: what each
// capability would read, where it would run, what would leave the device, what
// it would write beside the document, and how to undo it. What it cannot do is
// turn one on — `capabilityOn` answers `off` because there is no consent record
// to read, and there is no runner behind it. So each row carries its verb
// present and unpressable with the reason, rather than absent: a control that
// vanishes teaches nothing about why it is unavailable, and a control that
// fires into nothing is worse than both.
import type { ReactNode } from "react";

import {
  CAPABILITIES_BODY,
  CAPABILITIES_TITLE,
  DCAPS,
  capabilityOn,
} from "../capabilities.ts";
import { Note, Panel, Rows, Screen, Section } from "./Blocks.tsx";
import type { Row } from "./Blocks.tsx";

/** Why no capability can be switched on from here yet. Said on every row,
 *  because a member reads the row they care about, not the page. */
const NO_RUNNER =
  "Nothing runs this yet — the consent would have nothing behind it";

export function CapabilitiesRoute(): ReactNode {
  const rows: Row[] = DCAPS.map((cap) => ({
    id: cap.id,
    label: cap.name,
    sub: cap.what,
    meta: capabilityOn(cap.id) ? "on" : "off",
    action: { label: "Turn on", disabledReason: NO_RUNNER },
  }));

  return (
    <Screen label="What Docs may read">
      <Panel
        eyebrow="Consent"
        title={CAPABILITIES_TITLE}
        body={CAPABILITIES_BODY}
      />
      <Rows ariaLabel="Capabilities" rows={rows} />

      {/* THE CONSENT MOMENT, drawn in full for the one capability the rest are
          shaped like. It is not a live dialog — it is what the member would be
          asked, shown before they are asked, which is the only way to read a
          consent without being under time pressure to answer it. */}
      <Section
        label="The consent moment"
        meta="asked once, answered once, receipted"
      />
      <Panel
        eyebrow="Consent · reading the contents"
        title="Read the contents of your scanned documents?"
        body="Reading turns a scan into words so search can look inside it, writing a contents column and filing nothing."
        facts={[
          { k: "where it would run", v: "on this device" },
          { k: "what leaves the device", v: "nothing" },
          { k: "what it writes", v: "a contents column, beside each document" },
          {
            k: "undo",
            v: "delete the contents column; the documents are untouched",
          },
          {
            k: "afterwards",
            v: "visible in Privacy with its receipt, and revocable there",
          },
        ]}
        actions={[
          {
            label: "Read on this device",
            filled: true,
            disabledReason: NO_RUNNER,
          },
        ]}
      />

      {/* The second option is drawn because REFUSING it is a decision, and a
          member cannot refuse an option they were never shown. */}
      <Panel
        net
        eyebrow="The other option"
        title="Read on a cloud helper"
        body="Faster, and the documents leave this device under a separate consent — the copy that leaves is the whole document."
        facts={[
          { k: "where it would run", v: "a cloud helper you have named" },
          {
            k: "what leaves the device",
            v: "a full copy of every document read",
            net: true,
          },
          { k: "receipt", v: "one per batch, in the grants ledger" },
        ]}
        actions={[
          {
            label: "Choose a cloud helper",
            net: true,
            disabledReason:
              "No cloud helper is named, and nothing runs this yet",
          },
        ]}
      />

      <Note>
        A capability being off is one fact, stated once wherever the member
        stands. This screen is where it is stated in full — and none of the four
        changes a document: each writes something beside it, and that is yours
        to delete.
      </Note>
    </Screen>
  );
}
