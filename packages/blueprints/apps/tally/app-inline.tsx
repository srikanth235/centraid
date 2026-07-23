// Tally, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, CHANGE_TABLES } from './app-root.tsx';
import dashboardQuery from './queries/dashboard.ts';
import groupQuery from './queries/group.ts';
import friendQuery from './queries/friend.ts';
import activityQuery from './queries/activity.ts';
import searchQuery from './queries/search.ts';
import type { InlineAppModule } from '../inline-types.ts';

const tallyInlineApp: InlineAppModule = {
  appId: 'tally',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    dashboard: { default: dashboardQuery },
    group: { default: groupQuery },
    friend: { default: friendQuery },
    activity: { default: activityQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'tally',
    placeholder: 'Ask about your expenses…',
    intro:
      'Ask me to add an expense, settle up, or see who owes whom. Writes show for your approval before they touch the vault.',
    suggest: ['Split dinner four ways', 'Who do I owe?', 'Settle up with Alex'],
  },
  Root,
};

export default tallyInlineApp;
