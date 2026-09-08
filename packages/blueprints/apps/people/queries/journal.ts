/**
 * The People journal projects canonical rows (#450): owner entries are
 * knowledge.note rows tagged in the People-journal scheme; automatic ones
 * are core.activity rows linked `about` a party, with annotations.
 */

import { readJournalNoteIds } from "../../_shared/journal-scheme.ts";
import { inList, readPages } from "../../_shared/paged-reads.ts";

interface RawConcept {
  concept_id: string;
  notation: string;
}
interface RawNote {
  note_id: string;
  title: string;
  body_content_id: string;
  created_at: string;
}
interface RawContent {
  content_id: string;
  content_uri: string;
}
interface RawLink {
  link_id: string;
  from_id: string;
  to_id: string;
}
interface RawActivity {
  activity_id: string;
  kind_concept_id: string;
  started_at: string;
}
interface RawAnnotation {
  annotation_id: string;
  target_id: string;
  body_text: string;
}
interface RawParty {
  party_id: string;
  display_name: string;
}
interface RawProfile {
  party_id: string;
  avatar_color?: string | null;
}

function decodeText(uri: string | undefined): string {
  if (!uri?.startsWith("data:")) return "";
  const comma = uri.indexOf(",");
  if (comma < 0) return "";
  try {
    return decodeURIComponent(uri.slice(comma + 1));
  } catch {
    return "";
  }
}

export default async function journalHandler({ ctx }: HandlerArgs) {
  try {
    const [journalNoteIds, concepts, activityLinks] = await Promise.all([
      readJournalNoteIds(ctx),
      // The vocabulary is owner-curated and small; it bounds the rest.
      readPages<RawConcept>(ctx, {
        name: "people.journal.concepts",
        select: "concept_id, notation",
        from: "core_concept",
        order: {
          sortColumn: "concept_id",
          pkColumn: "concept_id",
          descending: false,
        },
      }),
      readPages<RawLink>(ctx, {
        name: "people.journal.activityLinks",
        select: "link_id, from_type, from_id, to_type, to_id",
        from: "core_link",
        where: "from_type = ? AND to_type = ? AND valid_to IS NULL",
        bind: ["core.activity", "core.party"],
        order: {
          sortColumn: "link_id",
          pkColumn: "link_id",
          descending: false,
        },
      }),
    ]);
    const conceptRows = concepts;
    const noteIds = [...journalNoteIds];
    const links = activityLinks;
    const activityIds = [...new Set(links.map((link) => link.from_id))];
    const partyIds = [...new Set(links.map((link) => link.to_id))];

    // Every read below is `in`-bounded by a set the two above produced, so
    // each is walked to the end of it (#996 wave 4, R8).
    const noteIn = noteIds.length > 0 ? inList("note_id", noteIds) : null;
    const activityIn =
      activityIds.length > 0 ? inList("activity_id", activityIds) : null;
    const annotationIn =
      activityIds.length > 0 ? inList("target_id", activityIds) : null;
    const partyIn = partyIds.length > 0 ? inList("party_id", partyIds) : null;
    const [noteRows, activityRowsRead, annotationRowsRead, parties, profiles] =
      await Promise.all([
        noteIn
          ? readPages<RawNote>(ctx, {
              name: "people.journal.notes",
              select: "note_id, title, body_content_id, created_at",
              from: "knowledge_note",
              where: `${noteIn.sql} AND deleted_at IS NULL`,
              bind: noteIn.bind,
              order: {
                sortColumn: "created_at",
                pkColumn: "note_id",
                descending: true,
              },
            })
          : Promise.resolve([] as RawNote[]),
        activityIn
          ? readPages<RawActivity>(ctx, {
              name: "people.journal.activities",
              select: "activity_id, kind_concept_id, started_at",
              from: "core_activity",
              where: activityIn.sql,
              bind: activityIn.bind,
              order: {
                sortColumn: "started_at",
                pkColumn: "activity_id",
                descending: true,
              },
            })
          : Promise.resolve([] as RawActivity[]),
        annotationIn
          ? readPages<RawAnnotation>(ctx, {
              name: "people.journal.annotations",
              select: "annotation_id, target_type, target_id, body_text",
              from: "knowledge_annotation",
              where: `target_type = ? AND ${annotationIn.sql}`,
              bind: ["core.activity", ...annotationIn.bind],
              order: {
                sortColumn: "annotation_id",
                pkColumn: "annotation_id",
                descending: false,
              },
            })
          : Promise.resolve([] as RawAnnotation[]),
        partyIn
          ? readPages<RawParty>(ctx, {
              name: "people.journal.parties",
              select: "party_id, display_name",
              from: "core_party",
              where: partyIn.sql,
              bind: partyIn.bind,
              order: {
                sortColumn: "party_id",
                pkColumn: "party_id",
                descending: false,
              },
            })
          : Promise.resolve([] as RawParty[]),
        partyIn
          ? readPages<RawProfile>(ctx, {
              name: "people.journal.profiles",
              select: "party_id, avatar_color",
              from: "people_profile",
              where: partyIn.sql,
              bind: partyIn.bind,
              order: {
                sortColumn: "party_id",
                pkColumn: "party_id",
                descending: false,
              },
            })
          : Promise.resolve([] as RawProfile[]),
      ]);
    const contentIds = noteRows.map((note) => note.body_content_id);
    const contentIn =
      contentIds.length > 0 ? inList("content_id", contentIds) : null;
    const contents = contentIn
      ? await readPages<RawContent>(ctx, {
          name: "people.journal.bodies",
          select: "content_id, content_uri",
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
    const contentById = new Map(
      contents.map((content) => [content.content_id, content.content_uri])
    );
    const conceptById = new Map(
      conceptRows.map((concept) => [concept.concept_id, concept])
    );
    const partyById = new Map(parties.map((party) => [party.party_id, party]));
    const colorById = new Map(
      profiles.map((profile) => [profile.party_id, profile.avatar_color])
    );
    const partyByActivity = new Map(
      links.map((link) => [link.from_id, link.to_id])
    );
    const textByActivity = new Map(
      annotationRowsRead.map((annotation) => [
        annotation.target_id,
        annotation.body_text,
      ])
    );

    const owner = noteRows.map((note) => ({
      kind: "entry",
      id: note.note_id,
      sort_at: note.created_at,
      date: note.created_at.slice(0, 10),
      mood: note.title.replace(/^People journal · /u, ""),
      text: decodeText(contentById.get(note.body_content_id)),
    }));
    const auto = activityRowsRead.map((activity) => {
      const partyId = partyByActivity.get(activity.activity_id) ?? "";
      return {
        kind: "auto",
        id: activity.activity_id,
        sort_at: activity.started_at,
        date: activity.started_at,
        touch:
          conceptById.get(activity.kind_concept_id)?.notation ?? "interaction",
        text: textByActivity.get(activity.activity_id) ?? "",
        party_id: partyId,
        name: partyById.get(partyId)?.display_name ?? "—",
        avatar_color: colorById.get(partyId) ?? null,
      };
    });

    return {
      entries: [...owner, ...auto].toSorted((a, b) =>
        String(b.sort_at).localeCompare(String(a.sort_at))
      ),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { entries: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
