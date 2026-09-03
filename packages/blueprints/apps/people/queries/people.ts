import {
  FLAGS_SCHEME_URI,
  LIST_SCHEME_URI,
  STARRED_NOTATION,
  conceptsInScheme,
  findScheme,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";
import { PENDING_OVERLAY_FIELDS } from "../../_shared/pending-overlay.ts";
import { readLiveBindings } from "./_shared.ts";

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

const ROSTER_MAX = 9_999;

export default async function peopleHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const window = Math.min(
    Math.max(Number(input?.limit) || ROSTER_MAX, 20),
    ROSTER_MAX
  );
  try {
    const [profiles, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        entity: "people.profile",
        where: [{ column: "deleted_at", op: "is-null" }],
        orderBy: { column: "created_at", dir: "desc" },
        limit: window + 1,
        purpose,
      }),
      ctx.vault.read({ entity: "core.concept", purpose }),
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
    ]);

    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];

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

    const fetched = (profiles.rows ?? []) as unknown as RawProfile[];
    const truncated = fetched.length > window;
    const profileRows = truncated ? fetched.slice(0, window) : fetched;
    const partyIds = profileRows.map((p) => p.party_id);
    if (partyIds.length === 0)
      return {
        people: [],
        lists,
        truncated: false,
        window,
        links_available: true,
      };

    const [parties, tags, dates, bindings] = await Promise.all([
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
      readLiveBindings(ctx.vault, partyIds),
    ]);

    const partyRows = (parties.rows ?? []) as unknown as RawParty[];
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const dateRows = (dates.rows ?? []) as unknown as RawDate[];

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
