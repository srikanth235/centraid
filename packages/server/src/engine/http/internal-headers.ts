export const COMPANION_GRANTS_HEADER = "x-centraid-companion-grants";

type CompanionHandlerKind = "action" | "query";

const COMPANION_CAPABILITIES: Readonly<
  Record<string, Partial<Record<CompanionHandlerKind, readonly string[]>>>
> = {
  locker: {
    query: ["autofill-candidates", "autofill-item"],
    action: ["add-item"],
  },
  tasks: { action: ["add"] },
  notes: { action: ["create-note"] },
  docs: { action: ["upload"] },
  agenda: { action: ["propose"] },
  people: { action: ["add-person"] },
};

export function companionHandlerAllowed(
  profile: ReadonlySet<string>,
  kind: CompanionHandlerKind,
  appId: string,
  handlerName: string
): boolean {
  if (!profile.has(appId)) return false;
  return COMPANION_CAPABILITIES[appId]?.[kind]?.includes(handlerName) ?? false;
}
