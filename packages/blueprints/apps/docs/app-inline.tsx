// Docs, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, CHANGE_TABLES } from './app-root.tsx';
import driveQuery from './queries/drive.ts';
import searchQuery from './queries/search.ts';
import activityQuery from './queries/activity.ts';
import historyQuery from './queries/history.ts';
import type { InlineAppModule } from '../inline-types.ts';

const docsInlineApp: InlineAppModule = {
  appId: 'docs',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds a
  // compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    drive: { default: driveQuery },
    search: { default: searchQuery },
    activity: { default: activityQuery },
    history: { default: historyQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'docs',
    placeholder: 'Ask your docs…',
    intro:
      'Ask me to find a file, upload one, or file it away. Writes show for your approval before they touch the vault.',
    suggest: ['Find my lease', 'File the June receipts', 'What did I upload this week?'],
  },
  Root,
};

export default docsInlineApp;
