/**
 * HOW ONE PERSON CAN BE REACHED, AND WHO ELSE HOLDS THE SAME VALUE.
 *
 * Split out of `./person.ts` (#996 wave 4) when its reads became statements
 * and the file passed the repo's size limit. The seam is a real one rather
 * than a byte count: everything here answers ONE question the person sheet
 * asks — "these are the addresses, and this number is also on someone else's
 * card" — and the sheet's other twenty reads answer different ones.
 *
 * The collision search is the part worth stating. It used to ride a read of
 * `social_contact_channel` with NO predicate and a window of 2,000, filtered in
 * memory, which served this person's channels and everybody else's from one
 * read: past that window both answers were wrong, and neither said so. A
 * collision is only possible on a value THIS person holds, so that set is what
 * bounds the search.
 *
 * NOT a query: the dispatcher resolves `queries/<name>.ts` and never scans the
 * directory, so a helper beside the handlers is invisible to it.
 */

import { inList, readPages } from "../../_shared/paged-reads.ts";

/** The channel columns every read here projects. */
const CHANNEL_COLUMNS =
  "channel_id, party_id, kind, label, value, normalized_value, " +
  "is_preferred, provenance_json";

export interface RawContactChannel {
  channel_id: string;
  party_id: string;
  kind: "phone" | "email" | "address" | "handle";
  label?: string | null;
  value: string;
  normalized_value: string;
  is_preferred: number;
  provenance_json?: string | null;
}

/** One row of the sheet's contact rail. */
export interface ContactEntry {
  channel_id?: string;
  kind: "phone" | "email" | "address" | "handle";
  label?: string | null;
  value: string;
  normalized_value?: string;
  preferred?: boolean;
  provenance?: Record<string, unknown> | null;
  duplicate_party_ids?: string[];
  duplicate_names?: string[];
}

/** This person's channels. Returned UNAWAITED so the caller keeps it inside
 *  the `Promise.all` its destructuring already expects. */
export function readChannels(
  ctx: HandlerCtx,
  partyId: string
): Promise<RawContactChannel[]> {
  return readPages<RawContactChannel>(ctx, {
    name: "people.person.channels",
    select: CHANNEL_COLUMNS,
    from: "social_contact_channel",
    where: "party_id = ?",
    bind: [partyId],
    order: {
      sortColumn: "channel_id",
      pkColumn: "channel_id",
      descending: false,
    },
  });
}

/** Which OTHER people hold each of this person's channel values. */
export async function readChannelCollisions(
  ctx: HandlerCtx,
  partyId: string,
  channels: readonly RawContactChannel[]
): Promise<{
  duplicatesOf: (channel: RawContactChannel) => string[];
  duplicatePartyIds: string[];
}> {
  const normalizedValues = [
    ...new Set(channels.map((channel) => channel.normalized_value)),
  ];
  const valueIn =
    normalizedValues.length === 0
      ? null
      : inList("normalized_value", normalizedValues);
  const others = valueIn
    ? await readPages<RawContactChannel>(ctx, {
        name: "people.person.duplicateChannels",
        select: CHANNEL_COLUMNS,
        from: "social_contact_channel",
        where: `${valueIn.sql} AND party_id <> ?`,
        bind: [...valueIn.bind, partyId],
        order: {
          sortColumn: "channel_id",
          pkColumn: "channel_id",
          descending: false,
        },
      })
    : [];
  // A duplicate is the same VALUE reached the same WAY: a phone number and a
  // handle that happen to normalize alike are not one another.
  const duplicatesOf = (channel: RawContactChannel): string[] =>
    others
      .filter(
        (other) =>
          other.kind === channel.kind &&
          other.normalized_value === channel.normalized_value
      )
      .map((other) => other.party_id);
  return {
    duplicatesOf,
    duplicatePartyIds: [
      ...new Set(channels.flatMap((channel) => duplicatesOf(channel))),
    ],
  };
}

/** The contact rail, ordered as the sheet draws it: preferred first. */
export function contactEntries(
  channels: readonly RawContactChannel[],
  duplicatesOf: (channel: RawContactChannel) => string[],
  nameById: ReadonlyMap<string, string>
): ContactEntry[] {
  return channels
    .toSorted(
      (a, b) =>
        b.is_preferred - a.is_preferred ||
        a.kind.localeCompare(b.kind) ||
        a.channel_id.localeCompare(b.channel_id)
    )
    .map((channel) => {
      const duplicateIds = duplicatesOf(channel);
      let provenance: Record<string, unknown> | null = null;
      try {
        provenance = channel.provenance_json
          ? (JSON.parse(channel.provenance_json) as Record<string, unknown>)
          : null;
      } catch {
        // An unreadable provenance blob is a fact about the blob, not about
        // the address, so the address still renders.
        provenance = { source: "unreadable provenance" };
      }
      return {
        channel_id: channel.channel_id,
        kind: channel.kind,
        label: channel.label ?? null,
        value: channel.value,
        normalized_value: channel.normalized_value,
        preferred: Boolean(channel.is_preferred),
        provenance,
        duplicate_party_ids: duplicateIds,
        duplicate_names: duplicateIds.map((id) => nameById.get(id) ?? id),
      };
    });
}
