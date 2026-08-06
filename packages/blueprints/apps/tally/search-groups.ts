// Grouped hits above Tally's search results (issue #712 S1) — the second
// real consumer of `_shared/search-scaffold.ts`'s `groupSearchHits`, proving
// the scaffold generalises past Photos.
//
// PURE AND HONEST, same discipline as Photos' own `search-groups.ts`: this
// matches only data the dashboard already holds (`dash.groups`,
// `dash.friends` — loaded once, refreshed on every doorbell tick), and a
// group with no real backing data is simply absent. The expense hits
// themselves are NOT one of these entities — they are the primary result
// list (`queries/search.ts`'s server-side FTS match), rendered as
// `SearchScaffold`'s `children`, exactly the way Photos' photo grid is.
//
// group  -> `dash.groups`, matched by name, opens the group view.
// person -> `dash.friends`, matched by name, opens the friend view. "You"
//           is deliberately excluded: searching your own name to find
//           yourself is not a real use of this control, and `dash.friends`
//           never contains the member's own party in the first place.
import type {
  SearchEntity,
  SearchGroupRow,
} from "../_shared/search-scaffold.ts";
import { groupSearchHits } from "../_shared/search-scaffold.ts";
import type { Friend, Group } from "./types.ts";

export interface TallySearchSources {
  groups: readonly Group[];
  friends: readonly Friend[];
}

function matches(term: string, value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(term);
}

const GROUP_ENTITY: SearchEntity<TallySearchSources, SearchGroupRow> = {
  key: "group",
  label: "group",
  match: (term, { groups }) =>
    groups
      .filter((group) => matches(term, group.name))
      .map((group) => ({
        kind: "group",
        key: group.group_id,
        title: group.name,
        meta: `group · ${group.member_count} ${group.member_count === 1 ? "member" : "members"}`,
        openTarget: group.group_id,
      })),
};

const PERSON_ENTITY: SearchEntity<TallySearchSources, SearchGroupRow> = {
  key: "person",
  label: "person",
  match: (term, { friends }) =>
    friends
      .filter((friend) => matches(term, friend.name))
      .map((friend) => ({
        kind: "person",
        key: friend.party_id,
        title: friend.name,
        // No honest per-friend count to put after the noun the way a
        // group's member count or Photos' photograph counts work — a
        // friend's "how much" fact is a balance, not a size, and belongs on
        // the friend view this row opens, not restated here.
        meta: "person",
        openTarget: friend.party_id,
      })),
};

/** The entity list as data (issue #712 S1's "per-app entity lists as
 *  config, not enumeration") — `groupSearchHits` iterates this without ever
 *  naming Tally or these two entities itself. */
export const TALLY_SEARCH_ENTITIES: readonly SearchEntity<
  TallySearchSources,
  SearchGroupRow
>[] = [GROUP_ENTITY, PERSON_ENTITY];

/** The grouped hits for a query, group then person — the order
 *  `TALLY_SEARCH_ENTITIES` declares. Empty for an empty query, same as
 *  Photos' `searchGroups`. */
export function tallySearchGroups(
  query: string,
  sources: TallySearchSources
): SearchGroupRow[] {
  return groupSearchHits(query, sources, TALLY_SEARCH_ENTITIES);
}
