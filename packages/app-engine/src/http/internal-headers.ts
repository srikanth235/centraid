/**
 * Internal, server-stamped module profile for a constrained Companion device.
 * The public HTTP listener strips client copies before the gateway stamps the
 * value from the authenticated enrollment record.
 */
export const COMPANION_GRANTS_HEADER = 'x-centraid-companion-grants';

type CompanionTool = 'centraid_read' | 'centraid_write' | 'centraid_describe';

const COMPANION_CAPABILITIES: Readonly<
  Record<string, Partial<Record<CompanionTool, readonly string[]>>>
> = {
  locker: {
    centraid_read: ['autofill-candidates', 'autofill-item'],
    centraid_write: ['add-item'],
  },
  tasks: { centraid_write: ['add'] },
  notes: { centraid_write: ['create-note'] },
  docs: { centraid_write: ['upload'] },
  agenda: { centraid_write: ['propose'] },
  people: { centraid_write: ['add-person'] },
};

/** Enforce the narrow action/query bundle behind each selected module. */
export function companionToolAllowed(
  profile: ReadonlySet<string>,
  tool: CompanionTool,
  body: Readonly<Record<string, unknown>>,
): boolean {
  const app = typeof body.app === 'string' ? body.app : '';
  if (!profile.has(app)) return false;
  const operation =
    tool === 'centraid_read' ? body.query : tool === 'centraid_write' ? body.action : undefined;
  return (
    typeof operation === 'string' &&
    (COMPANION_CAPABILITIES[app]?.[tool]?.includes(operation) ?? false)
  );
}
