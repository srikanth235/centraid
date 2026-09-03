import { Image } from "expo-image";
import React, { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { useImageFallback } from "../../kit/media/use-image-fallback";
import { t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { Rung } from "./photos-rungs";
import {
  CUSTODY_ICON,
  CUSTODY_LABEL,
  SELECTION_DOT,
  SELECTION_INSET,
  SELECTION_OUTLINE,
  kindOverlay,
  stateOverlay,
  tileGround,
  vaultMarkFor,
} from "./tile-overlays";
import type { VaultFacts } from "./tile-overlays";
import type { PhotoAsset } from "./timeline-model";

const VAULT_RULE = 2;

export interface PhotoTileProps {
  asset: PhotoAsset;
  width: number;
  height: number;
  rung: Rung;
  selected: boolean;
  selecting: boolean;
  vaults: ReadonlyMap<string, VaultFacts>;
  testID?: string;
  onOpen: (asset: PhotoAsset) => void;
  onSelect: (asset: PhotoAsset) => void;
}

function PhotoTileImpl({
  asset,
  width,
  height,
  rung,
  selected,
  selecting,
  vaults,
  testID,
  onOpen,
  onSelect,
}: PhotoTileProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const media = useImageFallback(asset.uri, asset.originalUri, asset.id);
  const { failed, decoded } = media;

  const vaultMark = vaultMarkFor(
    asset,
    vaults,
    rung,
    colors.cAmber ?? colors.line
  );
  const kindLine = kindOverlay(asset, rung);
  const state = stateOverlay(asset, rung, { decodeFailed: failed });
  const name = asset.filename ?? `Photograph from ${asset.capturedAt}`;

  return (
    <Pressable
      accessibilityLabel={
        state?.form === "custody" ? `${name}, ${CUSTODY_LABEL}` : name
      }
      accessibilityRole="imagebutton"
      accessibilityState={{ selected }}
      onPress={() => (selecting ? onSelect(asset) : onOpen(asset))}
      testID={testID}
      style={{ height, width }}
    >
      <View
        style={[
          styles.ground,
          {
            backgroundColor: tileGround(decoded, colors.skel, colors.bgSunken),
          },
          state?.form === "line" &&
            state.tone === "net" && {
              borderColor: colors.net,
              borderWidth: 1,
            },
        ]}
      >
        {failed ? null : (
          <Image
            source={imageSource(media.source)}
            {...gridImageProps(media.source)}
            placeholder={
              asset.thumbhash ? { thumbhash: asset.thumbhash } : undefined
            }
            transition={120}
            recyclingKey={media.recyclingKey}
            onLoad={media.handleLoad}
            onError={media.handleError}
            style={styles.image}
          />
        )}
      </View>

      {/* Slot 2 — vault. A 2px rule in the vault's hue on the LEADING edge,
          plus the initial in mono from rung M. `start` so it mirrors. Fires on
          the vault's `kind`, never on its name. */}
      {vaultMark ? (
        <>
          <View
            style={[styles.vaultRule, { backgroundColor: vaultMark.hue }]}
            pointerEvents="none"
          />
          {vaultMark.initial ? (
            <Text style={[styles.vaultInitial, { color: colors.onStage }]}>
              {vaultMark.initial}
            </Text>
          ) : null}
        </>
      ) : null}

      {/* Slot 3 — kind. Video duration or `live`, in mono, from rung S up. */}
      {kindLine ? (
        <Text
          style={[styles.kind, { color: colors.onStage }]}
          numberOfLines={1}
        >
          {kindLine}
        </Text>
      ) : null}

      {/* Slot 4 — state, in ONE of its two forms. Never a fill, never a red
          dot, never a vanishing tile.

          The LINE is the handoff's `note` (proto:4019-4020): a chip held 4pt
          off the tile's foot and both sides, 3pt of inner gutter, a 2px
          radius, on the page colour. It used to be `bottom:0` with both insets
          at 0 — a full-bleed strip flush to the edge, which read as a caption
          belonging to the ROW rather than a mark belonging to this tile. */}
      {state?.form === "line" ? (
        <View
          style={[styles.state, { backgroundColor: colors.bg }]}
          pointerEvents="none"
        >
          <Text
            numberOfLines={1}
            style={[
              styles.stateText,
              {
                color:
                  state.tone === "net"
                    ? colors.net
                    : state.tone === "seam"
                      ? colors.seam
                      : colors.textFaint,
              },
            ]}
          >
            {state.text}
          </Text>
        </View>
      ) : null}

      {/* …or the MARK: bytes are here and nowhere else. A chip rather than the
          text shadow the kind slot uses, because a stroke glyph has no shadow
          to support it — and the handoff marks over photographs the same way
          (proto:4021-4023's `libMark`: page colour, 2px radius, 3pt gutter).
          Bottom-LEADING, the one free corner: selection is top-trailing and
          the kind line is bottom-trailing. */}
      {state?.form === "custody" ? (
        <View
          style={[styles.custody, { backgroundColor: colors.bg }]}
          pointerEvents="none"
        >
          <Icon name={CUSTODY_ICON} size={13} color={colors.textSoft} />
        </View>
      ) : null}

      {/* Slot 1 — selection. A 20px circle, top/trailing, 6px in. On: filled
          ink, a --text-inv tick, and a 2px ink outline at -2px on the tile. */}
      {selected ? (
        <View
          style={[styles.outline, { borderColor: colors.text }]}
          pointerEvents="none"
        />
      ) : null}
      {selecting || selected ? (
        <View
          style={[
            styles.dot,
            selected
              ? { backgroundColor: colors.text, borderColor: colors.text }
              : { borderColor: colors.onStage },
          ]}
          pointerEvents="none"
        >
          {selected ? (
            <Icon name="check" size={13} color={colors.textInv} />
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const PhotoTile = memo(PhotoTileImpl);
PhotoTile.displayName = "PhotoTile";
export default PhotoTile;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    dot: {
      alignItems: "center",
      borderRadius: SELECTION_DOT,
      borderWidth: 1.5,
      height: SELECTION_DOT,
      insetInlineEnd: SELECTION_INSET,
      justifyContent: "center",
      position: "absolute",
      top: SELECTION_INSET,
      width: SELECTION_DOT,
    },
    ground: { height: "100%", overflow: "hidden", width: "100%" },
    image: { height: "100%", width: "100%" },
    kind: {
      ...t("mono"),
      bottom: 4,
      insetInlineEnd: 5,
      position: "absolute",
      textShadowColor: colors.stage,
      textShadowRadius: 3,
    },
    outline: {
      borderWidth: SELECTION_OUTLINE,
      bottom: -SELECTION_OUTLINE,
      insetInlineEnd: -SELECTION_OUTLINE,
      insetInlineStart: -SELECTION_OUTLINE,
      position: "absolute",
      top: -SELECTION_OUTLINE,
    },
    custody: {
      alignItems: "center",
      borderRadius: radii.sm,
      bottom: 4,
      insetInlineStart: 4,
      justifyContent: "center",
      paddingHorizontal: 3,
      paddingVertical: 2,
      position: "absolute",
    },
    state: {
      borderRadius: radii.sm,
      bottom: 4,
      insetInlineEnd: 4,
      insetInlineStart: 4,
      paddingHorizontal: 3,
      paddingVertical: 1,
      position: "absolute",
    },
    stateText: t("mono"),
    vaultInitial: {
      ...t("mono"),
      insetInlineStart: VAULT_RULE + 4,
      position: "absolute",
      textShadowColor: colors.stage,
      textShadowRadius: 3,
      top: 3,
    },
    vaultRule: {
      bottom: 0,
      insetInlineStart: 0,
      position: "absolute",
      top: 0,
      width: VAULT_RULE,
    },
  });
