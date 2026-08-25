// Structurally distinct tile bodies (#708 A).
// governance: allow-repo-hygiene file-size-limit The #712 shared tile-body catalog stays together so every blueprint's shape remains comparable in one binding layer.
//
// Header is INVARIANT (`LauncherGrid`). Body shape names the app — Docs is ruled file rows, Notes is prose (a title over an opening line made them indistinguishable).
// `loading` is STATIC skeletons, never a spinner. `empty`/`unknown` is the what-to-do line — fabricate neither a count nor a row.

import { Image } from "expo-image";
import React from "react";
import { StyleSheet, View } from "react-native";

import { identityFill, identityInk } from "@centraid/design";

import { Text } from "../../kit/components/NativeText";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { useImageFallback } from "../../kit/media/use-image-fallback";
import { borders, radii, t } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import { TILE_EMPTY_COPY } from "./springboard-policy";
import {
  MOSAIC_CELL_HEIGHT,
  mosaicAwaitingBytes,
  mosaicCells,
  TILE_PAD,
} from "./tile-model";
import type {
  TileBody as TileBodyModel,
  TileData,
  TilePhoto,
} from "./tile-model";

export default function TileBody({
  tile,
  colors,
  hue,
  scheme,
}: {
  tile: TileData;
  colors: ThemeColors;
  hue: string;
  scheme: Scheme;
}): React.JSX.Element {
  // Locker is a STATE, not a query result — draw in every status, do not fall through to loading/empty.
  if (tile.body.kind === "locker")
    return (
      <FilledBody body={tile.body} colors={colors} hue={hue} scheme={scheme} />
    );
  // Photos draws in EVERY status — the generic skeleton would replace the per-cell waiting grid with one blank rectangle.
  if (tile.body.kind === "photos")
    return (
      <FilledBody body={tile.body} colors={colors} hue={hue} scheme={scheme} />
    );
  if (tile.status === "loading")
    return <Skeleton kind={tile.body.kind} colors={colors} />;
  if (tile.status !== "content")
    return (
      <View style={styles.body}>
        <Text style={[styles.invite, { color: colors.textFaint }]}>
          {TILE_EMPTY_COPY[tile.appId] ?? ""}
        </Text>
      </View>
    );
  return (
    <FilledBody body={tile.body} colors={colors} hue={hue} scheme={scheme} />
  );
}

function FilledBody({
  body,
  colors,
  hue,
  scheme,
}: {
  body: TileBodyModel;
  colors: ThemeColors;
  hue: string;
  scheme: Scheme;
}): React.JSX.Element {
  switch (body.kind) {
    case "photos":
      return <PhotoMosaic photos={body.photos} colors={colors} />;
    case "docs":
      return <RuledRows rows={body.rows} colors={colors} />;
    case "notes":
      return (
        <Prose title={body.title} excerpt={body.excerpt} colors={colors} />
      );
    case "agenda":
      return (
        <View style={styles.body}>
          <Text style={[styles.eventAt, { color: colors.textSoft }]}>
            {body.at}
          </Text>
          <Text
            numberOfLines={2}
            style={[styles.eventTitle, { color: colors.text }]}
          >
            {body.title}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.afterLine, { color: colors.textFaint }]}
          >
            {body.after}
          </Text>
        </View>
      );
    case "people":
      return (
        <View style={styles.body}>
          {/* SATURATED discs: stored `avatar_color` else `identityFill(party_id)` — one person, one colour on every client. `identityInk` MEASURES: a stored hex does not follow the theme. */}
          <View style={styles.faces}>
            {body.faces.map((face, index) => {
              const fill = face.color ?? identityFill(face.id, scheme);
              return (
                <View
                  key={face.id}
                  style={[
                    styles.face,
                    {
                      backgroundColor: fill,
                      borderColor: colors.bgElev,
                      zIndex: body.faces.length - index,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.faceInitials,
                      { color: identityInk(fill, colors.text, colors.textInv) },
                    ]}
                  >
                    {face.initials}
                  </Text>
                </View>
              );
            })}
          </View>
          {/* `more` from the header total — never a fabricated 0; an exhausted directory says so plainly. */}
          <Text
            numberOfLines={1}
            style={[styles.bodyLine, { color: colors.text }]}
          >
            {body.more > 0
              ? `+${body.more} more in your directory`
              : "That's everyone in your directory"}
          </Text>
        </View>
      );
    case "tasks":
      return (
        <View style={styles.body}>
          {body.rows.map((row) => (
            <View key={row.id} style={styles.taskRow}>
              <View
                style={[
                  styles.checkbox,
                  {
                    // Ink, never the app's hue (a hue-filled box is a second identity). DONE is a filled box with NO glyph.
                    borderColor: row.done ? colors.accent : colors.lineStrong,
                    backgroundColor: row.done ? colors.accent : "transparent",
                  },
                ]}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.taskTitle,
                  row.done
                    ? {
                        color: colors.textFaint,
                        textDecorationLine: "line-through",
                      }
                    : { color: colors.text },
                ]}
              >
                {row.title}
              </Text>
            </View>
          ))}
        </View>
      );
    case "tally":
      return (
        <View style={styles.body}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.figure, { color: colors.text }]}
          >
            {body.figure}
          </Text>
          <Text style={[styles.tallyLabel, { color: colors.textSoft }]}>
            {body.caption}
          </Text>
          {/* Render `after` only when the caller has something true. */}
          {body.after ? (
            <Text
              numberOfLines={1}
              style={[styles.afterLine, { color: colors.textFaint }]}
            >
              {body.after}
            </Text>
          ) : null}
        </View>
      );
    case "locker":
      return (
        <View style={styles.body}>
          {/* No lock glyph beside "Locked" — that says it twice. STATE label, not a control. */}
          <View
            style={[
              styles.chip,
              {
                backgroundColor: "transparent",
                borderColor: colors.lineStrong,
              },
            ]}
          >
            <Text style={[styles.chipLabel, { color: hue }]}>
              {body.locked ? "Locked" : "Unlocked"}
            </Text>
          </View>
          {/* Instructional — never claim a shelf count this tile cannot read. */}
          <Text
            numberOfLines={1}
            style={[styles.bodyLine, { color: colors.text }]}
          >
            {body.locked ? "Opens with your passphrase" : "Open on this device"}
          </Text>
        </View>
      );
  }
}

function RuledRows({
  rows,
  colors,
}: {
  rows: readonly { id: string; name: string; size: string }[];
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.body}>
      {rows.map((row, index) => (
        <View
          key={row.id}
          style={[
            styles.ruledRow,
            index > 0 && {
              borderTopColor: colors.line,
              borderTopWidth: borders.hairline,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.fileName, { color: colors.text }]}
          >
            {row.name}
          </Text>
          {/* No recorded size renders nothing, never a zero. */}
          {row.size ? (
            <Text style={[styles.fileSize, { color: colors.textFaint }]}>
              {row.size}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Prose({
  title,
  excerpt,
  colors,
}: {
  title: string;
  excerpt: string;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.body}>
      <Text numberOfLines={1} style={[styles.docTitle, { color: colors.text }]}>
        {title}
      </Text>
      {excerpt ? (
        <Text numberOfLines={3} style={[styles.prose, { color: colors.text }]}>
          {excerpt}
        </Text>
      ) : null}
    </View>
  );
}

/** Per-cell retry ladder (`use-image-fallback.ts`) — the thumb 404s until the preview backstop; without this the tile sits on skeleton forever. */
function MosaicCell({
  photo,
  skel,
}: {
  photo: TilePhoto | undefined;
  skel: string;
}): React.JSX.Element {
  const media = useImageFallback(
    photo?.uri ?? "",
    photo?.originalUri,
    photo?.id ?? "empty"
  );
  return (
    <View style={[styles.thumb, { backgroundColor: skel }]}>
      {photo?.uri && !media.failed ? (
        <Image
          source={imageSource(media.source)}
          style={styles.thumbImage}
          {...gridImageProps(media.source)}
          recyclingKey={media.recyclingKey}
          onLoad={media.handleLoad}
          onError={media.handleError}
        />
      ) : null}
    </View>
  );
}

function PhotoMosaic({
  photos,
  colors,
}: {
  photos: readonly TilePhoto[];
  colors: ThemeColors;
}): React.JSX.Element {
  const waiting = mosaicAwaitingBytes(photos);
  const cells = mosaicCells(photos);
  return (
    <View style={styles.body}>
      {/* Drop bottom bleed when a line is showing, or the negative margin pulls the grid over its explanation. */}
      <View style={[styles.mosaic, !waiting && styles.mosaicBleed]}>
        {cells.map((photo, index) => (
          <MosaicCell key={index} photo={photo} skel={colors.skel} />
        ))}
      </View>
      {/* Grey squares with no explanation read as a failed render (rows without bytes). */}
      {waiting ? (
        <Text style={[styles.awaiting, { color: colors.textFaint }]}>
          Photographs live on the gateway — these fill in when it is back.
        </Text>
      ) : null}
    </View>
  );
}

function Skeleton({
  kind,
  colors,
}: {
  kind: TileBodyModel["kind"];
  colors: ThemeColors;
}): React.JSX.Element {
  // No `photos` case: the mosaic draws its own waiting state cell by cell.
  const widths: readonly `${number}%`[] =
    kind === "people" ? ["46%", "46%"] : ["88%", "70%", "54%"];
  return (
    <View
      accessibilityLabel="Loading"
      style={[styles.body, styles.skeletonBody]}
    >
      {/* Key by position, not width — people skeleton is two bars of the SAME width. */}
      {widths.map((width, i) => (
        <View
          key={i}
          style={[
            styles.skeletonBar,
            { backgroundColor: colors.bgSunken, width },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  afterLine: { ...t("small"), marginTop: "auto" },
  awaiting: { ...t("mono"), marginTop: "auto", paddingTop: 6 },
  body: { flex: 1, gap: 4 },
  bodyLine: { ...t("small"), marginTop: "auto" },
  chip: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipLabel: { ...t("eyebrow") },
  checkbox: {
    alignItems: "center",
    borderRadius: radii.sm,
    borderWidth: borders.hairline,
    height: 13,
    justifyContent: "center",
    width: 13,
  },
  docTitle: { ...t("smallStrong") },
  eventAt: { ...t("mono") },
  fileName: { ...t("small"), flex: 1 },
  fileSize: { ...t("mono") },
  eventTitle: { ...t("smallStrong") },
  faces: { alignItems: "center", flexDirection: "row" },
  face: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1.5,
    height: 30,
    justifyContent: "center",
    // Logical overlap so it mirrors under RTL — never `marginLeft`.
    marginEnd: -7,
    width: 30,
  },
  faceInitials: { ...t("smallStrong") },
  figure: {
    ...t("display"),
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
  },
  invite: { ...t("control") },
  // No ground, no min-height: the CELLS are the mosaic. Negative margins cancel `TILE_PAD` so bleed is flush.
  mosaic: {
    flexDirection: "row",
    gap: 2,
    marginHorizontal: -TILE_PAD,
    marginTop: 8,
  },
  mosaicBleed: { marginBottom: -TILE_PAD },
  prose: { ...t("small") },
  ruledRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingVertical: 4,
  },
  skeletonBar: { borderRadius: radii.sm, height: 10 },
  skeletonBody: { gap: 9, paddingTop: 4 },
  taskRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  taskTitle: { ...t("small"), flex: 1 },
  tallyLabel: { ...t("small") },
  // EXPLICIT height, never `aspectRatio` (derived height can be zero). `flex: 1` so four cells + 2px gap share the row.
  thumb: {
    flex: 1,
    height: MOSAIC_CELL_HEIGHT,
    overflow: "hidden",
  },
  thumbImage: { height: "100%", width: "100%" },
});
