// Tally, inline descriptor (#505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import { tallyPendingProjection as pendingProjection } from "./pending-projection.ts";
import activityQuery from "./queries/activity.ts";
import dashboardQuery from "./queries/dashboard.ts";
import friendQuery from "./queries/friend.ts";
import groupQuery from "./queries/group.ts";
import historyQuery from "./queries/history.ts";
import searchQuery from "./queries/search.ts";

const tallyInlineApp: InlineAppModule = {
  appId: "tally",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    dashboard: { default: dashboardQuery },
    group: { default: groupQuery },
    friend: { default: friendQuery },
    activity: { default: activityQuery },
    search: { default: searchQuery },
    history: { default: historyQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "tally",
    placeholder: "Ask about your expenses…",
    intro: "Ask me to add an expense, settle up, or see who owes whom.",
    suggest: ["Split dinner four ways", "Who do I owe?", "Settle up with Alex"],
  },
  Root,
};

export default tallyInlineApp;
