// WHERE A SCREEN IS, AS A VALUE (#1015, S1/S2 — audit B7).
//
// Thirteen pushed Docs screens said `backTo="All"` because `backTo` was a
// string, and a string is something a screen can invent. The label and the
// VoiceOver word were therefore both wrong on twelve of them, and no test
// could tell: `"All"` is a perfectly good string.
//
// A `PlaceRef` cannot be written down. It carries a brand no caller can
// produce, so the only way to obtain one is `place()` — which the navigation
// layer calls once per route entry — or `parentPlace()` over the live stack.
// A literal fails to typecheck; `scripts/lint-mobile-rooms.mjs` catches the
// `as` cast that would talk its way around that.

declare const PLACE_REF: unique symbol;

export interface PlaceRef {
  /** Unforgeable: no caller outside this module can name the key. */
  readonly [PLACE_REF]: true;
  /** The route name, for tests and lint — never shown to a member. */
  readonly key: string;
  /** The words on the back control and in the spoken label. */
  readonly title: string;
}

/** One route entry, as the navigator knows it. */
export interface PlaceEntry {
  key: string;
  title: string;
}

/**
 * Mint a place from a route entry. The navigation layer owns the call: it is
 * the only layer that knows a route's real name and its real title.
 */
export function place({ key, title }: PlaceEntry): PlaceRef {
  return { key, title } as PlaceRef;
}

/** The whole stack, oldest first, as places. */
export function placeStack(
  entries: readonly PlaceEntry[]
): readonly PlaceRef[] {
  return entries.map(place);
}

/**
 * What this screen descends FROM: the entry under the top of the stack.
 * `undefined` on a root screen, which is the honest answer — a room with no
 * parent draws no back control rather than one pointing at a guess.
 */
export function parentPlace(stack: readonly PlaceRef[]): PlaceRef | undefined {
  return stack[stack.length - 2];
}

/** The screen the member is on; the band's `current` is computed from it. */
export function currentPlace(stack: readonly PlaceRef[]): PlaceRef | undefined {
  return stack[stack.length - 1];
}
