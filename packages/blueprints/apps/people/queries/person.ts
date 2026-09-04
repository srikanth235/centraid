/**
 * One person's full profile, gathered from the vault: the party, its
 * people_profile, the party's contact identifiers and every child record.
 * Nothing is stored by the app; it is all a read of the owner's vault.
 *
 * The sharing questions (./_shared.ts) deny independently of the profile —
 * People's `share.*` scopes are newer than the app, so on an existing vault
 * they wait for the owner — and a denial leaves those three fields null
 * instead of blanking the person.
 */

import {
  FLAGS_SCHEME_URI,
  LIST_SCHEME_URI,
  RELATIONS_SCHEME_URI,
  STARRED_NOTATION,
  conceptsInScheme,
  findScheme,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import { PENDING_OVERLAY_FIELDS } from "../../_shared/pending-overlay.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import { readPersonShareLinks } from "./_shared.ts";

interface RawProfile {
  role?: string | null;
  nickname?: string | null;
  avatar_color?: string | null;
  cadence_days: number;
  last_contacted_at?: string | null;
  created_at: string;
  met?: string | null;
}

interface RawParty {
  party_id: string;
  display_name: string;
  kind?: string;
}

interface RawContactChannel {
  channel_id: string;
  party_id: string;
  kind: "phone" | "email" | "address" | "handle";
  label?: string | null;
  value: string;
  normalized_value: string;
  is_preferred: number;
  provenance_json?: string | null;
}

interface RawLink {
  link_id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation_concept_id: string;
  valid_to?: string | null;
}

interface RawDate {
  date_id: string;
  label: string;
  month_day: string;
  reminder_on?: number | boolean | null;
}

interface RawNote {
  annotation_id: string;
  body_text: string;
  created_at: string;
}

interface RawTask {
  task_id: string;
  title: string;
  status: string;
}

interface RawDebt {
  obligation_id: string;
  from_party: string;
  to_party: string;
  amount_minor: number;
  currency: string;
  reason?: string | null;
  settled_at?: string | null;
}

interface RawInteraction {
  activity_id: string;
  kind_concept_id: string;
  started_at: string;
}

interface RawTag {
  concept_id: string;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}

interface RawScheme {
  uri: string;
  scheme_id: string;
}

interface ContactEntry {
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

export default async function personHandler({ input, ctx }: HandlerArgs) {
  const partyId = String(input?.party_id ?? "");
  if (!partyId) return { person: null };
  try {
    const [profiles, parties] = await Promise.all([
      ctx.vault.read({
        acceptTruncation: true,
        entity: "people.profile",
        where: [
          { column: "party_id", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.party",
        where: [{ column: "party_id", op: "eq", value: partyId }],
      }),
    ]);
    const profile = ((profiles.rows ?? []) as unknown as RawProfile[])[0];
    const party = ((parties.rows ?? []) as unknown as RawParty[])[0];
    if (!profile || !party) return { person: null };

    const [
      channelRowsResult,
      outgoingLinks,
      incomingLinks,
      dates,
      notes,
      debtsFrom,
      debtsTo,
      tags,
      concepts,
      schemes,
      vault,
      shareLinks,
    ] = await Promise.all([
      // `core.party_identifier` is NOT read here any more (#883, ruling
      // O-contact): reachability has one store, and the read-time fold of
      // legacy `tel`/`email` identifier rows back into this list went with the
      // rung that moved them onto channels.
      ctx.vault.read({
        entity: "social.contact_channel",
        limit: 2000,
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.link",
        where: [
          { column: "from_type", op: "eq", value: "core.party" },
          { column: "from_id", op: "eq", value: partyId },
          { column: "valid_to", op: "is-null" },
        ],
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.link",
        where: [
          { column: "to_type", op: "eq", value: "core.party" },
          { column: "to_id", op: "eq", value: partyId },
          { column: "valid_to", op: "is-null" },
        ],
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "people.important_date",
        where: [
          { column: "party_id", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "knowledge.annotation",
        where: [
          { column: "target_type", op: "eq", value: "core.party" },
          { column: "target_id", op: "eq", value: partyId },
        ],
        orderBy: { column: "created_at", dir: "desc" },
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "tally.obligation",
        where: [
          { column: "from_party", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "tally.obligation",
        where: [
          { column: "to_party", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
      }),
      ctx.vault.read({
        acceptTruncation: true,
        entity: "core.tag",
        where: [
          { column: "target_type", op: "eq", value: "core.party" },
          { column: "target_id", op: "eq", value: partyId },
        ],
      }),
      ...conceptTaxonomyReads(ctx.vault),
      ctx.vault.read({ acceptTruncation: true, entity: "core.vault" }),
      // Null when the sharing plane is unreadable — never a thrown denial.
      readPersonShareLinks(ctx.vault, partyId),
    ]);

    const allChannelRows = (channelRowsResult.rows ??
      []) as unknown as RawContactChannel[];
    const channelRows = allChannelRows.filter(
      (channel) => channel.party_id === partyId
    );
    const outgoing = (outgoingLinks.rows ?? []) as unknown as RawLink[];
    const incoming = (incomingLinks.rows ?? []) as unknown as RawLink[];
    const dateRows = (dates.rows ?? []) as unknown as RawDate[];
    const noteRows = (notes.rows ?? []) as unknown as RawNote[];
    const debtRows = [
      ...((debtsFrom.rows ?? []) as unknown as RawDebt[]),
      ...((debtsTo.rows ?? []) as unknown as RawDebt[]),
    ].filter(
      (row, index, all) =>
        all.findIndex((x) => x.obligation_id === row.obligation_id) === index
    );
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];
    const ownerPartyId = String((vault.rows ?? [])[0]?.self_party_id ?? "");

    const relationLinks = outgoing.filter(
      (link) =>
        link.to_type === "core.party" &&
        conceptRows.some(
          (concept) =>
            concept.concept_id === link.relation_concept_id &&
            concept.notation?.startsWith("people-")
        )
    );
    const relationSchemeId = findScheme(
      schemeRows,
      RELATIONS_SCHEME_URI
    )?.scheme_id;
    const giftTaskIds = new Set(
      incoming
        .filter(
          (link) =>
            link.from_type === "schedule.task" &&
            conceptRows.some(
              (concept) =>
                concept.concept_id === link.relation_concept_id &&
                concept.scheme_id === relationSchemeId &&
                concept.notation === "gift-for"
            )
        )
        .map((link) => link.from_id)
    );
    const taskIds = incoming
      .filter((link) => link.from_type === "schedule.task")
      .map((link) => link.from_id);
    const activityIds = incoming
      .filter((link) => link.from_type === "core.activity")
      .map((link) => link.from_id);
    const duplicatePartyIds = [
      ...new Set(
        channelRows.flatMap((channel) =>
          allChannelRows
            .filter(
              (other) =>
                other.party_id !== partyId &&
                other.kind === channel.kind &&
                other.normalized_value === channel.normalized_value
            )
            .map((other) => other.party_id)
        )
      ),
    ];
    const [
      relatedParties,
      duplicateParties,
      tasks,
      interactions,
      interactionNotes,
    ] = await Promise.all([
      relationLinks.length > 0
        ? ctx.vault.read({
            acceptTruncation: true,
            entity: "core.party",
            where: [
              {
                column: "party_id",
                op: "in",
                value: relationLinks.map((l) => l.to_id),
              },
            ],
          })
        : Promise.resolve({ rows: [] }),
      duplicatePartyIds.length > 0
        ? ctx.vault.read({
            acceptTruncation: true,
            entity: "core.party",
            where: [
              {
                column: "party_id",
                op: "in",
                value: duplicatePartyIds,
              },
            ],
          })
        : Promise.resolve({ rows: [] }),
      taskIds.length > 0
        ? ctx.vault.read({
            acceptTruncation: true,
            entity: "schedule.task",
            where: [{ column: "task_id", op: "in", value: taskIds }],
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length > 0
        ? ctx.vault.read({
            acceptTruncation: true,
            entity: "core.activity",
            where: [{ column: "activity_id", op: "in", value: activityIds }],
            orderBy: { column: "started_at", dir: "desc" },
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length > 0
        ? ctx.vault.read({
            acceptTruncation: true,
            entity: "knowledge.annotation",
            where: [
              { column: "target_type", op: "eq", value: "core.activity" },
              { column: "target_id", op: "in", value: activityIds },
            ],
          })
        : Promise.resolve({ rows: [] }),
    ]);
    const relatedPartyRows = (relatedParties.rows ??
      []) as unknown as RawParty[];
    const duplicatePartyRows = (duplicateParties.rows ??
      []) as unknown as RawParty[];
    const taskRows = (tasks.rows ?? []) as unknown as RawTask[];
    const interactionRows = (interactions.rows ??
      []) as unknown as RawInteraction[];
    const interactionNoteRows = (interactionNotes.rows ??
      []) as unknown as Array<RawNote & { target_id: string }>;

    const listConceptIds = new Set<string>(
      conceptsInScheme(
        conceptRows,
        findScheme(schemeRows, LIST_SCHEME_URI)
      ).map((c) => c.concept_id)
    );
    const starredConceptId =
      findSchemeConcept(
        schemeRows,
        conceptRows,
        FLAGS_SCHEME_URI,
        STARRED_NOTATION
      )?.concept_id ?? null;
    let listId: string | null = null;
    let starred = false;
    for (const t of tagRows) {
      if (listConceptIds.has(t.concept_id)) listId = t.concept_id;
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starred = true;
    }
    const conceptById = new Map(
      conceptRows.map((concept) => [concept.concept_id, concept])
    );
    const relatedById = new Map(
      relatedPartyRows.map((related) => [related.party_id, related])
    );
    const interactionText = new Map(
      interactionNoteRows.map((annotation) => [
        annotation.target_id,
        annotation.body_text,
      ])
    );

    const duplicateNameById = new Map(
      duplicatePartyRows.map((row) => [row.party_id, row.display_name])
    );
    const contact: ContactEntry[] = channelRows
      .toSorted(
        (a, b) =>
          b.is_preferred - a.is_preferred ||
          a.kind.localeCompare(b.kind) ||
          a.channel_id.localeCompare(b.channel_id)
      )
      .map((channel) => {
        const duplicateIds = allChannelRows
          .filter(
            (other) =>
              other.party_id !== partyId &&
              other.kind === channel.kind &&
              other.normalized_value === channel.normalized_value
          )
          .map((other) => other.party_id);
        let provenance: Record<string, unknown> | null = null;
        try {
          provenance = channel.provenance_json
            ? (JSON.parse(channel.provenance_json) as Record<string, unknown>)
            : null;
        } catch {
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
          duplicate_names: duplicateIds.map(
            (id) => duplicateNameById.get(id) ?? id
          ),
        };
      });
    const person = {
      // Stamps ride along: the detail draws the roster's chip (#864).
      ...Object.fromEntries(
        Object.values(PENDING_OVERLAY_FIELDS).flatMap((field) =>
          field in profile
            ? [[field, (profile as unknown as Record<string, unknown>)[field]]]
            : []
        )
      ),
      party_id: partyId,
      name: party.display_name,
      role: profile.role ?? "",
      nickname: profile.nickname ?? "",
      avatar_color: profile.avatar_color ?? null,
      cadence_days: profile.cadence_days,
      last_contacted_at: profile.last_contacted_at ?? null,
      created_at: profile.created_at,
      met: profile.met ?? "",
      list_id: listId,
      starred,
      contact,
      relationships: relationLinks.map((link) => {
        const related = relatedById.get(link.to_id);
        const notation =
          conceptById.get(link.relation_concept_id)?.notation ??
          "people-related";
        const tokens = notation.replace(/^people-/u, "").split("-");
        const pet = related?.kind === "animal" ? (tokens.pop() ?? null) : null;
        return {
          relationship_id: link.link_id,
          related_party_id: link.to_id,
          name: related?.display_name ?? "—",
          kind: tokens.join(" ") || "related",
          pet,
        };
      }),
      dates: dateRows.map((d) => ({
        date_id: d.date_id,
        label: d.label,
        month_day: d.month_day,
        reminder_on: !!d.reminder_on,
      })),
      notes: noteRows.map((n) => ({
        annotation_id: n.annotation_id,
        text: n.body_text,
        created_at: n.created_at,
      })),
      tasks: taskRows
        .filter((t) => !giftTaskIds.has(t.task_id))
        .map((t) => ({
          task_id: t.task_id,
          text: t.title,
          done: t.status === "completed",
        })),
      gifts: taskRows
        .filter((t) => giftTaskIds.has(t.task_id))
        .map((t) => ({
          gift_id: t.task_id,
          text: t.title,
          state: t.status === "completed" ? "given" : "idea",
        })),
      debts: debtRows
        .filter((d) => d.settled_at == null)
        .map((d) => ({
          debt_id: d.obligation_id,
          direction: d.from_party === ownerPartyId ? "owe" : "owed",
          amount_minor: d.amount_minor,
          currency: d.currency,
          reason: d.reason ?? "",
        })),
      interactions: interactionRows.map((i) => ({
        interaction_id: i.activity_id,
        kind: conceptById.get(i.kind_concept_id)?.notation ?? "interaction",
        text: interactionText.get(i.activity_id) ?? "",
        occurred_at: i.started_at,
      })),
      vaults: shareLinks?.vaults ?? null,
      pending_invites: shareLinks?.pending_invites ?? null,
    };
    return { person };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { person: null, vaultDenied: { code: e.code, message: e.message } };
  }
}
