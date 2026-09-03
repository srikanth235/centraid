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
