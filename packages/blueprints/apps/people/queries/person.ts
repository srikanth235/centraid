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
import { inList, readById, readPages } from "../../_shared/paged-reads.ts";
import { PENDING_OVERLAY_FIELDS } from "../../_shared/pending-overlay.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import { readPersonShareLinks } from "./_shared.ts";
import {
  contactEntries,
  readChannelCollisions,
  readChannels,
} from "./person-contacts.ts";

interface RawProfile {
  party_id: string;
  deleted_at?: string | null;
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
  target_type?: string;
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
  tag_id: string;
  concept_id: string;
}

/** One roster of parties by id — the same walk from two call sites. */
function readPartiesById(
  ctx: HandlerCtx,
  name: string,
  ids: readonly string[]
): Promise<RawParty[]> {
  const partyIn = inList("party_id", ids);
  return readPages<RawParty>(ctx, {
    name,
    select: "party_id, display_name, kind",
    from: "core_party",
    where: partyIn.sql,
    bind: partyIn.bind,
    order: {
      sortColumn: "party_id",
      pkColumn: "party_id",
      descending: false,
    },
  });
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

export default async function personHandler({ input, ctx }: HandlerArgs) {
  const partyId = String(input?.party_id ?? "");
  if (!partyId) return { person: null };
  try {
    // The screen is one person, so both of these are one-row pages.
    const [profilePage, party] = await Promise.all([
      ctx.vault.page<RawProfile>({
        query: {
          name: "people.person.profile",
          select:
            "party_id, role, nickname, avatar_color, cadence_days, last_contacted_at, created_at, met, deleted_at",
          from: "people_profile",
          where: "party_id = ? AND deleted_at IS NULL",
          bind: [partyId],
          order: {
            sortColumn: "party_id",
            pkColumn: "party_id",
            descending: false,
          },
        },
        limit: 1,
      }),
      readById<RawParty>(
        ctx,
        {
          name: "people.person.party",
          select: "party_id, display_name, kind",
          from: "core_party",
          idColumn: "party_id",
        },
        partyId
      ),
    ]);
    const profile = profilePage.rows[0];
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
      // The contact rail and its collision search live in
      // `./person-contacts.ts` — one question, and the read that used to
      // answer it took the whole table (#996 wave 4).
      readChannels(ctx, partyId),
      readPages<RawLink>(ctx, {
        name: "people.person.outgoingLinks",
        select:
          "link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_to",
        from: "core_link",
        where: "from_type = ? AND from_id = ? AND valid_to IS NULL",
        bind: ["core.party", partyId],
        order: {
          sortColumn: "link_id",
          pkColumn: "link_id",
          descending: false,
        },
      }),
      readPages<RawLink>(ctx, {
        name: "people.person.incomingLinks",
        select:
          "link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_to",
        from: "core_link",
        where: "to_type = ? AND to_id = ? AND valid_to IS NULL",
        bind: ["core.party", partyId],
        order: {
          sortColumn: "link_id",
          pkColumn: "link_id",
          descending: false,
        },
      }),
      readPages<RawDate>(ctx, {
        name: "people.person.importantDates",
        select: "date_id, party_id, label, month_day, reminder_on",
        from: "people_important_date",
        where: "party_id = ? AND deleted_at IS NULL",
        bind: [partyId],
        order: {
          sortColumn: "date_id",
          pkColumn: "date_id",
          descending: false,
        },
      }),
      readPages<RawNote>(ctx, {
        name: "people.person.notes",
        select: "annotation_id, target_type, target_id, body_text, created_at",
        from: "knowledge_annotation",
        where: "target_type = ? AND target_id = ?",
        bind: ["core.party", partyId],
        order: {
          sortColumn: "created_at",
          pkColumn: "annotation_id",
          descending: true,
        },
      }),
      readPages<RawDebt>(ctx, {
        name: "people.person.debtsFrom",
        select:
          "obligation_id, from_party, to_party, amount_minor, currency, reason, settled_at",
        from: "tally_obligation",
        where: "from_party = ? AND deleted_at IS NULL",
        bind: [partyId],
        order: {
          sortColumn: "obligation_id",
          pkColumn: "obligation_id",
          descending: false,
        },
      }),
      readPages<RawDebt>(ctx, {
        name: "people.person.debtsTo",
        select:
          "obligation_id, from_party, to_party, amount_minor, currency, reason, settled_at",
        from: "tally_obligation",
        where: "to_party = ? AND deleted_at IS NULL",
        bind: [partyId],
        order: {
          sortColumn: "obligation_id",
          pkColumn: "obligation_id",
          descending: false,
        },
      }),
      readPages<RawTag>(ctx, {
        name: "people.person.tags",
        select: "tag_id, target_type, target_id, concept_id",
        from: "core_tag",
        where: "target_type = ? AND target_id = ?",
        bind: ["core.party", partyId],
        order: {
          sortColumn: "tag_id",
          pkColumn: "tag_id",
          descending: false,
        },
      }),
      ...conceptTaxonomyReads(ctx),
      readPages<{ vault_id: string; self_party_id?: string | null }>(ctx, {
        name: "people.person.vault",
        select: "vault_id, self_party_id",
        from: "core_vault",
        order: {
          sortColumn: "vault_id",
          pkColumn: "vault_id",
          descending: false,
        },
      }),
      // Null when the sharing plane is unreadable — never a thrown denial.
      readPersonShareLinks(ctx, partyId),
    ]);

    const channelRows = channelRowsResult.filter(
      (channel) => channel.party_id === partyId
    );
    const outgoing = outgoingLinks;
    const incoming = incomingLinks;
    const dateRows = dates;
    const noteRows = notes;
    const debtRows = [...debtsFrom, ...debtsTo].filter(
      (row, index, all) =>
        all.findIndex((x) => x.obligation_id === row.obligation_id) === index
    );
    const tagRows = tags;
    const conceptRows = concepts as unknown as RawConcept[];
    const schemeRows = schemes as unknown as RawScheme[];
    const ownerPartyId = String(vault[0]?.self_party_id ?? "");

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
    const { duplicatesOf, duplicatePartyIds } = await readChannelCollisions(
      ctx,
      partyId,
      channelRows
    );
    const [
      relatedParties,
      duplicateParties,
      tasks,
      interactions,
      interactionNotes,
    ] = await Promise.all([
      relationLinks.length > 0
        ? readPartiesById(
            ctx,
            "people.person.relatedParties",
            relationLinks.map((l) => l.to_id)
          )
        : Promise.resolve([] as RawParty[]),
      duplicatePartyIds.length > 0
        ? readPartiesById(
            ctx,
            "people.person.duplicateParties",
            duplicatePartyIds
          )
        : Promise.resolve([] as RawParty[]),
      taskIds.length > 0
        ? readPages<RawTask>(ctx, {
            name: "people.person.tasks",
            select: "task_id, title, status",
            from: "schedule_task",
            where: inList("task_id", taskIds).sql,
            bind: inList("task_id", taskIds).bind,
            order: {
              sortColumn: "task_id",
              pkColumn: "task_id",
              descending: false,
            },
          })
        : Promise.resolve([] as RawTask[]),
      activityIds.length > 0
        ? readPages<RawInteraction>(ctx, {
            name: "people.person.interactions",
            select: "activity_id, kind_concept_id, started_at",
            from: "core_activity",
            where: inList("activity_id", activityIds).sql,
            bind: inList("activity_id", activityIds).bind,
            order: {
              sortColumn: "started_at",
              pkColumn: "activity_id",
              descending: true,
            },
          })
        : Promise.resolve([] as RawInteraction[]),
      activityIds.length > 0
        ? readPages<RawNote & { target_id: string }>(ctx, {
            name: "people.person.interactionNotes",
            select:
              "annotation_id, target_type, target_id, body_text, created_at",
            from: "knowledge_annotation",
            where: `target_type = ? AND ${inList("target_id", activityIds).sql}`,
            bind: ["core.activity", ...inList("target_id", activityIds).bind],
            order: {
              sortColumn: "annotation_id",
              pkColumn: "annotation_id",
              descending: false,
            },
          })
        : Promise.resolve([] as Array<RawNote & { target_id: string }>),
    ]);
    const relatedPartyRows = relatedParties;
    const duplicatePartyRows = duplicateParties;
    const taskRows = tasks;
    const interactionRows = interactions;
    const interactionNoteRows = interactionNotes;

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
    const contact = contactEntries(
      channelRows,
      duplicatesOf,
      duplicateNameById
    );
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
    };
    return { person };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { person: null, vaultDenied: { code: e.code, message: e.message } };
  }
}
