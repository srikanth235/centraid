import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import { lockerPendingProjection as pendingProjection } from "./pending-projection.ts";
import authQuery from "./queries/auth.ts";
import itemQuery from "./queries/item.ts";
import itemsQuery from "./queries/items.ts";
import searchQuery from "./queries/search.ts";
import trashQuery from "./queries/trash.ts";

const lockerInlineApp: InlineAppModule = {
  appId: "locker",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  queries: {
    auth: { default: authQuery },
    items: { default: itemsQuery },
    item: { default: itemQuery },
    search: { default: searchQuery },
    trash: { default: trashQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "locker",
    placeholder: "Ask your locker…",
    intro: "Ask me to find a login, add a card, or generate a strong password.",
    suggest: [
      "Find my GitHub login",
      "Add a new credit card",
      "Which passwords are weak?",
    ],
  },
  Root,
};

export default lockerInlineApp;
