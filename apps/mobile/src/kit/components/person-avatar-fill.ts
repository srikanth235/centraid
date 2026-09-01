// The avatar's hue rule, kept OUT of `PersonAvatar.tsx` so it can be read
// without React Native. The component is a `.tsx` that imports `react-native`,
// whose entry point is Flow-typed; a node-environment test that reached in for
// this function could not parse it. The rule is pure, so it does not have to
// live behind that door.

import { partyHueKey } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

/** The hue a person wears: a palette KEY derived from their party id (or the
 *  one they chose), lowered by the caller into whatever that surface calls a
 *  colour. A stored colour that is not a palette hue is honoured verbatim —
 *  the member picked it. */
export function avatarFill(
  person: { party_id: string; avatar_color?: string | null },
  ringFor: (key: ColorKey) => string
): string {
  const key = partyHueKey(person.party_id, person.avatar_color);
  if (key) return ringFor(key);
  return person.avatar_color ?? "";
}
