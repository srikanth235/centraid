import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import { docsPendingProjection as pendingProjection } from "./pending-projection.ts";
import activityQuery from "./queries/activity.ts";
import driveQuery from "./queries/drive.ts";
import historyQuery from "./queries/history.ts";
import searchQuery from "./queries/search.ts";

const docsInlineApp: InlineAppModule = {
  appId: "docs",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  queries: {
    drive: { default: driveQuery },
    search: { default: searchQuery },
    activity: { default: activityQuery },
    history: { default: historyQuery },
  } as unknown as InlineAppModule["queries"],
  Root,
};

export default docsInlineApp;
