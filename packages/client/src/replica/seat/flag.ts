// THE FLAG THAT TURNS THE SEAT STORE ON (#996, wave 2).
//
// The new store lands BESIDE the old one, not over it: #996's own invariant is
// that the share transport is never deleted before its replacement serves
// every live subscription, and the same restraint applies here — wave 5 takes
// the device half, and until then a member's browser must be able to run
// either. So there is exactly one place that answers "which store is this
// seat", and it is this function.
//
// ONE READING, THREE SOURCES, IN ORDER. An explicit argument beats a URL
// parameter beats what the browser remembered. That order is not arbitrary: a
// test or a host that has already decided must win over a query string a
// member could have been handed in a link, and both must win over a
// preference the browser is holding from a session nobody remembers.
//
// AND IT DEFAULTS OFF. A flag that defaults on is not a flag; it is a
// migration with a switch bolted to it.

export const SEAT_STORE_FLAG = "centraid.seatStore";

export interface SeatStoreFlagSources {
  /** A host that has already decided. Wins outright. */
  readonly explicit?: boolean | undefined;
  /** `?seatStore=1` — how the e2e lane and a member's support link turn it on. */
  readonly search?: string | undefined;
  /** What this browser remembered. */
  readonly storage?: Pick<Storage, "getItem"> | undefined;
}

function truthy(value: string | null | undefined): boolean {
  return value === "1" || value === "true" || value === "on";
}

export function seatStoreEnabled(sources: SeatStoreFlagSources = {}): boolean {
  if (sources.explicit !== undefined) return sources.explicit;
  if (sources.search !== undefined) {
    const params = new URLSearchParams(sources.search);
    const named = params.get("seatStore");
    if (named !== null) return truthy(named);
  }
  try {
    return truthy(sources.storage?.getItem(SEAT_STORE_FLAG));
  } catch {
    // A browser with site data blocked throws on `getItem`. That is not a vote
    // for the new store.
    return false;
  }
}

/** The sources a browser has, read from the globals it actually exposes. */
export function browserSeatStoreFlag(explicit?: boolean): boolean {
  const location = (globalThis as { location?: { search?: string } }).location;
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  return seatStoreEnabled({
    ...(explicit === undefined ? {} : { explicit }),
    ...(location?.search === undefined ? {} : { search: location.search }),
    ...(storage === undefined ? {} : { storage }),
  });
}
