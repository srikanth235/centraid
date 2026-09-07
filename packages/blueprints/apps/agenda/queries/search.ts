import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import type { RepresentationIndex } from "../../_shared/representation-reads.ts";
/**
 * Event search as a vault projection: the vault's FTS5 index matches, so
 * core.event is never pulled wholesale (vault data is unbounded). Matched
 * rows join calendar edge + attachments in the upcoming projection's shape;
 * cancelled events drop after the hit — the index knows text, not status.
 * Consent denial is first-class: rendered as "ask the owner for access",
 * receipt id included.
 */
interface RawSearchHit {
  event_id: string;
  status?: string;
  _snippet?: unknown;
  [k: string]: unknown;
}
interface RawAttachment {
  attachment_id: string;
  target_type: string;
  target_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
  [k: string]: unknown;
}
interface RawContent {
  content_id: string;
  content_uri?: string;
  media_type?: string;
  title?: string | null;
  byte_size?: number;
  [k: string]: unknown;
}
interface RawEventExt {
  event_ext_id: string;
  event_id: string;
  [k: string]: unknown;
}
interface RawAttendee {
  attendee_id: string;
  event_id: string;
  party_id: string;
  partstat: string;
  role?: string;
  [k: string]: unknown;
}
interface DecoratedAttachment {
  attachment_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
  media_type: string;
  /** Bytes have no title of their own since #996 (R20(b)); an attachment is
   *  not a wrapper, so there is nothing here to carry one. */
  content_uri: string;
  byte_size: number;
}
interface DecoratedAttendee {
  party_id: string;
  name: string;
  partstat: string;
  role?: string;
  is_you: boolean;
}

/** The shared attachment projection — see upcoming.ts for the shape's home. */
function attachmentsBySubject(
  subjectType: string,
  attachments: RawAttachment[],
  contentById: Map<string, RawContent>,
  representations: RepresentationIndex
): Map<string, DecoratedAttachment[]> {
  // Blob-backed bytes serve as same-origin URLs (#296).
  const srcOf = (c: RawContent | undefined): string | undefined =>
    typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
  const bySubject = new Map<string, DecoratedAttachment[]>();
  for (const a of attachments) {
    if (a.target_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.target_id)) bySubject.set(a.target_id, []);
    bySubject.get(a.target_id)!.push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      // The ATTACHMENT's own reading of the bytes (#996, R20(b)); bytes
      // carry neither a media type nor a title of their own.
      media_type:
        representations.byOwner.get(
          ownerKey("core.attachment", a.attachment_id)
        ) ??
        representations.byContent.get(a.content_id) ??
        "application/octet-stream",
      content_uri: srcOf(content) ?? "",
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

/** The shared guest projection — see upcoming.ts for the shape's home. */
function attendeesByEvent(
  attendees: RawAttendee[],
  nameById: Map<string, unknown>,
  mePartyId: string | null
): Map<string, DecoratedAttendee[]> {
  const byEvent = new Map<string, DecoratedAttendee[]>();
  for (const a of attendees) {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
    byEvent.get(a.event_id)!.push({
      party_id: a.party_id,
      name: (nameById.get(a.party_id) as string | undefined) ?? "Guest",
      partstat: a.partstat,
      role: a.role,
      is_you: mePartyId != null && a.party_id === mePartyId,
    });
  }
  for (const list of byEvent.values()) {
    list.sort(
      (x, y) =>
        (y.is_you ? 1 : 0) - (x.is_you ? 1 : 0) ||
        String(x.name).localeCompare(String(y.name))
    );
  }
  return byEvent;
}

/**
 * The member-facing recurrence sentence, or `null` for a one-off. The grammar
 * is `@centraid/core/time`'s — this is the call, not a second summariser.
 */
function recurrenceSummary(
  ctx: HandlerArgs["ctx"],
  rrule: string | null
): string | null {
  const time = ctx.time as
    | { describeRecurrence?: (rule: string) => string | null }
    | undefined;
  if (!rrule || !time?.describeRecurrence) return null;
  return time.describeRecurrence(rrule);
}

export default async function searchHandler({ input, ctx }: HandlerArgs) {
  const term = String(input?.term ?? "").trim();
  if (!term) return { events: [] };
  try {
    const matches = await ctx.vault.search({
      entity: "core.event",
      query: term,
      limit: 100,
    });
    const hits = ((matches.rows ?? []) as unknown as RawSearchHit[]).filter(
      (e) => e.status !== "cancelled"
    );
    if (hits.length === 0) return { events: [] };
    const eventIds = hits.map((e) => e.event_id);
    // Joins are `in`-bounded by the matched ids (#337 drives `is_you`).
    const eventIn = inList("event_id", eventIds);
    const targetIn = inList("target_id", eventIds);
    const [extRows, attachmentRows, attendeeRows, vaultRows] =
      await Promise.all([
        readPages<RawEventExt>(ctx, {
          name: "agenda.search.eventExt",
          select:
            "event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min",
          from: "schedule_event_ext",
          where: eventIn.sql,
          bind: eventIn.bind,
          order: {
            sortColumn: "event_ext_id",
            pkColumn: "event_ext_id",
            descending: false,
          },
        }),
        readPages<RawAttachment>(ctx, {
          name: "agenda.search.attachments",
          select:
            "attachment_id, target_type, target_id, content_id, role, is_primary",
          from: "core_attachment",
          where: `target_type = ? AND ${targetIn.sql}`,
          bind: ["core.event", ...targetIn.bind],
          order: {
            sortColumn: "attachment_id",
            pkColumn: "attachment_id",
            descending: false,
          },
        }),
        readPages<RawAttendee>(ctx, {
          name: "agenda.search.attendees",
          select: "attendee_id, event_id, party_id, partstat, role",
          from: "schedule_attendee",
          where: eventIn.sql,
          bind: eventIn.bind,
          order: {
            sortColumn: "attendee_id",
            pkColumn: "attendee_id",
            descending: false,
          },
        }),
        readPages<{ vault_id: string; self_party_id?: string | null }>(ctx, {
          name: "agenda.search.vault",
          select: "vault_id, self_party_id",
          from: "core_vault",
          order: {
            sortColumn: "vault_id",
            pkColumn: "vault_id",
            descending: false,
          },
        }),
      ]);
    const mePartyId = vaultRows[0]?.self_party_id ?? null;
    const attendeePartyIds = [
      ...new Set(attendeeRows.map((a) => a.party_id)),
    ].filter(Boolean);
    const partyIn =
      attendeePartyIds.length > 0 ? inList("party_id", attendeePartyIds) : null;
    const partyRows = partyIn
      ? await readPages<{ party_id: string; display_name?: string | null }>(
          ctx,
          {
            name: "agenda.search.parties",
            select: "party_id, display_name",
            from: "core_party",
            where: partyIn.sql,
            bind: partyIn.bind,
            order: {
              sortColumn: "party_id",
              pkColumn: "party_id",
              descending: false,
            },
          }
        )
      : [];
    const partyNameById = new Map<string, unknown>(
      partyRows.map((p) => [p.party_id, p.display_name])
    );
    const guestsByEvent = attendeesByEvent(
      attendeeRows,
      partyNameById,
      mePartyId
    );
    // One bounded pull covers only referenced bytes.
    const contentIds = [
      ...new Set(attachmentRows.map((a) => a.content_id)),
    ].filter(Boolean);
    const contentIn =
      contentIds.length > 0 ? inList("content_id", contentIds) : null;
    const contentRows = contentIn
      ? await readPages<RawContent>(ctx, {
          name: "agenda.search.contents",
          select: "content_id, content_uri, byte_size",
          from: "core_content_item",
          where: contentIn.sql,
          bind: contentIn.bind,
          order: {
            sortColumn: "content_id",
            pkColumn: "content_id",
            descending: false,
          },
        })
      : [];
    // Bytes carry no media type since #996 (R20(b)) — the attachment's own
    // representation says what it reads them as.
    const representations = await readRepresentations({ ctx, contentIds });
    const contentById = new Map<string, RawContent>(
      contentRows.map((c) => [c.content_id, c])
    );
    const attByEvent = attachmentsBySubject(
      "core.event",
      attachmentRows,
      contentById,
      representations
    );
    const calByEvent = new Map<string, unknown>(
      extRows.map((x) => [x.event_id, x.calendar_id])
    );
    // Vault order is rank order (best match first) — keep it.
    const events = hits.map(({ _snippet, ...e }) => ({
      ...e,
      calendar_id: calByEvent.get(e.event_id) ?? null,
      attachments: attByEvent.get(e.event_id) ?? [],
      attendees: guestsByEvent.get(e.event_id) ?? [],
      snippet: typeof _snippet === "string" ? _snippet : "",
      // Same row shape as `upcoming`, recurrence included (#834).
      recurrence_summary: recurrenceSummary(
        ctx,
        typeof e.rrule === "string" ? e.rrule : null
      ),
    }));
    return { events };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { events: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
