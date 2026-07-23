// Photos, inline descriptor (issue #505). The `InlineAppModule` the shell's
// client loader (packages/client inlineApps.ts) imports: it pairs the
// query-free `Root` (app-root.tsx) with this app's `./queries/*` handler
// modules for the shell's client-side query path, alongside changeTables +
// kitAsk. The `./queries/*` imports live ONLY here so they never reach the
// served/browser bundle (the gateway refuses to serve node-side handlers).

import { Root, PHOTOS_READ_TABLES_LIST } from './app-root.tsx';
import libraryQuery from './queries/library.ts';
import searchQueryModule from './queries/search.ts';
import duplicatesQuery from './queries/duplicates.ts';
import enrichmentStatusQuery from './queries/enrichment-status.ts';
import facesQuery from './queries/faces.ts';
import type { InlineAppModule } from '../inline-types.ts';

const photosInlineApp: InlineAppModule = {
  appId: 'photos',
  changeTables: PHOTOS_READ_TABLES_LIST,
  // Query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    library: { default: libraryQuery },
    search: { default: searchQueryModule },
    duplicates: { default: duplicatesQuery },
    'enrichment-status': { default: enrichmentStatusQuery },
    faces: { default: facesQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'photos',
    placeholder: 'Ask your photos…',
    intro:
      'Ask me to find photos, make an album, or share a set. Albums and shares show for your approval before they touch the vault.',
    suggest: ['Make an album of Saturday’s photos', 'Find beach photos', 'Share these with Dana'],
  },
  Root,
};

export default photosInlineApp;
