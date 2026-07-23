// Notes, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, CHANGE_TABLES } from './app-root.tsx';
import libraryQuery from './queries/library.ts';
import noteQuery from './queries/note.ts';
import searchQuery from './queries/search.ts';
import type { InlineAppModule } from '../inline-types.ts';

const notesInlineApp: InlineAppModule = {
  appId: 'notes',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    library: { default: libraryQuery },
    note: { default: noteQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'notes',
    placeholder: 'Ask your notes…',
    intro:
      'Ask me to write, find, summarise or file a note. New notes show for your approval before they touch the vault.',
    suggest: [
      'Summarise my Q3 roadmap note',
      'New note from this',
      'What did I note about the offline story?',
    ],
  },
  Root,
};

export default notesInlineApp;
