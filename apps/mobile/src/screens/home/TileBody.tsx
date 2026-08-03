// The structurally distinct tile bodies (issue #708 A, the Binding Layer brief).
//
// The header above these is INVARIANT — icon, name, count — and is drawn once by
// ./LauncherGrid. Everything below the header is deliberately NOT invariant:
// Photos is a mosaic that bleeds to the tile edge, Docs and Notes are prose in
// the READING register, Agenda pins an after-line to the tile bottom, People is
// overlapping circles, Tasks is checkboxes with exactly one struck through,
// Tally is a single figure in the numeric register, Locker is a state chip.
// A user should be able to name the app from the shape of the body alone.
//
// Two states are drawn here as well, both from the brief's "working" language:
//
//  - `loading` renders STATIC skeletons. Never a spinner: a spinner says the app
//    is blocked, and the springboard stays usable while a replica pull settles.
//  - `empty`/`unknown` renders the app's what-to-do line, so a quiet tile is an
//    invitation rather than a hole. Nothing here fabricates a count or a row.

import { Image } from "expo-image";
import React from "react";
import { StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { radii, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { TILE_EMPTY_COPY } from "./tile-model";
import type { TileBody as TileBodyModel, TileData } from "./tile-model";

export default function TileBody({
  tile,
  colors,
  hue,
}: {
  tile: TileData;
  colors: ThemeColors;
  hue: string;
}): React.JSX.Element {
  // Locker's body is a STATE, not a query result: the lock is closed from
  // Home's point of view whatever the replica knows, so it draws its chip in
  // every status rather than falling through to the loading/empty treatments.
  if (tile.body.kind === "locker")
    return <FilledBody body={tile.body} colors={colors} hue={hue} />;
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
  return <FilledBody body={tile.body} colors={colors} hue={hue} />;
}

function FilledBody({
  body,
  colors,
  hue,
}: {
  body: TileBodyModel;
  colors: ThemeColors;
  hue: string;
}): React.JSX.Element {
  switch (body.kind) {
    case "photos":
      return <PhotoMosaic photos={body.photos} colors={colors} />;
    case "docs":
    case "notes":
      return (
        <Prose title={body.title} excerpt={body.excerpt} colors={colors} />
      );
    case "agenda":
      return (
        <View style={styles.body}>
          <Text
            numberOfLines={2}
            style={[styles.eventTitle, { color: colors.text }]}
          >
            {body.title}
          </Text>
          <Text style={[styles.eventAt, { color: colors.textSoft }]}>
            {body.at}
          </Text>
          {/* Pinned to the tile bottom by the brief: the after-line is the
              answer to the question a next-event alone leaves open, and it
              only reads as an answer when it sits apart from the event. */}
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
          <View style={styles.faces}>
            {body.faces.map((face, index) => (
              <View
                key={face.id}
                style={[
                  styles.face,
                  {
                    backgroundColor: face.color ?? colors.bgSunken,
                    borderColor: colors.bgElev,
                    marginLeft: index === 0 ? 0 : -12,
                    zIndex: body.faces.length - index,
                  },
                ]}
              >
                <Text style={[styles.faceInitials, { color: colors.text }]}>
                  {face.initials}
                </Text>
              </View>
            ))}
            {/* The brief's "+ one line": the rest of the directory the circles
                sample, in the numeric register, exactly as desktop draws it. */}
            {body.more > 0 ? (
              <Text style={[styles.facesMore, { color: colors.textFaint }]}>
                {`+${body.more}`}
              </Text>
            ) : null}
          </View>
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
                    borderColor: row.done ? hue : colors.lineStrong,
                    backgroundColor: row.done ? hue : "transparent",
                  },
                ]}
              >
                {row.done ? (
                  <Icon name="Check" size={10} color={colors.bgElev} />
                ) : null}
              </View>
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
        <View style={[styles.body, styles.figureBody]}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.figure, { color: colors.text }]}
          >
            {body.figure}
          </Text>
          <Text style={[styles.caption, { color: colors.textFaint }]}>
            {body.caption}
          </Text>
        </View>
      );
    case "locker":
      return (
        <View style={[styles.body, styles.figureBody]}>
          <View
            style={[
              styles.chip,
              { backgroundColor: colors.bgSunken, borderColor: colors.line },
            ]}
          >
            <Icon
              name={body.locked ? "Lock" : "Check"}
              size={13}
              color={colors.textSoft}
            />
            <Text style={[styles.chipLabel, { color: colors.textSoft }]}>
              {body.locked ? "Locked" : "Unlocked"}
            </Text>
          </View>
          <Text style={[styles.caption, { color: colors.textFaint }]}>
            {body.locked ? "Opens with your passphrase" : "Open on this device"}
          </Text>
        </View>
      );
  }
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
        // The reading register, serif — this is prose, and the whole point of
        // the second register is that prose does not look like UI text.
        <Text
          numberOfLines={2}
          style={[styles.prose, { color: colors.textSoft }]}
        >
          {excerpt}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Full-bleed mosaic. The negative margins are what let the thumbnails reach the
 * tile edge (the brief's word) instead of sitting inside the tile's padding;
 * the tile clips them with `overflow: hidden`.
 */
function PhotoMosaic({
  photos,
  colors,
}: {
  photos: readonly { id: string; uri: string }[];
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={[styles.mosaic, { backgroundColor: colors.bgSunken }]}>
      {photos.slice(0, 6).map((photo) => (
        <Image
          key={photo.id}
          source={imageSource(photo.uri)}
          style={styles.thumb}
          {...gridImageProps(photo.uri)}
        />
      ))}
    </View>
  );
}

/**
 * Static placeholders, sized like the body they stand in for, so the tile does
 * not resize when the read settles. No animation: a pulsing skeleton is a
 * spinner with extra steps.
 */
function Skeleton({
  kind,
  colors,
}: {
  kind: TileBodyModel["kind"];
  colors: ThemeColors;
}): React.JSX.Element {
  if (kind === "photos")
    return (
      <View style={[styles.mosaic, { backgroundColor: colors.bgSunken }]} />
    );
  const widths: readonly `${number}%`[] =
    kind === "people" ? ["46%", "46%"] : ["88%", "70%", "54%"];
  return (
    <View
      accessibilityLabel="Loading"
      style={[styles.body, styles.skeletonBody]}
    >
      {widths.map((width) => (
        <View
          key={width}
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
  afterLine: { ...t("mono"), marginTop: "auto" },
  body: { flex: 1, gap: 4 },
  caption: { ...t("control") },
  chip: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipLabel: { ...t("control") },
  checkbox: {
    alignItems: "center",
    borderRadius: radii.sm,
    borderWidth: 1.2,
    height: 15,
    justifyContent: "center",
    width: 15,
  },
  docTitle: { ...t("smallStrong") },
  eventAt: { ...t("mono") },
  eventTitle: { ...t("smallStrong") },
  faces: { alignItems: "center", flexDirection: "row" },
  face: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 2,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  faceInitials: { ...t("control") },
  facesMore: { ...t("mono"), marginLeft: 8 },
  // The numeric register, scaled: the ramp carries one mono role, and the
  // brief's "one large figure" is that role at display size — same family,
  // same tabular figures, so digits still align column-wise.
  figure: { ...t("mono"), fontSize: 30, lineHeight: 36 },
  figureBody: { justifyContent: "center" },
  invite: { ...t("control") },
  mosaic: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: -14,
    marginHorizontal: -14,
    marginTop: 2,
    minHeight: 84,
  },
  prose: { ...t("reading") },
  skeletonBar: { borderRadius: radii.sm, height: 10 },
  skeletonBody: { gap: 9, paddingTop: 4 },
  taskRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  taskTitle: { ...t("control"), flex: 1 },
  thumb: { aspectRatio: 1, width: "33.333%" },
});
