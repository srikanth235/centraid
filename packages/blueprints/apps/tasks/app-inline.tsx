// Tasks, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, CHANGE_TABLES } from './app-root.tsx';
import boardQuery from './queries/board.ts';
import searchQuery from './queries/search.ts';
import type { InlineAppModule } from '../inline-types.ts';

const tasksInlineApp: InlineAppModule = {
  appId: 'tasks',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    board: { default: boardQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'tasks',
    placeholder: 'Ask your tasks…',
    intro:
      'Ask me to add, complete, reschedule or find tasks. I’ll show the change for your approval before it touches the vault.',
    suggest: ['Add “call mom tomorrow”', 'What’s due today?', 'Complete “Send the studio invoice”'],
  },
  Root,
};

export default tasksInlineApp;
