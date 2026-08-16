// Tasks, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import pendingProjection from "./pending-projection.ts";
import boardQuery from "./queries/board.ts";
import searchQuery from "./queries/search.ts";

const tasksInlineApp: InlineAppModule = {
  appId: "tasks",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  // Mount over every scope this member can see (issue #726 D11 task 3): the
  // board is the merge of their own open tasks and each audience they
  // belong to, through the shared scope kit (see `scope-declaration.ts` and
  // `app-root.tsx`'s `refresh`) — the same door Photos' timeline already
  // walks (issue #599).
  multiScope: true,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    board: { default: boardQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "tasks",
    placeholder: "Ask your tasks…",
    intro: "Ask me to add, complete, reschedule or find tasks.",
    suggest: [
      "Add “call mom tomorrow”",
      "What’s due today?",
      "Complete “Send the studio invoice”",
    ],
  },
  Root,
};

export default tasksInlineApp;
