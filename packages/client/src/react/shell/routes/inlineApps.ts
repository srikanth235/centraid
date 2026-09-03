import type { InlineAppModule } from "@centraid/blueprints/apps/inline-types";

export type InlineAppLoader = () => Promise<{ default: InlineAppModule }>;

const INLINE_APPS: Record<string, InlineAppLoader> = {
  tasks: () =>
    import("@centraid/blueprints/apps/tasks/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  tally: () =>
    import("@centraid/blueprints/apps/tally/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  agenda: () =>
    import("@centraid/blueprints/apps/agenda/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  people: () =>
    import("@centraid/blueprints/apps/people/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  notes: () =>
    import("@centraid/blueprints/apps/notes/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  docs: () =>
    import("@centraid/blueprints/apps/docs/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  locker: () =>
    import("@centraid/blueprints/apps/locker/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
  photos: () =>
    import("@centraid/blueprints/apps/photos/app-inline") as Promise<{
      default: InlineAppModule;
    }>,
};

export function inlineAppLoader(appId: string): InlineAppLoader | undefined {
  return INLINE_APPS[appId];
}
