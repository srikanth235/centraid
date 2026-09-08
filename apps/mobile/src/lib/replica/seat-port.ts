// WHAT A SCREEN MAY DO WITH THE PHONE'S SEAT (#996 wave 4b, ruling W5-D1).
//
// Two methods, and a module of its own so that naming them costs nothing.
// These types used to live beside `buildNativeInlineCtx`, which is where they
// are USED — but a type import is still an edge in the module graph every
// bundler and linter walks, and the ctx builder pulls the whole inline query
// runtime behind it. The camera-roll watcher, the replica context and the
// Photos engine all need to say "a seat" and none of them needs any of that.

import type {
  InlinePage,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";
import type { SeatSearchRequest } from "@centraid/client/replica/seat/search-page";

export interface NativeSeatPagePort {
  page: InlinePage;
  /**
   * One ranked window over the seat's own copy (W5-D1). The vault's FTS shadow
   * tables came across in the bootstrap and are kept by the same triggers, so a
   * search is a statement over this file rather than a second store.
   */
  search: (request: SeatSearchRequest) => Promise<ReplicaSearchWireResult>;
}
