// People, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, CHANGE_TABLES } from './app-root.tsx';
import peopleQuery from './queries/people.ts';
import searchQuery from './queries/search.ts';
import personQuery from './queries/person.ts';
import journalQuery from './queries/journal.ts';
import dashboardQuery from './queries/dashboard.ts';
import type { InlineAppModule } from '../inline-types.ts';

const peopleInlineApp: InlineAppModule = {
  appId: 'people',
  changeTables: CHANGE_TABLES,
  // Query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    people: { default: peopleQuery },
    search: { default: searchQuery },
    person: { default: personQuery },
    journal: { default: journalQuery },
    dashboard: { default: dashboardQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'people',
    placeholder: 'Ask about your people…',
    intro:
      'Ask me to add someone, log a call, or find who you owe a reply. Writes show for your approval before they touch the vault.',
    suggest: ['Who should I reconnect with?', 'Log a call with Maya', 'Whose birthday is next?'],
  },
  Root,
};

export default peopleInlineApp;
