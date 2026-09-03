import type { ReactNode } from "react";

import { fmtBytes } from "../format.ts";
import type { DriveDoc } from "../types.ts";
import { Note, Panel, Rows, Screen, Section } from "./Blocks.tsx";
import type { Row } from "./Blocks.tsx";

const DEVICE_ONLY = "device_only";

export function StorageRoute({
  docs,
  truncated,
}: {
  docs: readonly DriveDoc[];
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
            ? "This drive stopped at its window, so the figure below is what has been fetched — not what the library holds."
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

      {/* OUT OF ROOM is described even while not happening — first contact
          knows the promises. */}
      <Section
        label="If this device runs out of room"
        meta="what will and will not happen"
      />
      <Panel
        net
        eyebrow="The rule"
        title="Nothing real is discarded to make space"
        body="When there is no room, incoming documents stop being written and the queue holds — nothing already stored is deleted."
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
