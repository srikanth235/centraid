import { partyHueKey } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

export function avatarFill(
  person: { party_id: string; avatar_color?: string | null },
  ringFor: (key: ColorKey) => string
): string {
  const key = partyHueKey(person.party_id, person.avatar_color);
  if (key) return ringFor(key);
  return person.avatar_color ?? "";
}
