// People's read-side projection: pure functions over replica rows.
//
// THE WEB QUERY EMITTERS ARE THE CONTRACT — restate the joins of
// `blueprints/apps/people/queries/*.ts` and invent no column.
//
// THE SHARING PLANE DEGRADES TO ABSENT, NEVER TO EMPTY (decisions.md #821
// L-read): a failed share read arrives as `null` rows, so `linked` is null,
// never a false "unlinked".
import {
  daysSinceContact,
  daysUntilMonthDay,
  isOverdue,
  toLinkCount,
} from "@centraid/blueprints/apps/people/format";
import { LINK } from "@centraid/blueprints/apps/people/people-copy";
import type {
  ContactChannel,
  DashboardData,
  ImportantDate,
  PersonCard,
  PersonDetail,
  PersonNote,
  PersonRow,
  RecentCard,
  RosterFilter,
  TrashedPerson,
  UpcomingCard,
} from "@centraid/blueprints/apps/people/types";
import { IDENTITY_HUE_KEYS } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import { rowCanWrite, rowScopeLabels } from "../../kit/replica/row-provenance";
import type { PersonShareLinks } from "./people-share-model";

export type Row = Record<string, unknown>;

/** A projected person plus the PROFILE row's provenance and pending stamps
 *  (#880) — the canonical role a star or trash takes. */
export type MobilePersonRow = PersonRow & {
  canWrite: boolean;
  scopeLabels: readonly string[];
  raw: Row;
};

export type MobilePersonDetail = PersonDetail & {
  canWrite: boolean;
  scopeLabels: readonly string[];
  raw: Row;
};

export const str = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const num = (row: Row, key: string): number => Number(row[key] ?? 0) || 0;
const truthy = (row: Row, key: string): boolean => Boolean(row[key]);

const LIST_SCHEME_URI = "https://centraid.dev/schemes/lists";
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";

const CSS_VAR_OPEN = "var(";

export function storedHueValue(key: ColorKey): string {
  return `${CSS_VAR_OPEN}--c-${key})`;
}

export function storedHueKey(
  value: string | null | undefined
): ColorKey | null {
  if (!value || !value.startsWith(`${CSS_VAR_OPEN}--c-`)) return null;
  const key = value.slice(CSS_VAR_OPEN.length + 4, -1);
  return (IDENTITY_HUE_KEYS as readonly string[]).includes(key)
    ? (key as ColorKey)
    : null;
}

export interface RosterInput {
  profiles: readonly Row[];
  parties: readonly Row[];
  tags: readonly Row[];
  concepts: readonly Row[];
  schemes: readonly Row[];
  dates: readonly Row[];
  bindings: readonly Row[] | null;
}

export interface RosterProjection {
  people: MobilePersonRow[];
  trash: TrashedPerson[];
  lists: Array<{ list_id: string; name: string }>;
  linksAvailable: boolean;
}

export function projectRoster(input: RosterInput): RosterProjection {
  const schemeId = (uri: string): string | null => {
    const scheme = input.schemes.find((row) => str(row, "uri") === uri);
    return scheme ? str(scheme, "scheme_id") : null;
  };
  const listSchemeId = schemeId(LIST_SCHEME_URI);
  const flagsSchemeId = schemeId(FLAGS_SCHEME_URI);
  const listConcepts = input.concepts.filter(
    (row) => listSchemeId !== null && str(row, "scheme_id") === listSchemeId
  );
  const listConceptIds = new Set(
    listConcepts.map((row) => str(row, "concept_id"))
  );
  const starredConceptId =
    flagsSchemeId === null
      ? null
      : (input.concepts.find(
          (row) =>
            str(row, "scheme_id") === flagsSchemeId &&
            str(row, "notation") === "starred"
        ) ?? null);

  const nameById = new Map<string, string>();
  for (const party of input.parties) {
    const id = str(party, "party_id");
    const name = str(party, "display_name");
    if (id && name) nameById.set(id, name);
  }

  const listByParty = new Map<string, string>();
  const starred = new Set<string>();
  const starId = starredConceptId ? str(starredConceptId, "concept_id") : null;
  for (const tag of input.tags) {
    if (str(tag, "target_type") !== "core.party") continue;
    const target = str(tag, "target_id");
    const concept = str(tag, "concept_id");
    if (!target || !concept) continue;
    if (listConceptIds.has(concept)) listByParty.set(target, concept);
    if (starId !== null && concept === starId) starred.add(target);
  }

  const remindersByParty = new Map<
    string,
    Array<{ date_id: string; label: string; month_day: string }>
  >();
  for (const date of input.dates) {
    if (str(date, "deleted_at")) continue;
    if (!truthy(date, "reminder_on")) continue;
    const party = str(date, "party_id");
    const dateId = str(date, "date_id");
    if (!party || !dateId) continue;
    const list = remindersByParty.get(party) ?? [];
    list.push({
      date_id: dateId,
      label: str(date, "label") ?? "",
      month_day: str(date, "month_day") ?? "",
    });
    remindersByParty.set(party, list);
  }

  const linksAvailable = input.bindings !== null;
  const vaultCountByParty = new Map<string, number>();
  for (const binding of input.bindings ?? []) {
    if (str(binding, "revoked_at")) continue;
    const party = str(binding, "party_id");
    if (!party) continue;
    vaultCountByParty.set(party, (vaultCountByParty.get(party) ?? 0) + 1);
  }

  const live = input.profiles.filter((row) => !str(row, "deleted_at"));
  const gone = input.profiles.filter((row) => str(row, "deleted_at"));

  const people: MobilePersonRow[] = live
    .map((profile): MobilePersonRow => {
      const partyId = str(profile, "party_id") ?? "";
      return {
        party_id: partyId,
        name: nameById.get(partyId) ?? "—",
        role: str(profile, "role") ?? "",
        avatar_color: str(profile, "avatar_color"),
        cadence_days: num(profile, "cadence_days"),
        last_contacted_at: str(profile, "last_contacted_at"),
        created_at: str(profile, "created_at") ?? "",
        list_id: listByParty.get(partyId) ?? null,
        starred: starred.has(partyId),
        reminders: remindersByParty.get(partyId) ?? [],
        linked: linksAvailable ? vaultCountByParty.has(partyId) : null,
        vault_count: vaultCountByParty.get(partyId) ?? 0,
        canWrite: rowCanWrite(profile),
        scopeLabels: rowScopeLabels(profile),
        raw: profile,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const trash: TrashedPerson[] = gone
    .map((profile) => {
      const partyId = str(profile, "party_id") ?? "";
      return {
        party_id: partyId,
        name: nameById.get(partyId) ?? "—",
        role: str(profile, "role") ?? "",
        purge_at: str(profile, "purge_at"),
        deleted_at: str(profile, "deleted_at") ?? "",
      };
    })
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))
    .map(({ deleted_at: _deletedAt, ...person }) => person);

  const lists = listConcepts
    .flatMap((row) => {
      const id = str(row, "concept_id");
      if (!id) return [];
      return [{ list_id: id, name: str(row, "pref_label") ?? "" }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { people, trash, lists, linksAvailable };
}

export function applyRosterFilter<T extends PersonRow>(
  people: readonly T[],
  filter: RosterFilter,
  now = Date.now()
): T[] {
  if (filter === "starred") return people.filter((person) => person.starred);
  if (filter === "due")
    return people.filter((person) => isOverdue(person, now));
  if (filter === "linked")
    return people.filter((person) => person.linked === true);
  if (filter === "unlinked")
    return people.filter((person) => person.linked === false);
  return [...people];
}

export function rosterSub(person: PersonRow): string {
  if (person.linked !== true) return person.role;
  return person.role ? `${LINK.linked} · ${person.role}` : LINK.linked;
}

export function searchRoster<T extends PersonRow>(
  people: readonly T[],
  notesByParty: ReadonlyMap<string, readonly string[]>,
  term: string
): T[] {
  const needle = term.trim().toLocaleLowerCase("en-US");
  if (!needle) return [];
  return people.flatMap((person) => {
    const name = person.name.toLocaleLowerCase("en-US");
    const role = person.role.toLocaleLowerCase("en-US");
    if (name.includes(needle) || role.includes(needle)) return [person];
    const note = (notesByParty.get(person.party_id) ?? []).find((text) =>
      text.toLocaleLowerCase("en-US").includes(needle)
    );
    return note ? [{ ...person, snippet: note }] : [];
  });
}

// The keep-in-touch summary (`queries/dashboard.ts`), judged over the roster
// window so Touch and the roster cannot disagree.
export interface DashboardInput {
  people: readonly PersonRow[];
  linksAvailable: boolean;
  activityLinks: readonly Row[];
  activities: readonly Row[];
  activityNotes: readonly Row[];
  concepts: readonly Row[];
  now?: number;
}

export function projectDashboard(input: DashboardInput): DashboardData {
  const now = input.now ?? Date.now();
  const byId = new Map(input.people.map((person) => [person.party_id, person]));
  const card = (partyId: string): PersonCard => {
    const person = byId.get(partyId);
    return {
      party_id: partyId,
      name: person?.name ?? "—",
      avatar_color: person?.avatar_color ?? null,
      role: person?.role ?? "",
      cadence_days: person?.cadence_days ?? null,
      last_contacted_at: person?.last_contacted_at ?? null,
      created_at: person?.created_at ?? null,
    };
  };

  const reconnect: PersonCard[] = input.people
    .filter((person) => person.cadence_days > 0)
    .map((person) => ({
      person,
      over: daysSinceContact(person, now) - person.cadence_days,
    }))
    .filter((entry) => entry.over > 0)
    .sort((a, b) => b.over - a.over)
    .map((entry) => card(entry.person.party_id));

  const upcoming: UpcomingCard[] = input.people
    .flatMap((person) =>
      person.reminders.map((reminder) => ({
        ...card(person.party_id),
        date_id: reminder.date_id,
        label: reminder.label,
        month_day: reminder.month_day,
        until: daysUntilMonthDay(reminder.month_day, now),
      }))
    )
    .sort((a, b) => a.until - b.until)
    .map(({ until: _until, ...row }) => row);

  const partyByActivity = new Map<string, string>();
  for (const link of input.activityLinks) {
    if (str(link, "from_type") !== "core.activity") continue;
    if (str(link, "to_type") !== "core.party") continue;
    if (str(link, "valid_to")) continue;
    const from = str(link, "from_id");
    const to = str(link, "to_id");
    if (from && to && byId.has(to)) partyByActivity.set(from, to);
  }
  const textByActivity = new Map<string, string>();
  for (const note of input.activityNotes) {
    if (str(note, "target_type") !== "core.activity") continue;
    const target = str(note, "target_id");
    const text = str(note, "body_text");
    if (target && text) textByActivity.set(target, text);
  }
  const kindById = new Map<string, string>();
  for (const concept of input.concepts) {
    const id = str(concept, "concept_id");
    if (id) kindById.set(id, str(concept, "pref_label") ?? "Touch");
  }

  const recent: RecentCard[] = input.activities
    .flatMap((activity) => {
      const activityId = str(activity, "activity_id");
      const partyId = activityId ? partyByActivity.get(activityId) : undefined;
      if (!activityId || !partyId) return [];
      return [
        {
          ...card(partyId),
          interaction_id: activityId,
          kind: kindById.get(str(activity, "kind_concept_id") ?? "") ?? "Touch",
          text: textByActivity.get(activityId) ?? "",
          occurred_at: str(activity, "started_at") ?? "",
        },
      ];
    })
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, 30);

  const linked = input.linksAvailable
    ? input.people.filter((person) => person.linked === true).length
    : null;

  return {
    reconnect,
    upcoming,
    recent,
    counts: {
      all: input.people.length,
      reconnect: reconnect.length,
      upcoming: upcoming.length,
      starred: input.people.filter((person) => person.starred).length,
      linked,
      to_link: toLinkCount(input.people.length, linked),
    },
  };
}

export interface PersonDetailInput {
  person: MobilePersonRow;
  channels: readonly Row[];
  partyNames: ReadonlyMap<string, string>;
  dates: readonly Row[];
  notes: readonly Row[];
  activityLinks: readonly Row[];
  activities: readonly Row[];
  activityNotes: readonly Row[];
  concepts: readonly Row[];
  shareLinks: PersonShareLinks | null;
}

export function projectPersonDetail(
  input: PersonDetailInput
): MobilePersonDetail {
  const partyId = input.person.party_id;

  const theirChannels = input.channels.filter(
    (row) => str(row, "party_id") === partyId
  );
  const contact: ContactChannel[] = theirChannels
    .map((row) => {
      const normalized = str(row, "normalized_value") ?? "";
      const kindRaw = str(row, "kind");
      const kind: ContactChannel["kind"] =
        kindRaw === "phone" ||
        kindRaw === "email" ||
        kindRaw === "address" ||
        kindRaw === "handle"
          ? kindRaw
          : "handle";
      const duplicateIds = input.channels.flatMap((other) => {
        if (str(other, "party_id") === partyId) return [];
        if (str(other, "kind") !== kindRaw) return [];
        if (str(other, "normalized_value") !== normalized) return [];
        const id = str(other, "party_id");
        return id ? [id] : [];
      });
      return {
        channel_id: str(row, "channel_id") ?? undefined,
        kind,
        label: str(row, "label"),
        value: str(row, "value") ?? "",
        normalized_value: normalized,
        preferred: truthy(row, "is_preferred"),
        duplicate_party_ids: duplicateIds,
        duplicate_names: duplicateIds.map(
          (id) => input.partyNames.get(id) ?? id
        ),
      };
    })
    .sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) ||
        a.kind.localeCompare(b.kind) ||
        (a.channel_id ?? "").localeCompare(b.channel_id ?? "")
    );

  const dates: ImportantDate[] = input.dates.flatMap((row) => {
    if (str(row, "party_id") !== partyId) return [];
    if (str(row, "deleted_at")) return [];
    const id = str(row, "date_id");
    if (!id) return [];
    return [
      {
        date_id: id,
        label: str(row, "label") ?? "",
        month_day: str(row, "month_day") ?? "",
        reminder_on: truthy(row, "reminder_on"),
      },
    ];
  });

  const notes: PersonNote[] = input.notes
    .flatMap((row) => {
      if (str(row, "target_type") !== "core.party") return [];
      if (str(row, "target_id") !== partyId) return [];
      const id = str(row, "annotation_id");
      if (!id) return [];
      return [
        {
          annotation_id: id,
          text: str(row, "body_text") ?? "",
          created_at: str(row, "created_at") ?? "",
        },
      ];
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const activityIds = new Set(
    input.activityLinks.flatMap((link) => {
      if (str(link, "from_type") !== "core.activity") return [];
      if (str(link, "to_type") !== "core.party") return [];
      if (str(link, "to_id") !== partyId) return [];
      if (str(link, "valid_to")) return [];
      const id = str(link, "from_id");
      return id ? [id] : [];
    })
  );
  const textByActivity = new Map<string, string>();
  for (const note of input.activityNotes) {
    if (str(note, "target_type") !== "core.activity") continue;
    const target = str(note, "target_id");
    if (target) textByActivity.set(target, str(note, "body_text") ?? "");
  }
  const notationById = new Map<string, string>();
  for (const concept of input.concepts) {
    const id = str(concept, "concept_id");
    if (id) notationById.set(id, str(concept, "notation") ?? "interaction");
  }
  const interactions = input.activities
    .flatMap((activity) => {
      const id = str(activity, "activity_id");
      if (!id || !activityIds.has(id)) return [];
      return [
        {
          interaction_id: id,
          kind:
            notationById.get(str(activity, "kind_concept_id") ?? "") ??
            "interaction",
          text: textByActivity.get(id) ?? "",
          occurred_at: str(activity, "started_at") ?? "",
        },
      ];
    })
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  return {
    party_id: partyId,
    name: input.person.name,
    role: input.person.role,
    avatar_color: input.person.avatar_color,
    cadence_days: input.person.cadence_days,
    last_contacted_at: input.person.last_contacted_at,
    created_at: input.person.created_at,
    met: "",
    starred: input.person.starred,
    contact,
    dates,
    notes,
    interactions,
    vaults: input.shareLinks?.vaults ?? null,
    pending_invites: input.shareLinks?.pending_invites ?? null,
    canWrite: input.person.canWrite,
    scopeLabels: input.person.scopeLabels,
    raw: input.person.raw,
  };
}
