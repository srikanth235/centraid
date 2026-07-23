// Type stub for blueprint `queries/<name>` modules under the client tsconfig
// (issue #505). Query sources are authored against the blueprints ambients
// (HandlerArgs, ctx.vault), so a `paths` mapping in packages/client/tsconfig.json
// redirects `@centraid/blueprints/apps/*/queries/*` here — tsc sees the run
// contract, while vitest/Vite resolve the real source at run time (they don't
// honour tsconfig paths). Used by inlineQueryCtx.test.ts, which runs the real
// board query against a seeded replica double.
import type { InlineQueryRun } from '@centraid/blueprints/apps/inline-types';

declare const run: InlineQueryRun;
export default run;
