/**
 * The people window as a bounded recent view: the CRM people are the rows of
 * people.profile (each a 1:1 enrichment of a canonical core.party), newest
 * first, caller-sized (default the read max). Each row is decorated with its party's
 * display name, its list (one lists-scheme tag, the same mechanism Docs
 * folders use), its canonical favorite star (the flags-scheme tag on the
 * party, #274), and its active reminder dates so the sidebar can derive
 * Reconnect / Upcoming / Favorites client-side.
 * `truncated` means older people exist beyond the window and is named on the
 * status line — never a silent drop.
 *
 * Each row also carries the sharing plane's answer to "is this person linked
 * to a vault of their own?" (`linked` / `vault_count`, via ./_shared.ts). Those
 * reads can be denied independently of the roster — People's `share.*` scopes
 * are newer than the app — so a denial leaves `linked` null and flips
 * `links_available` to false rather than darkening the window; the UI draws
 * Linked/Unlinked chips only while that flag is true.
 *
 * Everything comes from the vault; this app holds no rows of its own. A
 * consent denial is a first-class outcome (vaultDenied), rendered as the
 * "ask the owner for access" state.
 */

import {
  FLAGS_SCHEME_URI,
  LIST_SCHEME_URI,
  STARRED_NOTATION,
  conceptsInScheme,
  findScheme,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import { inList, readPages } from "../../_shared/paged-reads.ts";
import { PENDING_OVERLAY_FIELDS } from "../../_shared/pending-overlay.ts";
import { conceptTaxonomyReads } from "../../_shared/taxonomy-reads.ts";
import { readLiveBindings } from "./_shared.ts";

/** Forwarded verbatim, so the roster can draw the pending chip (#864). */
function pendingStamps(
  row: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(PENDING_OVERLAY_FIELDS).flatMap((field) =>
      field in row ? [[field, row[field]]] : []
    )
  );
}

interface RawProfile {
  party_id: string;
  created_at: string;
  deleted_at?: string | null;
  cadence_days: number;
  role?: string | null;
  avatar_color?: string | null;
  last_contacted_at?: string | null;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  pref_label?: string;
  notation?: string;
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
  target_id: string;
}

interface RawDate {
  party_id: string;
  reminder_on?: number | boolean | null;
  date_id: string;
  label: string;
  month_day: string;
}

interface Reminder {
  date_id: string;
  label: string;
  month_day: string;
}

/** Gateway read max is 10_000; look-ahead needs one spare row. */
const ROSTER_MAX = 9_999;

export default async function peopleHandler({ input, ctx }: HandlerArgs) {
  const window = Math.min(
    Math.max(Number(input?.limit) || ROSTER_MAX, 20),
    ROSTER_MAX
  );
  try {
    const [profiles, concepts, schemes] = await Promise.all([
      // THE ROSTER IS A PAGE (#996 wave 4, R8). It used to ask for `window + 1`
      // and slice the extra off — a probe row the handler owned. The probe is
      // the HOST's on both ends now, and `next` is what it produces: not just
      // "there is more" but where to carry on from.
      ctx.vault.page<RawProfile>({
        query: {
          name: "people.roster.profiles",
          select:
            "party_id, created_at, cadence_days, role, avatar_color, last_contacted_at, deleted_at",
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

    const conceptRows = concepts as unknown as RawConcept[];
    const schemeRows = schemes as unknown as RawScheme[];

    // Lists are owner-curated SKOS concepts — small and unbounded.
    const listConcepts = conceptsInScheme(
      conceptRows,
      findScheme(schemeRows, LIST_SCHEME_URI)
    );
    const lists = listConcepts
      .map((c) => ({ list_id: c.concept_id, name: c.pref_label }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));
    const listConceptIds = new Set<string>(
      listConcepts.map((c) => c.concept_id)
    );
    const starredConceptId =
      findSchemeConcept(
        schemeRows,
        conceptRows,
        FLAGS_SCHEME_URI,
        STARRED_NOTATION
      )?.concept_id ?? null;

    const truncated = profiles.next !== undefined;
    const profileRows = profiles.rows;
    const partyIds = profileRows.map((p) => p.party_id);
    if (partyIds.length === 0)
      return {
        people: [],
        lists,
        truncated: false,
        window,
        links_available: true,
      };

    const partyIn = inList("party_id", partyIds);
    const targetIn = inList("target_id", partyIds);
    const [partyRows, tagRows, dateRows, bindings] = await Promise.all([
      readPages<RawParty>(ctx, {
        name: "people.roster.parties",
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
        name: "people.roster.tags",
        select: "tag_id, target_type, target_id, concept_id",
        from: "core_tag",
        where: `target_type = ? AND ${targetIn.sql}`,
        bind: ["core.party", ...targetIn.bind],
        order: { sortColumn: "tag_id", pkColumn: "tag_id", descending: false },
      }),
      readPages<RawDate>(ctx, {
        name: "people.roster.importantDates",
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
      // One bounded read for the whole window; null means "denied", not "none".
      readLiveBindings(ctx, partyIds),
    ]);

    const nameById = new Map<string, string>(
      partyRows.map((p) => [p.party_id, p.display_name] as const)
    );
    const listByParty = new Map<string, string>();
    const starredParties = new Set<string>();
    for (const t of tagRows) {
      if (listConceptIds.has(t.concept_id))
        listByParty.set(t.target_id, t.concept_id);
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starredParties.add(t.target_id);
    }
    const remindersByParty = new Map<string, Reminder[]>();
    for (const d of dateRows) {
      if (!d.reminder_on) continue;
      const arr = remindersByParty.get(d.party_id) ?? [];
      arr.push({ date_id: d.date_id, label: d.label, month_day: d.month_day });
      remindersByParty.set(d.party_id, arr);
    }

    const linksAvailable = bindings !== null;
    const vaultCountByParty = new Map<string, number>();
    for (const binding of bindings ?? [])
      vaultCountByParty.set(
        binding.party_id,
        (vaultCountByParty.get(binding.party_id) ?? 0) + 1
      );

    const people = profileRows.map((pr) => ({
      party_id: pr.party_id,
      name: nameById.get(pr.party_id) ?? "—",
      role: pr.role ?? "",
      avatar_color: pr.avatar_color ?? null,
      cadence_days: pr.cadence_days,
      last_contacted_at: pr.last_contacted_at ?? null,
      created_at: pr.created_at,
      list_id: listByParty.get(pr.party_id) ?? null,
      starred: starredParties.has(pr.party_id),
      reminders: remindersByParty.get(pr.party_id) ?? [],
      linked: linksAvailable ? vaultCountByParty.has(pr.party_id) : null,
      vault_count: vaultCountByParty.get(pr.party_id) ?? 0,
      ...pendingStamps(pr as unknown as Record<string, unknown>),
    }));
    return {
      people,
      lists,
      truncated,
      window,
      links_available: linksAvailable,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      people: [],
      lists: [],
      links_available: false,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
