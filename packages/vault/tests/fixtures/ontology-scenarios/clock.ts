// THE FIXTURE'S CLOCK (#996, wave 0e).
//
// The vault stamps its own instants: `nowIso()` inside the execution stage is
// what every handler writes into `created_at`, `valid_from`, `completed_at`.
// There is no clock seam to inject — so the fixture takes the global one for
// the length of the build and hands it back, which is the only way a replay of
// these scenarios can produce the same rows twice.
//
// A FROZEN INSTANT IS COHERENT, A FIXED ONE IS NOT. Wave 0c's prelude removed a
// scenario that retired an identifier "at 10:00 on a fixed day" while the vault
// minted it from the wall clock — the interval ran backwards the moment the
// suite ran after 10:00. Here the vault's clock and the scenario's clock are
// the SAME clock, so a scenario that wants a later instant asks for one
// (`advance`) instead of naming one.

/** The global clock, held still, and the handle that moves and releases it. */
export interface FixtureClock {
  /** The instant the vault is currently stamping. */
  readonly nowIso: () => string;
  /** Move forward. Scenarios step rather than name an hour. */
  readonly advance: (ms: number) => void;
  /** Put the real clock back. Idempotent; the builder calls it in a `finally`. */
  readonly restore: () => void;
}

/** The instant every replay starts from. Any instant does, as long as it is
 *  the same one each time and the whole run shares it. */
export const FIXTURE_EPOCH = "2026-06-01T09:00:00.000Z";

export function installFixtureClock(start = FIXTURE_EPOCH): FixtureClock {
  const RealDate = globalThis.Date;
  let current = RealDate.parse(start);
  if (Number.isNaN(current)) throw new Error(`not an instant: ${start}`);
  // A proxy rather than a subclass: `new Date()` with no argument reads the
  // frozen instant, every other construction is the real one, and `Date.now`
  // agrees with both. Nothing else about `Date` changes.
  const frozen = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target,
        args.length === 0 ? [current] : args,
        newTarget
      );
    },
    get(target, property, receiver) {
      if (property === "now") return () => current;
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = frozen;
  let restored = false;
  return {
    nowIso: () => new RealDate(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
    restore: () => {
      if (restored) return;
      restored = true;
      globalThis.Date = RealDate;
    },
  };
}
