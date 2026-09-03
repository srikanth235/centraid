export interface ModelId {
  name: string;
  version: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

export function makeModelId(name: string, version: number): string {
  if (!NAME_PATTERN.test(name))
    throw new Error(
      `model name ${JSON.stringify(name)} must be alphanumeric with . _ - and must not contain "@"`
    );
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error(`model version must be a positive integer, got ${version}`);
  return `${name}@${version}`;
}

export function parseModelId(id: string): ModelId | null {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  if (!NAME_PATTERN.test(name)) return null;
  if (!/^[0-9]+$/u.test(version)) return null;
  const parsed = Number(version);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return { name, version: parsed };
}

export function compareModelIds(a: string, b: string): number | null {
  const left = parseModelId(a);
  const right = parseModelId(b);
  if (!left || !right || left.name !== right.name) return null;
  return left.version - right.version;
}

export function isSupersededBy(stored: string, current: string): boolean {
  const order = compareModelIds(stored, current);
  return order !== null && order < 0;
}
