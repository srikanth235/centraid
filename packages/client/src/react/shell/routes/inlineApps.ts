// The typed inline-app render registry (issue #505). Each bundled app that has
// been converted to an inline route maps its id to a dynamic import of its
// `app-inline` descriptor. The `import()` is a code-split point: every app is
// its own lazy chunk, so converting apps never grows the shell's initial-load
// JS (issue acceptance). Desktop's file:// build already emits + loads split
// chunks, so dynamic import works on both transports.
import type { InlineAppModule } from '@centraid/blueprints/apps/inline-types';

export type InlineAppLoader = () => Promise<{ default: InlineAppModule }>;

const INLINE_APPS: Record<string, InlineAppLoader> = {
  tasks: () =>
    import('@centraid/blueprints/apps/tasks/app-inline') as Promise<{ default: InlineAppModule }>,
  tally: () =>
    import('@centraid/blueprints/apps/tally/app-inline') as Promise<{ default: InlineAppModule }>,
  agenda: () =>
    import('@centraid/blueprints/apps/agenda/app-inline') as Promise<{ default: InlineAppModule }>,
  people: () =>
    import('@centraid/blueprints/apps/people/app-inline') as Promise<{ default: InlineAppModule }>,
  notes: () =>
    import('@centraid/blueprints/apps/notes/app-inline') as Promise<{ default: InlineAppModule }>,
  docs: () =>
    import('@centraid/blueprints/apps/docs/app-inline') as Promise<{ default: InlineAppModule }>,
  locker: () =>
    import('@centraid/blueprints/apps/locker/app-inline') as Promise<{ default: InlineAppModule }>,
  photos: () =>
    import('@centraid/blueprints/apps/photos/app-inline') as Promise<{ default: InlineAppModule }>,
};

/** The lazy descriptor loader for an inline app id, or undefined if not inline. */
export function inlineAppLoader(appId: string): InlineAppLoader | undefined {
  return INLINE_APPS[appId];
}
