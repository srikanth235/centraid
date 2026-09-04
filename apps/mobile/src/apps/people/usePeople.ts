// People's read layer on the phone: local replica queries projected into the
// row shapes the web query emitters serve (`people-model.ts` names mirrors).
//
// THE SHARING PLANE STAYS OUT OF THE COMBINED STATE: `share.*` scopes deny
// independently, so a denial degrades LINK FACTS to absent rather than
// carding the whole roster as an error (decisions.md #821 L-read).

import { useMemo } from "react";

import type { DashboardData } from "@centraid/blueprints/apps/people/types";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import type { ReplicaQueryState } from "../../kit/hooks/useReplicaQuery";
import {
  projectDashboard,
  projectPersonDetail,
  projectRoster,
} from "./people-model";
import type {
  MobilePersonDetail,
  MobilePersonRow,
  RosterProjection,
  Row,
} from "./people-model";
import { projectShareLinks } from "./people-share-model";

const APP = "people";

/** Share rows, or null while unanswered — loading and denial draw ABSENT, never "nobody". */
function shareRows(state: ReplicaQueryState): Row[] | null {
  if (state.error) return null;
  if (state.loading) return null;
  return state.rows;
}

export interface PeopleData extends RosterProjection {
  loading: boolean;
  error?: string;
  connection: ReplicaQueryState["connection"];
  unavailableReason?: string;
  /** Party-note texts by party, for the search shelf's notes scope. */
  notesByParty: ReadonlyMap<string, readonly string[]>;
  dashboard: DashboardData;
}

/** Roster window, trash shelf, keep-in-touch and note search in one hook:
 * one screen, shared underlying reads. */
export function usePeople(): PeopleData {
  const profiles = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "people.profile" }), [])
  );
  const parties = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "core.party" }), [])
  );
  const tags = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "core.tag",
        where: [
          { column: "target_type", op: "eq" as const, value: "core.party" },
        ],
      }),
      []
    )
  );
  const concepts = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "core.concept" }), [])
  );
  const schemes = useReplicaQuery(
    APP,
    useMemo(
      () => ({ acceptTruncation: true, entity: "core.concept_scheme" }),
      []
    )
  );
  const dates = useReplicaQuery(
    APP,
    useMemo(
      () => ({ acceptTruncation: true, entity: "people.important_date" }),
      []
    )
  );
  const partyNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "knowledge.annotation",
        where: [
          { column: "target_type", op: "eq" as const, value: "core.party" },
        ],
      }),
      []
    )
  );
  const activityLinks = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "core.link",
        where: [
          { column: "from_type", op: "eq" as const, value: "core.activity" },
          { column: "to_type", op: "eq" as const, value: "core.party" },
        ],
      }),
      []
    )
  );
  const activities = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "core.activity" }), [])
  );
  const activityNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "knowledge.annotation",
        where: [
          { column: "target_type", op: "eq" as const, value: "core.activity" },
        ],
      }),
      []
    )
  );
  // The one share read the roster needs. NOT in the combined state below.
  const bindings = useReplicaQuery(
    APP,
    useMemo(
      () => ({ acceptTruncation: true, entity: "share.party_vault_binding" }),
      []
    )
  );

  const queryState = combineReplicaQueryStates([
    profiles,
    parties,
    tags,
    concepts,
    schemes,
    dates,
    partyNotes,
    activityLinks,
    activities,
    activityNotes,
  ]);

  const bindingRows = shareRows(bindings);
  const roster = useMemo(
    () =>
      projectRoster({
        profiles: profiles.rows,
        parties: parties.rows,
        tags: tags.rows,
        concepts: concepts.rows,
        schemes: schemes.rows,
        dates: dates.rows,
        bindings: bindingRows,
      }),
    [
      bindingRows,
      concepts.rows,
      dates.rows,
      parties.rows,
      profiles.rows,
      schemes.rows,
      tags.rows,
    ]
  );

  const notesByParty = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of partyNotes.rows) {
      const party = row.target_id;
      const text = row.body_text;
      if (typeof party !== "string" || typeof text !== "string") continue;
      const list = map.get(party) ?? [];
      list.push(text);
      map.set(party, list);
    }
    return map;
  }, [partyNotes.rows]);

  const dashboard = useMemo(
    () =>
      projectDashboard({
        people: roster.people,
        linksAvailable: roster.linksAvailable,
        activityLinks: activityLinks.rows,
        activities: activities.rows,
        activityNotes: activityNotes.rows,
        concepts: concepts.rows,
      }),
    [
      activities.rows,
      activityLinks.rows,
      activityNotes.rows,
      concepts.rows,
      roster.linksAvailable,
      roster.people,
    ]
  );

  return {
    ...roster,
    notesByParty,
    dashboard,
    loading: queryState.loading,
    connection: queryState.connection,
    ...(queryState.error ? { error: queryState.error } : {}),
    ...(queryState.unavailableReason
      ? { unavailableReason: queryState.unavailableReason }
      : {}),
  };
}

export interface PersonData {
  loading: boolean;
  error?: string;
  connection: ReplicaQueryState["connection"];
  unavailableReason?: string;
  /** Null past loading = the id no longer resolves (trashed or merged away). */
  person: MobilePersonDetail | null;
  /** The roster window found in; handed to the share sheet as audience list (#825). */
  roster: readonly MobilePersonRow[];
}

/** One person in full: rides `usePeople()`'s window for identity, star and
 * cadence, plus per-person tables. */
export function usePerson(partyId: string): PersonData {
  const people = usePeople();
  const channels = useReplicaQuery(
    APP,
    useMemo(
      () => ({ acceptTruncation: true, entity: "social.contact_channel" }),
      []
    )
  );
  const partyNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "knowledge.annotation",
        where: [
          { column: "target_type", op: "eq" as const, value: "core.party" },
          { column: "target_id", op: "eq" as const, value: partyId },
        ],
      }),
      [partyId]
    )
  );
  const activityLinks = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "core.link",
        where: [
          { column: "from_type", op: "eq" as const, value: "core.activity" },
          { column: "to_type", op: "eq" as const, value: "core.party" },
          { column: "to_id", op: "eq" as const, value: partyId },
        ],
      }),
      [partyId]
    )
  );
  const activities = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "core.activity" }), [])
  );
  const activityNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "knowledge.annotation",
        where: [
          { column: "target_type", op: "eq" as const, value: "core.activity" },
        ],
      }),
      []
    )
  );
  const concepts = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "core.concept" }), [])
  );
  const parties = useReplicaQuery(
    APP,
    useMemo(() => ({ acceptTruncation: true, entity: "core.party" }), [])
  );
  const dates = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        acceptTruncation: true,
        entity: "people.important_date",
        where: [{ column: "party_id", op: "eq" as const, value: partyId }],
      }),
      [partyId]
    )
  );

  // Sharing plane tables: each degrades alone; `projectShareLinks` nulls when
  // either is missing. No commons-grant join (#825); standing grants read
  // live in `PersonGrants.tsx`.
  const bindings = useReplicaQuery(
    APP,
    useMemo(
      () => ({ acceptTruncation: true, entity: "share.party_vault_binding" }),
      []
    )
  );
  const queryState = combineReplicaQueryStates([
    channels,
    partyNotes,
    activityLinks,
    activities,
    activityNotes,
    concepts,
    parties,
    dates,
  ]);
  const loading = people.loading || queryState.loading;

  const bindingRows = shareRows(bindings);
  const shareLinks = useMemo(
    () => projectShareLinks({ partyId, bindings: bindingRows }),
    [bindingRows, partyId]
  );

  const partyNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of parties.rows) {
      const id = row.party_id;
      const name = row.display_name;
      if (typeof id === "string" && typeof name === "string") map.set(id, name);
    }
    return map;
  }, [parties.rows]);

  const personRow = people.people.find((row) => row.party_id === partyId);
  const person = useMemo(() => {
    if (!personRow) return null;
    return projectPersonDetail({
      person: personRow,
      channels: channels.rows,
      partyNames,
      dates: dates.rows,
      notes: partyNotes.rows,
      activityLinks: activityLinks.rows,
      activities: activities.rows,
      activityNotes: activityNotes.rows,
      concepts: concepts.rows,
      shareLinks,
    });
  }, [
    activities.rows,
    activityLinks.rows,
    activityNotes.rows,
    channels.rows,
    concepts.rows,
    dates.rows,
    partyNames,
    partyNotes.rows,
    personRow,
    shareLinks,
  ]);

  const error = people.error ?? queryState.error;
  return {
    loading,
    connection: queryState.connection,
    ...(error ? { error } : {}),
    ...(queryState.unavailableReason
      ? { unavailableReason: queryState.unavailableReason }
      : {}),
    person,
    roster: people.people,
  };
}
