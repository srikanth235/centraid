/**
 * The keep-in-touch summary, derived from the vault: who is overdue to
 * reconnect with (last contact strictly past their cadence), which reminders are
 * coming up next (birthdays and dates with their reminder on), the most recent
 * touches you have logged, and the headline counts. A person never contacted
 * counts from when they were added, so a fresh contact reads as on-track.
 *
 * The app's own views compute Reconnect / Upcoming / Favorites client-side
 * from the `people` window; this query is the same judgment server-side.
 *
 * A cadence of 0 days means "no cadence set", not "overdue every day": those
 * people are excluded from Reconnect entirely rather than pinned to the top of
 * it forever.
 *
 * The counts also carry `linked` / `to_link` — how many of these people have a
 * vault of their own. That read denies independently (People's `share.*`
 * scopes are newer than the app), and a denial leaves the pair null while the
 * four original counts stand.
 */

import {
  FLAGS_SCHEME_URI,
  STARRED_NOTATION,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import { inList, readPages } from "../../_shared/paged-reads.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import {
  daysSinceContact,
  daysUntilMonthDay,
  isOverdue,
  toLinkCount,
} from "../format.ts";
import { readLiveBindings } from "./_shared.ts";

/** The recent-activity rail's own size. */
const RECENT_ACTIVITY_ROWS = 30;

interface RawProfile {
  party_id: string;
  deleted_at?: string | null;
  created_at: string;
  last_contacted_at?: string | null;
  cadence_days: number;
  avatar_color?: string | null;
  role?: string | null;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  notation?: string;
  pref_label?: string;
}

interface RawScheme {
  uri: string;
  scheme_id: string;
}

interface RawParty {
  party_id: string;
  display_name: string;
}

interface RawTag {
  tag_id: string;
  concept_id: string;
}

interface RawDate {
  party_id: string;
  reminder_on?: number | boolean | null;
  date_id: string;
  label: string;
  month_day: string;
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

interface PartyEntry {
  profile: RawProfile;
  name?: string;
}

export default async function dashboard({ ctx }: HandlerArgs) {
  const window = 9_999;
  try {
    const [profiles, concepts, schemes] = await Promise.all([
      ctx.vault.page<RawProfile>({
        query: {
          name: "people.dashboard.profiles",
          select:
            "party_id, created_at, last_contacted_at, cadence_days, avatar_color, role, deleted_at",
          from: "people_profile",
          where: "deleted_at IS NULL",
          order: {
            sortColumn: "created_at",
            pkColumn: "party_id",
            descending: true,
          },
        },
        limit: window,
      }),
      ...conceptTaxonomyReads(ctx),
    ]);
    const profileRows = profiles.rows;
    const conceptRows = concepts as unknown as RawConcept[];
    const schemeRows = schemes as unknown as RawScheme[];
    const partyIds = profileRows.map((p) => p.party_id);
    if (partyIds.length === 0) {
      return {
        reconnect: [],
        upcoming: [],
        recent: [],
        counts: {
          all: 0,
          reconnect: 0,
          upcoming: 0,
          starred: 0,
          linked: 0,
          to_link: 0,
        },
      };
    }

    const starredConceptId =
      findSchemeConcept(
        schemeRows,
        conceptRows,
        FLAGS_SCHEME_URI,
        STARRED_NOTATION
      )?.concept_id ?? null;

    // Every decoration is `in`-bounded by the roster the window returned.
    const partyIn = inList("party_id", partyIds);
    const targetIn = inList("target_id", partyIds);
    const toIn = inList("to_id", partyIds);
    const [partyRows, tagRows, dateRows, linkRows, bindings] =
      await Promise.all([
        readPages<RawParty>(ctx, {
          name: "people.dashboard.parties",
          select: "party_id, display_name",
          from: "core_party",
          where: partyIn.sql,
          bind: partyIn.bind,
          order: {
            sortColumn: "party_id",
            pkColumn: "party_id",
            descending: false,
          },
        }),
        readPages<RawTag>(ctx, {
          name: "people.dashboard.tags",
          select: "tag_id, target_type, target_id, concept_id",
          from: "core_tag",
          where: `target_type = ? AND ${targetIn.sql}`,
          bind: ["core.party", ...targetIn.bind],
          order: {
            sortColumn: "tag_id",
            pkColumn: "tag_id",
            descending: false,
          },
        }),
        readPages<RawDate>(ctx, {
          name: "people.dashboard.importantDates",
          select: "date_id, party_id, label, month_day, reminder_on",
          from: "people_important_date",
          where: `${partyIn.sql} AND deleted_at IS NULL`,
          bind: partyIn.bind,
          order: {
            sortColumn: "date_id",
            pkColumn: "date_id",
            descending: false,
          },
        }),
        readPages<RawLink>(ctx, {
          name: "people.dashboard.activityLinks",
          select: "link_id, from_type, from_id, to_type, to_id",
          from: "core_link",
          where: `from_type = ? AND to_type = ? AND ${toIn.sql} AND valid_to IS NULL`,
          bind: ["core.activity", "core.party", ...toIn.bind],
          order: {
            sortColumn: "link_id",
            pkColumn: "link_id",
            descending: false,
          },
        }),
        // Null means the sharing plane is unreadable, not that nobody is linked.
        readLiveBindings(ctx, partyIds),
      ]);

    const activityIds = linkRows.map((link) => link.from_id);
    const activityIn =
      activityIds.length > 0 ? inList("activity_id", activityIds) : null;
    const annotationIn =
      activityIds.length > 0 ? inList("target_id", activityIds) : null;
    const [activities, annotationRows] = await Promise.all([
      activityIn
        ? ctx.vault.page<RawActivity>({
            query: {
              name: "people.dashboard.activities",
              select: "activity_id, kind_concept_id, started_at",
              from: "core_activity",
              where: activityIn.sql,
              bind: activityIn.bind,
              order: {
                sortColumn: "started_at",
                pkColumn: "activity_id",
                descending: true,
              },
            },
            limit: RECENT_ACTIVITY_ROWS,
          })
        : Promise.resolve({ rows: [] as RawActivity[] }),
      annotationIn
        ? readPages<RawAnnotation>(ctx, {
            name: "people.dashboard.activityNotes",
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
    ]);
    const activityRows = activities.rows;
    const partyByActivity = new Map(
      linkRows.map((link) => [link.from_id, link.to_id])
    );
    const textByActivity = new Map(
      annotationRows.map((row) => [row.target_id, row.body_text])
    );
    const kindById = new Map(
      conceptRows.map((row) => [row.concept_id, row.pref_label ?? "Touch"])
    );

    const byParty = new Map<string, PartyEntry>();
    for (const pr of profileRows) byParty.set(pr.party_id, { profile: pr });
    for (const p of partyRows) {
      const e = byParty.get(p.party_id);
      if (e) e.name = p.display_name;
    }
    const card = (partyId: string) => {
      const e = byParty.get(partyId);
      return {
        party_id: partyId,
        name: e?.name ?? "—",
        avatar_color: e?.profile?.avatar_color ?? null,
        role: e?.profile?.role ?? "",
      };
    };

    let starred = 0;
    for (const t of tagRows) {
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starred += 1;
    }

    const reconnect = profileRows
      .filter((pr) => isOverdue(pr))
      .map((pr) => ({
        pr,
        over: daysSinceContact(pr) - pr.cadence_days,
      }))
      .toSorted((a, b) => b.over - a.over)
      .map((x) => card(x.pr.party_id));

    const upcoming = dateRows
      .filter((d) => d.reminder_on)
      .map((d) => ({ d, until: daysUntilMonthDay(d.month_day) }))
      .toSorted((a, b) => a.until - b.until)
      .map((x) => ({
        ...card(x.d.party_id),
        date_id: x.d.date_id,
        label: x.d.label,
        month_day: x.d.month_day,
      }));

    const recent = activityRows
      .map((activity) => {
        const partyId = partyByActivity.get(activity.activity_id);
        if (!partyId) return null;
        return {
          ...card(partyId),
          interaction_id: activity.activity_id,
          kind: kindById.get(activity.kind_concept_id) ?? "Touch",
          text: textByActivity.get(activity.activity_id) ?? "",
          occurred_at: activity.started_at,
        };
      })
      .filter((row) => row !== null);

    const linked =
      bindings === null
        ? null
        : new Set(
            bindings
              .filter((b) => byParty.has(b.party_id))
              .map((b) => b.party_id)
          ).size;

    return {
      reconnect,
      upcoming,
      recent,
      counts: {
        all: profileRows.length,
        reconnect: reconnect.length,
        upcoming: upcoming.length,
        starred,
        linked,
        to_link: toLinkCount(profileRows.length, linked),
      },
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      reconnect: [],
      upcoming: [],
      recent: [],
      counts: {
        all: 0,
        reconnect: 0,
        upcoming: 0,
        starred: 0,
        linked: null,
        to_link: null,
      },
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
