export type ShareReadReach = "unreachable" | "refused";

export type ShareRead<T> =
  | { state: "loading" }
  | { state: "read"; rows: readonly T[] }
  | { state: "absent"; reach: ShareReadReach };

export const SHARE_READ_LOADING: ShareRead<never> = { state: "loading" };

export function shareReadReach(
  error: unknown,
  online: boolean
): ShareReadReach {
  return !online || error instanceof TypeError ? "unreachable" : "refused";
}

export function shareAbsentLine(noun: string, reach: ShareReadReach): string {
  return reach === "unreachable"
    ? `${noun} could not be read — the gateway is out of reach.`
    : `${noun} could not be read — the gateway refused this read.`;
}

export async function readShareSection<T>(
  read: () => Promise<readonly T[]>,
  online: boolean
): Promise<ShareRead<T>> {
  try {
    return { state: "read", rows: await read() };
  } catch (error) {
    return { state: "absent", reach: shareReadReach(error, online) };
  }
}
