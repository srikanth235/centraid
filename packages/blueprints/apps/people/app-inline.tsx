import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import { peoplePendingProjection as pendingProjection } from "./pending-projection.ts";
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
