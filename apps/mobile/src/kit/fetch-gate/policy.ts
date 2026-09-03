export type ConnectionKind = "metered" | "unmetered" | "unknown";

export interface FetchPolicy {
  connectionKind: (networkType: string | undefined) => ConnectionKind;
}

const METERED_NETWORK_TYPES = new Set(["CELLULAR", "WIMAX"]);

export const defaultFetchPolicy: FetchPolicy = {
  connectionKind(networkType: string | undefined): ConnectionKind {
    if (networkType === undefined) return "unknown";
    return METERED_NETWORK_TYPES.has(networkType) ? "metered" : "unmetered";
  },
};
