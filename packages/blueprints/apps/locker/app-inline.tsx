// Locker, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, CHANGE_TABLES } from './app-root.tsx';
import itemsQuery from './queries/items.ts';
import itemQuery from './queries/item.ts';
import searchQuery from './queries/search.ts';
import trashQuery from './queries/trash.ts';
import type { InlineAppModule } from '../inline-types.ts';

const lockerInlineApp: InlineAppModule = {
  appId: 'locker',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    items: { default: itemsQuery },
    item: { default: itemQuery },
    search: { default: searchQuery },
    trash: { default: trashQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'locker',
    placeholder: 'Ask your locker…',
    intro:
      'Ask me to find a login, add a card, or generate a strong password. Writes show for your approval before they touch the vault — secrets never leave a field unless you copy or reveal them.',
    suggest: ['Find my GitHub login', 'Add a new credit card', 'Which passwords are weak?'],
  },
  Root,
};

export default lockerInlineApp;
