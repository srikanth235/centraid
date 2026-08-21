// People, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).
//
// `Root` is currently a WALL (see app-root.tsx): People's desktop UI was
// removed pending its Binding Layer v11 design handoff. Everything else in this
// descriptor is live and deliberately untouched — the seven queries still run
// against the replica, and `kitAsk` below is, for now, the only way a member
// reaches this app's data from the shell. The rebuild replaces `Root` and
// restores `CHANGE_TABLES`; nothing else here has to move.

import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import pendingProjection from "./pending-projection.ts";
import dashboardQuery from "./queries/dashboard.ts";
import historyQuery from "./queries/history.ts";
import journalQuery from "./queries/journal.ts";
import peopleQuery from "./queries/people.ts";
import personQuery from "./queries/person.ts";
import searchQuery from "./queries/search.ts";
import trashQuery from "./queries/trash.ts";

const peopleInlineApp: InlineAppModule = {
  appId: "people",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  // Query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    people: { default: peopleQuery },
    search: { default: searchQuery },
    person: { default: personQuery },
    journal: { default: journalQuery },
    dashboard: { default: dashboardQuery },
    trash: { default: trashQuery },
    history: { default: historyQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "people",
    placeholder: "Ask about your people…",
    intro: "Ask me to add someone, log a call, or find who you owe a reply.",
    suggest: [
      "Who should I reconnect with?",
      "Log a call with Maya",
      "Whose birthday is next?",
    ],
  },
  Root,
};

export default peopleInlineApp;
