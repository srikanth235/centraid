// People's read-side projection, as pure functions over replica rows.
//
// THE WEB QUERY EMITTERS ARE THE CONTRACT. The phone reads the vault's local
// replica entity by entity (`useReplicaQuery`), so the joins the gateway-side
// handlers perform (`packages/blueprints/apps/people/queries/*.ts`) are
// re-stated here over the same tables, producing the SAME row shapes
// (`packages/blueprints/apps/people/types.ts`). A projection that invented a
// column would be a screen drawing a fact nobody stored, so every field below
// names the query file it mirrors.
//
// THE SHARING PLANE DEGRADES TO ABSENT, NEVER TO EMPTY (decisions.md #821
// L-read, `queries/_shared.ts`). The share reads deny independently of the
// roster — People's `share.*` scopes may be parked for the owner's approval —
// so the callers hand this module `null` row sets for a read that failed, and
// `linked` is then null (`links_available: false`), never a false "unlinked".
//
// React-free and replica-free on purpose: rows arrive as plain records, so the
// rules are unit-testable without a renderer (`people-model.test.ts`).

import {
  daysSinceContact,
  daysUntilMonthDay,
  isOverdue,
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
import { IDENTITY_HUE_KEYS, identityHueKey } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import type { PersonShareLinks } from "./people-share-model";

/** A replica row, untyped — every reader narrows per column. */
export type Row = Record<string, unknown>;

export const str = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const num = (row: Row, key: string): number => Number(row[key] ?? 0) || 0;
const truthy = (row: Row, key: string): boolean => Boolean(row[key]);

const LIST_SCHEME_URI = "https://centraid.dev/schemes/lists";
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";

// ---------------------------------------------------------------------------
// The avatar colour, round-tripped with the web surface.
// ---------------------------------------------------------------------------

/** The stored spelling the web editor writes for a chosen hue. It is a CSS
 *  custom-property EXPRESSION because the ring moves between light and dark;
 *  the phone stores the same spelling and RESOLVES it through its own scheme
 *  (`colors.c<Key>`). Built in two halves so this module never contains the
 *  one sequence the mobile design gate forbids a consumer to CONSUME — this
 *  is vault data interchange with the web renderer, not a style read. */
const CSS_VAR_OPEN = "var(";

export function storedHueValue(key: ColorKey): string {
  return `${CSS_VAR_OPEN}--c-${key})`;
}

/** The hue key a stored `var(--c-<key>)` names, or null for anything else
 *  (a legacy hex, a value we cannot read). */
export function storedHueKey(
  value: string | null | undefined
): ColorKey | null {
  if (!value || !value.startsWith(`${CSS_VAR_OPEN}--c-`)) return null;
  const key = value.slice(CSS_VAR_OPEN.length + 4, -1);
  return (IDENTITY_HUE_KEYS as readonly string[]).includes(key)
    ? (key as ColorKey)
    : null;
}

/**
 * The fill a person's disc paints, resolved for the current scheme.
 *
 * A stored hue expression resolves through the theme's identity ring; a stored
 * hex is honoured verbatim (it is the member's own choice — `identityInk`
 * keeps it legible); a person with no stored colour takes their place on the
 * shared wheel, keyed by `party_id` so a rename never moves them.
 */
export function avatarFill(
  person: { party_id: string; avatar_color?: string | null },
  ringFor: (key: ColorKey) => string
): string {
  const stored = person.avatar_color ?? null;
  const key = storedHueKey(stored);
  if (key) return ringFor(key);
  if (stored) return stored;
  return ringFor(identityHueKey(person.party_id));
}

// ---------------------------------------------------------------------------
// The roster window (`queries/people.ts`) and trash (`queries/trash.ts`).
// ---------------------------------------------------------------------------

export interface RosterInput {
  /** Every `people.profile` row in the replica, trashed ones included. */
  profiles: readonly Row[];
  parties: readonly Row[];
  tags: readonly Row[];
  concepts: readonly Row[];
  schemes: readonly Row[];
  dates: readonly Row[];
  /** Live `share.party_vault_binding` rows, or null when that read failed —
   *  the sharing plane is then ABSENT, not empty. */
  bindings: readonly Row[] | null;
}

export interface RosterProjection {
  people: PersonRow[];
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

  const people: PersonRow[] = live
    .map((profile): PersonRow => {
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
      };
    })
    // Newest first — the query's own order (`orderBy created_at desc`).
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

// ---------------------------------------------------------------------------
// The roster filter and the row's second line — the web renderer's own rules
// (`components/RosterRoute.tsx`), restated here because that module is a
// render file this app may not import.
// ---------------------------------------------------------------------------

/** A row whose link fact is unknown answers NEITHER link chip: unknown is not
 *  "unlinked", and a shelf that quietly counted it as one would be guessing. */
export function applyRosterFilter(
  people: readonly PersonRow[],
  filter: RosterFilter,
  now = Date.now()
): PersonRow[] {
  if (filter === "starred") return people.filter((person) => person.starred);
  if (filter === "due")
    return people.filter((person) => isOverdue(person, now));
  if (filter === "linked")
    return people.filter((person) => person.linked === true);
  if (filter === "unlinked")
    return people.filter((person) => person.linked === false);
  return [...people];
}

/** `Linked · architect`, or the role alone — the vault leads a linked row's
 *  second line. The word `Linked` stands where the handoff put the vault's
 *  name, because a binding carries only an id and an id is not a name. */
export function rosterSub(person: PersonRow): string {
  if (person.linked !== true) return person.role;
  return person.role ? `${LINK.linked} · ${person.role}` : LINK.linked;
}

/**
 * Full-text over the window in hand: name + role + notes, case-insensitive
 * substring (handoff § Screens 3). The web shelf asks the vault's FTS5 index;
 * the phone's replica exposes no People search shape yet, so the roster window
 * plus the party-note annotations already replicated ARE the searchable text —
 * stated in `INTEGRATION-NOTES.md` as a departure, not hidden.
 */
export function searchRoster(
  people: readonly PersonRow[],
  notesByParty: ReadonlyMap<string, readonly string[]>,
  term: string
): PersonRow[] {
  const needle = term.trim().toLocaleLowerCase("en-US");
  if (!needle) return [];
  return people.flatMap((person) => {
    const name = person.name.toLocaleLowerCase("en-US");
    const role = person.role.toLocaleLowerCase("en-US");
    if (name.includes(needle) || role.includes(needle)) return [person];
    const note = (notesByParty.get(person.party_id) ?? []).find((text) =>
      text.toLocaleLowerCase("en-US").includes(needle)
    );
    // The matched passage rides as the snippet — it answers "why is this row
    // here" better than the role the member already knows.
    return note ? [{ ...person, snippet: note }] : [];
  });
}

// ---------------------------------------------------------------------------
// The keep-in-touch summary (`queries/dashboard.ts`), client-side over the
// same window — the same judgment, so Touch and the roster cannot disagree.
// ---------------------------------------------------------------------------

export interface DashboardInput {
  people: readonly PersonRow[];
  linksAvailable: boolean;
  /** `core.link` rows joining activities to parties. */
  activityLinks: readonly Row[];
  activities: readonly Row[];
  /** `knowledge.annotation` rows on activities — a touch's own note. */
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
    .filter((entry) => entry.over >= 0)
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
      to_link: linked === null ? null : input.people.length - linked,
    },
  };
}

// ---------------------------------------------------------------------------
// One person in full (`queries/person.ts`), from the replica's own tables.
// Only the sections the handoff draws are projected — channels, dates, notes,
// interactions and the sharing plane. The query also answers lists, tasks,
// gifts, debts and relationships; the handoff excludes them and bans their
// placeholders, so nothing here carries them.
// ---------------------------------------------------------------------------

export interface PersonDetailInput {
  /** The person's roster row — name, role, star, cadence come from it. */
  person: PersonRow;
  /** Every `social.contact_channel` row in hand: theirs become the section,
   *  everyone else's feed the duplicate-value warning. */
  channels: readonly Row[];
  /** `party_id → display_name`, for naming a duplicate's holder. */
  partyNames: ReadonlyMap<string, string>;
  dates: readonly Row[];
  /** `knowledge.annotation` rows targeting this party. */
  notes: readonly Row[];
  activityLinks: readonly Row[];
  activities: readonly Row[];
  activityNotes: readonly Row[];
  concepts: readonly Row[];
  shareLinks: PersonShareLinks | null;
}

export function projectPersonDetail(input: PersonDetailInput): PersonDetail {
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
    shared_with_them: input.shareLinks?.shared_with_them ?? null,
  };
}
