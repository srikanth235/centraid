import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import { notesPendingProjection as pendingProjection } from "./pending-projection.ts";
import historyQuery from "./queries/history.ts";
import journalQuery from "./queries/journal.ts";
import libraryQuery from "./queries/library.ts";
import linkTargetsQuery from "./queries/link-targets.ts";
import noteQuery from "./queries/note.ts";
import searchQuery from "./queries/search.ts";

const notesInlineApp: InlineAppModule = {
  appId: "notes",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  queries: {
    library: { default: libraryQuery },
    "link-targets": { default: linkTargetsQuery },
    history: { default: historyQuery },
    journal: { default: journalQuery },
    note: { default: noteQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "notes",
    placeholder: "Ask your notes…",
    intro: "Ask me to write, find, summarise or file a note.",
    suggest: [
      "Summarise my Q3 roadmap note",
      "New note from this",
      "What did I note about the offline story?",
    ],
  },
  Root,
};

export default notesInlineApp;
