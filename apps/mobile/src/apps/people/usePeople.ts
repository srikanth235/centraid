// People's read layer on the phone: local replica queries projected into the
// row shapes the web query emitters serve (`people-model.ts` names mirrors).
//
// THE SHARING PLANE STAYS OUT OF THE COMBINED STATE: `share.*` scopes deny
// independently, so a denial degrades LINK FACTS to absent rather than
// carding the whole roster as an error (decisions.md #821 L-read).

import { useMemo } from "react";

import type { DashboardData } from "@centraid/blueprints/apps/people/types";

import { combineReplicaQueryStates } from "../../kit/hooks/replica-query-state";
import type { ReplicaQueryState } from "../../kit/hooks/replica-query-state";
import { useSeatWindow } from "../../kit/hooks/useSeatPages";
import { MOBILE_ENTITY_READ_WINDOW } from "../../lib/replica/offline-budgets";
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
import {
  activityLinksTo,
  annotationsOn,
  datesFor,
  PEOPLE_ACTIVITIES,
  PEOPLE_BINDINGS,
  PEOPLE_CHANNELS,
  PEOPLE_CONCEPTS,
  PEOPLE_DATES,
  PEOPLE_PARTIES,
  PEOPLE_PARTY_TAGS,
  PEOPLE_PROFILES,
  PEOPLE_SCHEMES,
} from "./people-queries";
import { projectShareLinks } from "./people-share-model";

const APP = "people";

/** The year-3 window, named once for every read on this screen. */
function window(entity: string, rowIdColumn: string) {
  return { entity, rowIdColumn, limit: MOBILE_ENTITY_READ_WINDOW };
}

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
  const profiles = useSeatWindow(
    APP,
    PEOPLE_PROFILES,
    window("people.profile", "profile_id")
  );
  const parties = useSeatWindow(
    APP,
    PEOPLE_PARTIES,
    window("core.party", "party_id")
  );
  const tags = useSeatWindow(
    APP,
    PEOPLE_PARTY_TAGS,
    window("core.tag", "tag_id")
  );
  const concepts = useSeatWindow(
    APP,
    PEOPLE_CONCEPTS,
    window("core.concept", "concept_id")
  );
  const schemes = useSeatWindow(
    APP,
    PEOPLE_SCHEMES,
    window("core.concept_scheme", "scheme_id")
  );
  const dates = useSeatWindow(
    APP,
    PEOPLE_DATES,
    window("people.important_date", "date_id")
  );
  const partyNotes = useSeatWindow(
    APP,
    useMemo(() => annotationsOn("core.party"), []),
    window("knowledge.annotation", "annotation_id")
  );
  const activityLinks = useSeatWindow(
    APP,
    useMemo(() => activityLinksTo(), []),
    window("core.link", "link_id")
  );
  const activities = useSeatWindow(
    APP,
    PEOPLE_ACTIVITIES,
    window("core.activity", "activity_id")
  );
  const activityNotes = useSeatWindow(
    APP,
    useMemo(() => annotationsOn("core.activity"), []),
    window("knowledge.annotation", "annotation_id")
  );
  // The one share read the roster needs. NOT in the combined state below.
  const bindings = useSeatWindow(
    APP,
    PEOPLE_BINDINGS,
    window("share.party_vault_binding", "binding_id")
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
  const channels = useSeatWindow(
    APP,
    PEOPLE_CHANNELS,
    window("social.contact_channel", "channel_id")
  );
  const partyNotes = useSeatWindow(
    APP,
    useMemo(() => annotationsOn("core.party", partyId), [partyId]),
    window("knowledge.annotation", "annotation_id")
  );
  const activityLinks = useSeatWindow(
    APP,
    useMemo(() => activityLinksTo(partyId), [partyId]),
    window("core.link", "link_id")
  );
  const activities = useSeatWindow(
    APP,
    PEOPLE_ACTIVITIES,
    window("core.activity", "activity_id")
  );
  const activityNotes = useSeatWindow(
    APP,
    useMemo(() => annotationsOn("core.activity"), []),
    window("knowledge.annotation", "annotation_id")
  );
  const concepts = useSeatWindow(
    APP,
    PEOPLE_CONCEPTS,
    window("core.concept", "concept_id")
  );
  const parties = useSeatWindow(
    APP,
    PEOPLE_PARTIES,
    window("core.party", "party_id")
  );
  const dates = useSeatWindow(
    APP,
    useMemo(() => datesFor(partyId), [partyId]),
    window("people.important_date", "date_id")
  );

  // Sharing plane tables: each degrades alone; `projectShareLinks` nulls when
  // either is missing. No commons-grant join (#825); standing grants read
  // live in `PersonGrants.tsx`.
  const bindings = useSeatWindow(
    APP,
    PEOPLE_BINDINGS,
    window("share.party_vault_binding", "binding_id")
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
    () =>
      projectShareLinks({
        partyId,
        bindings: bindingRows,
      }),
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
