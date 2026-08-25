// The structurally distinct tile bodies (#708 A, the Binding Layer brief).
// governance: allow-repo-hygiene file-size-limit The #712 shared tile-body catalog stays together so every blueprint's shape remains comparable in one binding layer.
//
// The header above these is INVARIANT and drawn once by `LauncherGrid`.
// Everything below it is deliberately NOT: a member should be able to name the
// app from the shape of the body alone, which is why Docs is ruled file rows
// and Notes is prose — a title over an opening line made them
// indistinguishable.
//
// Two states are drawn here too:
//
//  - `loading` renders STATIC skeletons. Never a spinner: a spinner says the
//    app is blocked, and the springboard stays usable while a pull settles.
//  - `empty`/`unknown` renders the app's what-to-do line. Nothing here
//    fabricates a count or a row.

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
  /** Which identity ring a derived face circle resolves on: the `--c-*` hues
   *  are per theme. */
  scheme: Scheme;
}): React.JSX.Element {
  // Locker's body is a STATE, not a query result, so it draws its chip in every
  // status rather than falling through to loading/empty.
  if (tile.body.kind === "locker")
    return (
      <FilledBody body={tile.body} colors={colors} hue={hue} scheme={scheme} />
    );
  // Photos likewise draws in EVERY status: it carries the waiting state per
  // cell, and the generic skeleton below would replace that grid with one blank
  // rectangle.
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
        // WHEN → title → after (:1083–1098): the time is the numeric anchor a
        // member scans for first.
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
          {/* SATURATED discs, one hue per person: the stored `avatar_color`,
              else `identityFill` off `party_id` — shared with the desktop grid,
              so one person is one colour on every client. Without the
              derivation these are near-white discs with grey letters.

              `identityInk` MEASURES rather than assumes, because a stored
              colour is a fixed hex that does not follow the theme. */}
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
          {/* The brief's line under the faces (:1122–1141) is prose mobile has
              no read path for, so this states `more` — the rest of the
              directory the circles sample, off the total the header counts.
              Never a fabricated 0; an exhausted directory says so plainly. */}
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
                    // Ink, never the app's hue: a hue-filled box reads as a
                    // second identity competing with the header chip. DONE is a
                    // filled box with NO glyph (:5066–5068).
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
          {/* The brief's third line (:5079/:1174), rendered only once a caller
              has something true to put there (see `after?` in ./tile-model). */}
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
          {/* No icon (:5082–5085): a lock glyph beside "Locked" says it twice.
              A STATE label at the app's own -text hue rung, not a control. */}
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
          {/* Instructional, never the prototype's "One shelf · deeds and
              titles": a shelf count mobile cannot read is not something this
              tile may claim, however plausible the mock. */}
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

/** Hairlines BETWEEN rows and never a border around the group: a ruled list is
 *  a rhythm, and a box would make the body a second card inside the tile. */
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
          {/* No recorded byte count renders nothing, never a zero. */}
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
        // A compact preview, not the reading view: keep this on the shared body
        // register so Docs, Notes and Tasks match across web and native.
        <Text numberOfLines={3} style={[styles.prose, { color: colors.text }]}>
          {excerpt}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * ONE mosaic slot, a component rather than inline JSX because the cell needs
 * the retry ladder and a ladder needs state per cell: the thumb URL 404s until
 * the gateway's preview backstop generates it, and without this the tile has no
 * failure state and sits on its skeleton ground for ever
 * (`use-image-fallback.ts`).
 */
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
      {/* Bottom bleed drops when there is a line to show, or the negative
          margin pulls the grid over its own explanation. */}
      <View style={[styles.mosaic, !waiting && styles.mosaicBleed]}>
        {cells.map((photo, index) => (
          <MosaicCell
            // Positional: the SLOT is the identity, not the asset — it exists
            // whether or not a photograph has arrived for it.
            key={index}
            photo={photo}
            skel={colors.skel}
          />
        ))}
      </View>
      {/* A grid of grey squares with no explanation reads as a failed render —
          which is what a gateway-side vault looks like from a phone holding the
          rows but not the bytes. */}
      {waiting ? (
        // Verbatim brief copy (:5042–5043), and MONO: the one prose line on
        // Home reporting a system fact rather than writing to the member.
        <Text style={[styles.awaiting, { color: colors.textFaint }]}>
          Photographs live on the gateway — these fill in when it is back.
        </Text>
      ) : null}
    </View>
  );
}

/** Sized like the body they stand in for, so the tile does not resize when the
 *  read settles. No animation: a pulsing skeleton is a spinner with steps. */
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
      {/* Keyed by position, not width: the people skeleton is two bars of the
          SAME width. The list is a fixed literal that never reorders. */}
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
  // Shared by Agenda's after-line and Tally's third line (:5057/:5174, one
  // `eventAfterCss`), pinned to the tile bottom so it reads apart from the body.
  afterLine: { ...t("small"), marginTop: "auto" },
  awaiting: { ...t("mono"), marginTop: "auto", paddingTop: 6 },
  body: { flex: 1, gap: 4 },
  // Like `afterLine` but full ink (:5077): People's and Locker's second line is
  // a plain sentence, not a muted aside.
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
    // Logical, so the overlap mirrors under RTL (:5072–5074) — never
    // `marginLeft`.
    marginEnd: -7,
    width: 30,
  },
  // The section role: the people are content, not a micro control.
  faceInitials: { ...t("smallStrong") },
  figure: {
    ...t("display"),
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
  },
  invite: { ...t("control") },
  // No ground and no minimum height: the CELLS are the mosaic. A container that
  // paints and sizes itself still looks like a tile when every cell has failed
  // to lay out. The negative margins exactly cancel `TILE_PAD`, which is what
  // makes the bleed provably flush to the tile edge.
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
  // The Tally caption (:5081), distinct from `invite`/`chipLabel`.
  tallyLabel: { ...t("small") },
  // EXPLICIT height, never `aspectRatio`: a derived height can resolve to zero,
  // and a zero-height cell in a min-height container looks like a designed
  // blank rectangle. `flex: 1`, not a percentage width, is what lets four cells
  // and a real 2px `gap` share the row without overflowing.
  thumb: {
    flex: 1,
    height: MOSAIC_CELL_HEIGHT,
    overflow: "hidden",
  },
  // Fills the cell it was already given, so the skeleton ground under it is the
  // exact geometry the photograph lands in — never a resize.
  thumbImage: { height: "100%", width: "100%" },
});
