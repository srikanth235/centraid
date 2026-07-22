export const COMPANION_MODULES = ['locker', 'tasks', 'notes', 'docs', 'agenda', 'people'] as const;

export type CompanionModule = (typeof COMPANION_MODULES)[number];
export type CompanionModuleState = 'granted' | 'parked' | 'revoked' | 'unavailable';

interface GrantLike {
  readonly scopes: readonly {
    readonly schema: string;
    readonly table: string | null;
    readonly verbs: string;
  }[];
}

interface AppLike {
  readonly grants: readonly GrantLike[];
}

interface RequiredScope {
  readonly schema: string;
  readonly table?: string;
  readonly verb: string;
}

const REQUIRED_SCOPE: Readonly<Record<CompanionModule, RequiredScope>> = {
  locker: { schema: 'locker', table: 'item', verb: 'reveal' },
  tasks: { schema: 'schedule', table: 'add_task', verb: 'act' },
  notes: { schema: 'knowledge', table: 'create_note', verb: 'act' },
  docs: { schema: 'core', table: 'add_document', verb: 'act' },
  agenda: { schema: 'schedule', verb: 'act' },
  people: { schema: 'people', verb: 'act' },
};

function grantsScope(app: AppLike, required: RequiredScope): boolean {
  return app.grants.some((grant) =>
    grant.scopes.some(
      (scope) =>
        scope.schema === required.schema &&
        (scope.table === null || required.table === undefined || scope.table === required.table) &&
        scope.verbs.split('+').includes(required.verb),
    ),
  );
}

/** A module goes dark as soon as its own required owner grant is absent. */
export function companionModuleState(
  selected: ReadonlySet<string>,
  module: CompanionModule,
  app: AppLike | undefined,
): CompanionModuleState {
  if (!selected.has(module)) return 'revoked';
  if (!app) return 'unavailable';
  return grantsScope(app, REQUIRED_SCOPE[module]) ? 'granted' : 'parked';
}
