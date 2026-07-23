/**
 * Internal, server-stamped module profile for a constrained Companion device.
 * The public HTTP listener strips client copies before the gateway stamps the
 * value from the authenticated enrollment record.
 */
export const COMPANION_GRANTS_HEADER = 'x-centraid-companion-grants';

/** The two app RPC handler kinds a Companion device may invoke. */
type CompanionHandlerKind = 'action' | 'query';

const COMPANION_CAPABILITIES: Readonly<
  Record<string, Partial<Record<CompanionHandlerKind, readonly string[]>>>
> = {
  locker: {
    query: ['autofill-candidates', 'autofill-item'],
    action: ['add-item'],
  },
  tasks: { action: ['add'] },
  notes: { action: ['create-note'] },
  docs: { action: ['upload'] },
  agenda: { action: ['propose'] },
  people: { action: ['add-person'] },
};

/**
 * Enforce the narrow action/query bundle behind each selected module. The app
 * id and handler name now ride in the request path (issue #505), so the caller
 * passes them directly rather than a tool-body envelope.
 */
export function companionHandlerAllowed(
  profile: ReadonlySet<string>,
  kind: CompanionHandlerKind,
  appId: string,
  handlerName: string,
): boolean {
  if (!profile.has(appId)) return false;
  return COMPANION_CAPABILITIES[appId]?.[kind]?.includes(handlerName) ?? false;
}
