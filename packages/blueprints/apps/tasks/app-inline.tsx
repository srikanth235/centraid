import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import { tasksPendingProjection as pendingProjection } from "./pending-projection.ts";
import boardQuery from "./queries/board.ts";
import searchQuery from "./queries/search.ts";

const tasksInlineApp: InlineAppModule = {
  appId: "tasks",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  multiScope: true,
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
