// People's read layer on the phone: the local replica, entity by entity,
// projected into the same row shapes the web query emitters serve
// (`people-model.ts` names the mirrors). The shape every native read layer
// here takes — several
// `useReplicaQuery(appId, request)` calls, one combined state, one memoized
// projection.
//
// THE SHARING PLANE IS KEPT OUT OF THE COMBINED STATE. People's `share.*`
// scopes deny independently (they may be parked for the owner's approval on an
// existing vault), and a denial must degrade the LINK FACTS to absent — null,
// drawing nothing — rather than carding the whole roster as an error
// (decisions.md #821 L-read). So the share reads' errors are consumed here,
// turned into `null` row sets for the projection, and never surface as the
// screen's own error.

import { useMemo } from "react";

import type {
  DashboardData,
  PersonDetail,
  PersonRow,
} from "@centraid/blueprints/apps/people/types";

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
import type { RosterProjection, Row } from "./people-model";
import { projectShareLinks } from "./people-share-model";

const APP = "people";

/** A share-plane read's rows, or null while the read has not honestly
 *  answered — loading and denial both draw as ABSENT, never as "nobody". */
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

/**
 * The roster window, the trash shelf, the keep-in-touch summary and the
 * searchable note texts — one hook, because all three destinations live on
 * one screen and share every underlying read.
 */
export function usePeople(): PeopleData {
  const profiles = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "people.profile" }), [])
  );
  const parties = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const tags = useReplicaQuery(
    APP,
    useMemo(
      () => ({
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
    useMemo(() => ({ entity: "core.concept" }), [])
  );
  const schemes = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "core.concept_scheme" }), [])
  );
  const dates = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "people.important_date" }), [])
  );
  const partyNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
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
    useMemo(() => ({ entity: "core.activity" }), [])
  );
  const activityNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
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
    useMemo(() => ({ entity: "share.party_vault_binding" }), [])
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
  /** Null past the loading gate means the id no longer resolves to a live
   *  person (trashed or merged away in the meantime). */
  person: PersonDetail | null;
  /** The roster window this person was found in. The grant dashboard hands it
   *  to the share sheet as the audience list: People is where a party id has
   *  a name (#825), and it is already in hand here — a second read of the
   *  same rows would be the same window twice. */
  roster: readonly PersonRow[];
}

/**
 * One person in full. Rides on `usePeople()`'s window for identity, star and
 * cadence, and adds the per-person tables: channels, notes, interactions and
 * the sharing plane (which degrades to absent, per the module head).
 */
export function usePerson(partyId: string): PersonData {
  const people = usePeople();
  const channels = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "social.contact_channel" }), [])
  );
  const partyNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
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
    useMemo(() => ({ entity: "core.activity" }), [])
  );
  const activityNotes = useReplicaQuery(
    APP,
    useMemo(
      () => ({
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
    useMemo(() => ({ entity: "core.concept" }), [])
  );
  const parties = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const dates = useReplicaQuery(
    APP,
    useMemo(
      () => ({
        entity: "people.important_date",
        where: [{ column: "party_id", op: "eq" as const, value: partyId }],
      }),
      [partyId]
    )
  );

  // The sharing plane's two tables — each degrades to absent on its own, and
  // `projectShareLinks` nulls the whole answer when either is missing. The
  // commons-grant join that used to sit beside them retired with the
  // `shared_with_them` projection (#825); standing grants are read live from
  // the grant plane by `PersonGrants.tsx`.
  const bindings = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "share.party_vault_binding" }), [])
  );
  const invitations = useReplicaQuery(
    APP,
    useMemo(() => ({ entity: "share.commons_invitation" }), [])
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
  const invitationRows = shareRows(invitations);
  const shareLinks = useMemo(
    () =>
      projectShareLinks({
        partyId,
        bindings: bindingRows,
        invitations: invitationRows,
      }),
    [bindingRows, invitationRows, partyId]
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
