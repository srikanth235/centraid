export type EntityLifecycle = "append-only" | "mutable" | "trash" | "machinery";

export interface EntityRevisionPolicy {
  retain: number | "forever";
}

export const DEFAULT_REVISION_RETAIN = 20;

export interface VaultEntityDeclaration {
  label: string;
  blurb?: string;
  lifecycle: EntityLifecycle;
  revisions?: EntityRevisionPolicy;
  projectionOf?: string;
}

export type EntityRegistry = Readonly<
  Record<string, Readonly<Record<string, VaultEntityDeclaration>>>
>;

export function revisionPolicyOf(
  declaration: VaultEntityDeclaration
): EntityRevisionPolicy {
  return declaration.revisions ?? { retain: DEFAULT_REVISION_RETAIN };
}
