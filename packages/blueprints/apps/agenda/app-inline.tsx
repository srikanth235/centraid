// Agenda, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import type { InlineAppModule } from "../inline-types.ts";
import { Root, CHANGE_TABLES } from "./app-root.tsx";
import pendingProjection from "./pending-projection.ts";
import partiesQuery from "./queries/parties.ts";
import searchQuery from "./queries/search.ts";
import upcomingQuery from "./queries/upcoming.ts";

const agendaInlineApp: InlineAppModule = {
  appId: "agenda",
  pendingProjection,
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    upcoming: { default: upcomingQuery },
    search: { default: searchQuery },
    parties: { default: partiesQuery },
  } as unknown as InlineAppModule["queries"],
  kitAsk: {
    scope: "agenda",
    placeholder: "Ask your calendar…",
    intro: "Ask me to schedule, move, find or explain events.",
    suggest: [
      "Book coffee with Dana Thursday at 10",
      "What’s on this week?",
      "Move the dentist to Friday",
    ],
  },
  Root,
};

export default agendaInlineApp;
