// ASKING A GATEWAY WHICH VAULT IT SERVES (#996, W5).
//
// A phone that has been handed a base URL and nothing else needs one fact
// before it can name a seat file: the vault id. It used to get it from the
// shaped bootstrap door's first page — a request that composed shapes, walked
// rows and returned an envelope, to read one string off it.
//
// The SEAT LOG DOOR answers the same question for nothing: every page it serves
// carries the vault it is a log of, and `limit=0` asks for no rows at all.

import { ROUTES } from "@centraid/core/protocol";

export interface SeatDoorProbe {
  readonly vaultId: string;
  readonly epoch: string;
  readonly schemaEpoch: number;
}

/** The vault this gateway serves, from a log page with no rows in it. */
export async function probeSeatVault(
  baseUrl: string,
  options: {
    headers?: Readonly<Record<string, string>>;
    fetch?: typeof globalThis.fetch;
  } = {}
): Promise<SeatDoorProbe> {
  const url = new URL(ROUTES.vaultSeatLog, baseUrl);
  url.searchParams.set("since", "0");
  url.searchParams.set("limit", "0");
  const call = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await call(url.toString(), {
    headers: { ...options.headers, Accept: "application/json" },
  });
  const body = (await response.json()) as Partial<SeatDoorProbe> & {
    error?: string;
  };
  if (!response.ok || typeof body.vaultId !== "string") {
    throw new Error(
      `seat log door answered ${response.status}: ${String(body.error ?? "")}`
    );
  }
  return {
    vaultId: body.vaultId,
    epoch: String(body.epoch ?? ""),
    schemaEpoch: Number(body.schemaEpoch ?? 0),
  };
}
