// "Storage" — what the drive weighs, and where the bytes are (Docs spec §4.5).
//
// COUNTED, NOT ESTIMATED, AND SAID SO. The spec's screen leads with six custody
// figures: the total, what is on this device only, what is on both, what is on
// the gateway only, what is provably backed up, and what could be released. Of
// those, this seat can count exactly ONE honestly — the total across the rows
// it has read — and even that carries a caveat when the fetched window is
// truncated, because summing a window and calling it a library is how a member
// ends up trusting a number that is smaller than their drive.
//
// The custody split (`custody_state` per content item) is a per-row fact the
// drive already reads, so the on-this-device count is real and is drawn. The
// backup figure, the gateway-only figure and "what could be released" need the
// blob custody rollup, which this projection does not read; they are named as
// not counted rather than shown as zero.
//
// "Before the sweep has run the answer is 'not counted yet', never a zero."
// (spec §4.5, verbatim.) That rule is why every unread figure below is a
// sentence and not a number.
import type { ReactNode } from "react";

import { fmtBytes } from "../format.ts";
import type { DriveDoc } from "../types.ts";
import { Note, Panel, Rows, Screen, Section } from "./Blocks.tsx";
import type { Row } from "./Blocks.tsx";

/** The custody state a row carries when its bytes are on this device and
 *  nowhere else — the one custody fact a member can LOSE something to. */
const DEVICE_ONLY = "device_only";

export function StorageRoute({
  docs,
  truncated,
}: {
  /** Every row this drive has read — trashed ones included, because they are
   *  still occupying the disk until their purge date. */
  docs: readonly DriveDoc[];
  /** The read stopped at its window, so these totals are of what was fetched
   *  and not of the library. */
  truncated: boolean;
}): ReactNode {
  const bytes = docs.reduce((sum, d) => sum + (d.byte_size ?? 0), 0);
  const deviceOnly = docs.filter((d) => d.custody_state === DEVICE_ONLY);
  const deviceOnlyBytes = deviceOnly.reduce(
    (sum, d) => sum + (d.byte_size ?? 0),
    0
  );

  const rows: Row[] = [
    {
      id: "release",
      label: "Free up space on this device",
      sub: "would release local copies of documents that exist in two other places, fetching each one again when you open it",
      meta: "not offered",
      action: {
        label: "Free up",
        disabledReason:
          "Nothing can be released until the copies elsewhere have been counted",
      },
    },
    {
      id: "never",
      label: "What is never offered",
      sub: "releasing a document whose only other copy is a preview. That is losing it, not freeing space",
      meta: "rule",
      net: true,
    },
    {
      id: "uncounted",
      label: "Not counted yet",
      sub: "the honest answer between a new vault and its first sweep — and the answer here for every figure below the total",
      meta: "state",
    },
  ];

  return (
    <Screen label="Storage">
      <Panel
        eyebrow={truncated ? "Counted over what has been read" : "Counted"}
        title={`${fmtBytes(bytes)} in documents`}
        body={
          truncated
            ? "This drive stopped reading at its window, so the figure below is what has been fetched — not what the library holds. Search reaches the rest."
            : "Counted across every document this drive has read, trashed ones included: they occupy the disk until their purge date."
        }
        facts={[
          {
            k: "total",
            v: `${fmtBytes(bytes)} · ${docs.length} document${docs.length === 1 ? "" : "s"}`,
          },
          {
            k: "on this device only",
            v:
              deviceOnly.length === 0
                ? "none — every document here is also somewhere else"
                : `${fmtBytes(deviceOnlyBytes)} · ${deviceOnly.length} document${deviceOnly.length === 1 ? "" : "s"}`,
            net: deviceOnly.length > 0,
          },
          { k: "on the gateway", v: "not counted yet" },
          { k: "provably backed up", v: "not counted yet" },
          { k: "could be released from here", v: "not counted yet" },
        ]}
      />

      <Rows ariaLabel="Storage actions" rows={rows} />

      {/* OUT OF ROOM is the state this screen exists for, so it is described
          even while it is not happening — a member who meets it for the first
          time should already know what the product will and will not do. */}
      <Section
        label="If this device runs out of room"
        meta="what will and will not happen"
      />
      <Panel
        net
        eyebrow="The rule"
        title="Nothing real is discarded to make space"
        body="When there is no room, incoming documents stop being written and the queue holds. The queue is intact — nothing in it is dropped, and nothing already in the vault is deleted to fit something new."
        facts={[
          {
            k: "what stops",
            v: "bringing new documents in, until there is room",
          },
          {
            k: "what is never discarded",
            v: "real content, or a pending write",
            net: true,
          },
          {
            k: "what you do",
            v: "free space on the device, then the queue drains",
          },
        ]}
      />

      <Note>
        These figures come from the rows this drive has read, not from a
        periodic sweep of the disk. Where the sweep is the only thing that could
        answer — what the gateway holds, what is provably backed up, what could
        safely be released — the answer here is “not counted yet” rather than a
        zero that would read as “nothing”.
      </Note>
    </Screen>
  );
}
