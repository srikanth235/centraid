// THE PRODUCT'S ONE AVATAR, and the link ring it wears.
//
// Two surfaces draw a person: People's roster and the share sheet. They must
// draw the SAME person the same way — a face that changes shape between the
// screen that lists someone and the screen that reaches them is two people to
// a reader — so the recipe lives in the kit and both consume it.
//
// THE LINK RING (v12): solid ink where linked, dashed line-colour where not,
// NOTHING where the sharing plane could not be read. A wrapper View border
// (`outline` does not exist in React Native) reserving the same outer rectangle
// in all three states, so a row cannot reflow when link facts arrive.

import React from "react";
import { View } from "react-native";

import { identityInitials, identityInk } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import { radii, t, useTheme } from "../theme";
import { Text } from "./NativeText";
import { avatarFill } from "./person-avatar-fill";

// Re-exported so the component stays the one name a caller has to know.
export { avatarFill } from "./person-avatar-fill";

export type LinkRing = "linked" | "unlinked" | "unknown";

/** Avatar boxes and ring rungs; fixed sizes. */
const AVATAR_ROW = 34;
const AVATAR_HERO = 52;
const RING_ROW = { width: 1.5, offset: 2 } as const;
const RING_HERO = { width: 2, offset: 3 } as const;

export interface AvatarSubject {
  party_id: string;
  name: string;
  avatar_color?: string | null;
}

export default function PersonAvatar({
  person,
  link = "unknown",
  hero = false,
}: {
  person: AvatarSubject;
  link?: LinkRing;
  hero?: boolean;
}): React.JSX.Element {
  const { colors } = useTheme();
  const ring = hero ? RING_HERO : RING_ROW;
  const box = hero ? AVATAR_HERO : AVATAR_ROW;
  const fill = avatarFill(
    person,
    (key: ColorKey) =>
      colors[`c${key.slice(0, 1).toUpperCase()}${key.slice(1)}`] ??
      colors.accent
  );
  const ink = identityInk(fill, colors.text, colors.textInv);
  const outer = box + 2 * (ring.offset + ring.width);
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        width: outer,
        height: outer,
        borderRadius: radii.pill,
        borderWidth: ring.width,
        // Unknown draws NOTHING — never paint a dashed ring and call it
        // "not linked" (transparent border keeps the outer box).
        borderColor:
          link === "linked"
            ? colors.text
            : link === "unlinked"
              ? colors.line
              : "transparent",
        borderStyle: link === "unlinked" ? "dashed" : "solid",
      }}
    >
      <View
        style={{
          alignItems: "center",
          justifyContent: "center",
          width: box,
          height: box,
          borderRadius: radii.pill,
          backgroundColor: fill,
        }}
      >
        <Text
          style={[hero ? t("bodyStrong") : t("smallStrong"), { color: ink }]}
        >
          {identityInitials(person.name)}
        </Text>
      </View>
    </View>
  );
}
