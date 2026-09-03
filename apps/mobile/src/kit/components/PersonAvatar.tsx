import React from "react";
import { View } from "react-native";

import { identityInitials, identityInk } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import { radii, t, useTheme } from "../theme";
import { Text } from "./NativeText";
import { avatarFill } from "./person-avatar-fill";

export { avatarFill } from "./person-avatar-fill";

export type LinkRing = "linked" | "unlinked" | "unknown";

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
