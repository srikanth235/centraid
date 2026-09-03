import {
  FLAGS_SCHEME_URI,
  STARRED_NOTATION,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import {
  daysSinceContact,
  daysUntilMonthDay,
  isOverdue,
  toLinkCount,
} from "../format.ts";
import { readLiveBindings } from "./_shared.ts";

interface RawProfile {
  party_id: string;
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
  from_id: string;
  to_id: string;
}

interface RawActivity {
  activity_id: string;
  kind_concept_id: string;
  started_at: string;
}

interface RawAnnotation {
  target_id: string;
  body_text: string;
}

interface PartyEntry {
  profile: RawProfile;
  name?: string;
}

export default async function dashboard({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const window = 9_999;
  try {
    const [profiles, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        entity: "people.profile",
        where: [{ column: "deleted_at", op: "is-null" }],
        orderBy: { column: "created_at", dir: "desc" },
        limit: window,
        purpose,
      }),
      ctx.vault.read({ entity: "core.concept", purpose }),
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
    ]);
    const profileRows = (profiles.rows ?? []) as unknown as RawProfile[];
    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];
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

    const [parties, tags, dates, activityLinks, bindings] = await Promise.all([
      ctx.vault.read({
        entity: "core.party",
        where: [{ column: "party_id", op: "in", value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: "core.tag",
        where: [
          { column: "target_type", op: "eq", value: "core.party" },
          { column: "target_id", op: "in", value: partyIds },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "people.important_date",
        where: [
          { column: "party_id", op: "in", value: partyIds },
          { column: "deleted_at", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "core.link",
        where: [
          { column: "from_type", op: "eq", value: "core.activity" },
          { column: "to_type", op: "eq", value: "core.party" },
          { column: "to_id", op: "in", value: partyIds },
          { column: "valid_to", op: "is-null" },
        ],
        purpose,
      }),
      readLiveBindings(ctx.vault, partyIds),
    ]);

    const partyRows = (parties.rows ?? []) as unknown as RawParty[];
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const dateRows = (dates.rows ?? []) as unknown as RawDate[];
    const linkRows = (activityLinks.rows ?? []) as unknown as RawLink[];
    const activityIds = linkRows.map((link) => link.from_id);
    const [activities, activityAnnotations] = await Promise.all([
      activityIds.length
        ? ctx.vault.read({
            entity: "core.activity",
            where: [{ column: "activity_id", op: "in", value: activityIds }],
            orderBy: { column: "started_at", dir: "desc" },
            limit: 30,
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length
        ? ctx.vault.read({
            entity: "knowledge.annotation",
            where: [
              { column: "target_type", op: "eq", value: "core.activity" },
              { column: "target_id", op: "in", value: activityIds },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
    ]);
    const activityRows = (activities.rows ?? []) as unknown as RawActivity[];
    const annotationRows = (activityAnnotations.rows ??
      []) as unknown as RawAnnotation[];
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
