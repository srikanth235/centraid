/*
 * `expo/fetch` on a host that has no Expo (#1014, T11).
 *
 * The fourth stand-in this tier declares (see `seat.ts`'s header): the shipped
 * `NativeMultiplexChangeFeed` imports the phone's streaming fetch at module
 * load, and `expo/fetch` resolves a React Native runtime module that a Node
 * process cannot require. Node's own `fetch` streams response bodies, which is
 * the one property the feed needs from it — and every suite here injects its
 * own `streamFetch` anyway, so this is what makes the MODULE importable rather
 * than what the feed actually calls.
 */

export const fetch = globalThis.fetch;
