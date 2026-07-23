// Type stub for blueprint `…/app-inline` entries under the client tsconfig.
//
// Blueprint app sources are authored against the blueprints ambients
// (window.centraid, HandlerArgs, `./kit.ts`, allowImportingTsExtensions) and
// must NOT be type-checked under the client program — the shell only touches
// their default export through the InlineAppModule contract, and the bundler
// code-splits the real import. A `paths` mapping in packages/client/tsconfig.json
// redirects `@centraid/blueprints/apps/*/app-inline` here so tsc resolves the
// contract type instead of loading the .tsx, while Vite still emits the lazy
// chunk from the literal import in inlineApps.ts.
import type { InlineAppModule } from '@centraid/blueprints/apps/inline-types';

declare const descriptor: InlineAppModule;
export default descriptor;
