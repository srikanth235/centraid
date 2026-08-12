export interface SnapshotShareScope {
  mode: "snapshot";
  itemIds: string[];
}

/** Retained only for strict receipt decoding; live edges are retired (#731). */
export interface LiveShareScope {
  mode: "live";
  containerType: string;
  containerId: string;
}

export type ShareScope = SnapshotShareScope | LiveShareScope;

export function parseShareScope(
  mode: "snapshot",
  raw: unknown
): SnapshotShareScope;
export function parseShareScope(mode: "live", raw: unknown): LiveShareScope;
export function parseShareScope(mode: unknown, raw: unknown): ShareScope;
export function parseShareScope(mode: unknown, raw: unknown): ShareScope {
  if (mode === "snapshot") {
    if (!Array.isArray(raw)) throw new Error("snapshot scope must be an array");
    const itemIds = raw.map((value) => {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("snapshot scope item ids must be non-empty strings");
      }
      return value;
    });
    return { mode, itemIds };
  }
  if (mode === "live") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("live scope must be an object");
    }
    const value = raw as Record<string, unknown>;
    if (
      typeof value.containerType !== "string" ||
      value.containerType.length === 0 ||
      typeof value.containerId !== "string" ||
      value.containerId.length === 0
    ) {
      throw new Error("live scope must name a container type and id");
    }
    return {
      mode,
      containerType: value.containerType,
      containerId: value.containerId,
    };
  }
  throw new Error("share scope mode must be snapshot or live");
}

export function parseStoredShareScope(
  mode: unknown,
  scopeJson: string | null
): ShareScope {
  if (scopeJson === null) throw new Error("share scope is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopeJson);
  } catch {
    throw new Error("share scope is not valid JSON");
  }
  return parseShareScope(mode, parsed);
}
