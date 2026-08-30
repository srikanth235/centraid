// Notes, inline descriptor (#505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

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
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    library: { default: libraryQuery },
    "link-targets": { default: linkTargetsQuery },
    history: { default: historyQuery },
    // The Journal place — read-only, include-only over the People-journal
    // scheme the other three projections exclude (#834 R-journal).
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
