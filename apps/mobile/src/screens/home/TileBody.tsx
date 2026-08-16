// The structurally distinct tile bodies (issue #708 A, the Binding Layer brief).
// governance: allow-repo-hygiene file-size-limit The #712 shared tile-body catalog stays together so every blueprint's shape remains comparable in one binding layer.
//
// The header above these is INVARIANT — icon, name, count — and is drawn once by
// ./LauncherGrid. Everything below the header is deliberately NOT invariant:
// Photos is a mosaic that bleeds to the tile edge, Notes is compact prose in the
// body register, Docs is ruled file rows with sizes in the NUMERIC register
// (the two are separated on exactly that axis, because a title-over-an-opening-
// line made them indistinguishable), Agenda pins an after-line to the bottom,
// People is
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
  /** Which identity ring a derived face circle resolves on — the `--c-*` hues
   *  are per theme, and a face is the one place this body paints one. */
  scheme: Scheme;
}): React.JSX.Element {
  // Locker's body is a STATE, not a query result: the lock is closed from
  // Home's point of view whatever the replica knows, so it draws its chip in
  // every status rather than falling through to the loading/empty treatments.
  if (tile.body.kind === "locker")
    return (
      <FilledBody body={tile.body} colors={colors} hue={hue} scheme={scheme} />
    );
  // Photos likewise draws itself in EVERY status. Its body already carries the
  // waiting state per cell — a cell with no bytes yet paints the skeleton
  // ground at the geometry its photograph will occupy — so routing it through
  // the generic skeleton below would replace a grid of cells with one blank
  // rectangle, which is exactly the bug this branch exists to prevent.
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
        // The brief's order is WHEN → title → after (:1083–1098): the time is
        // the numeric-register anchor a member scans for first, the title is
        // what it is, and the after-line — pinned to the tile bottom — answers
        // the question a next-event alone leaves open.
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
          {/* SATURATED discs with inverse ink, one hue per person — the
              handoff's own face treatment. The fill is the person's stored
              `avatar_color` when they have chosen one, and otherwise the
              identity wheel resolved from their `party_id` (`identityFill`,
              shared with the desktop grid so one person is one colour on every
              client). Without the derivation these were `bgSunken` discs with
              `text` initials — near-white circles with grey letters, which is
              a row of empty pills rather than a row of people.

              The ink is the INVERSE ink on a derived circle — the `--c-*` ring
              is solved for it in both themes (5.62:1 at worst in light, 7.47:1
              in dark; see packages/design/src/identity.test.ts). A STORED
              colour is a fixed hex that does not follow the theme, so
              `identityInk` measures rather than assumes. */}
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
          {/* The brief pins a text line under the faces (:1122–1141), and the
              prototype's own line ("You owe Ana a letter") is prose mobile has
              no read path for — there is no per-person correspondence data on
              this device. `more` is the closest thing the read actually gives:
              the rest of the directory the circles are a sample of, off the
              same real total the header counts. Never a fabricated 0 — a
              directory the circles already exhaust says so plainly instead of
              going blank. */}
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
                    // Ink, not the app's hue (:5067's `t.accent`): a hue-filled
                    // box read as a second app identity competing with the
                    // header chip on the same tile. `colors.accent` is the
                    // ramp's one ink rung. DONE is a filled box with NO glyph
                    // inside (:5066–5068) — the fill alone is the mark.
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
          {/* The brief's third line (:5079/:1174), pinned to the tile bottom
              exactly like Agenda's after-line — mobile only renders it once a
              caller has something true to put there (see the `after?` note on
              TileBody in ./tile-model). */}
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
          {/* No icon (:5082–5085): a lock glyph next to a chip reading
              "Locked" says the same thing twice. The chip is a STATE label —
              micro-caps, tracked, coloured at the app's own -text hue rung
              (the `hue` prop, already that exact rung — see
              `iconChipFinish`/`APP_HUES`) — not a generic control. */}
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
          {/* Locker's body is a STATE, not a query result (its items are
              sealed behind an online, session-gated RPC — see the honesty
              rules atop ./tile-model), so this line stays the instructional
              one the tile already drew rather than the prototype's sample
              fixture text ("One shelf · deeds and titles"): a shelf count
              mobile cannot read is not something the tile is entitled to
              claim, however plausible it looks in a mock. */}
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

/**
 * The Docs body: ruled rows, file name and size in the numeric register.
 *
 * Docs and Notes both hold text, and when both drew a title over an opening
 * line they were two tiles you could not tell apart at a glance — the exact
 * failure a per-app body exists to prevent. A file list is what a document tile
 * is FOR: which files are there, and how big they are.
 *
 * The rules are hairlines between rows and never a border around the group: a
 * ruled list is a rhythm, and a box around it would make the body look like a
 * second card inside the tile.
 */
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
          {/* A size with no byte count recorded renders nothing rather than a
              zero — the row is still a true row, it just says less. */}
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
        // A Home tile is a compact preview, not the document reading view.
        // Keep its prose on the shared body register so Docs, Notes and Tasks
        // share the same ink and density across the web and native surfaces.
        <Text numberOfLines={3} style={[styles.prose, { color: colors.text }]}>
          {excerpt}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The mosaic is ALWAYS a grid of cells — never one rectangle.
 *
 * It renders a fixed `MOSAIC_SLOTS` of them in every state, which is what makes
 * the geometry stable: the tile looks the same the instant it mounts, while the
 * read is in flight, while the bytes are being fetched, and once they land. The
 * only thing that changes is what each cell contains.
 *
 * This is the fix for a Photos tile that rendered as one large blank grey
 * rectangle on a seeded vault. Two paths produced it and both bypassed the
 * per-cell contract: the generic loading skeleton drew a single `bgSunken` box,
 * and an empty `photos` array left this container drawing only its own ground.
 * Both are gone — the container itself is now transparent, so if a cell ever
 * fails to lay out there is nothing left behind to masquerade as a tile.
 *
 * Cells take an EXPLICIT height rather than `aspectRatio`, because a cell that
 * resolves to zero height is invisible against a container that has a minimum
 * one, which is precisely how a layout bug here disguises itself as a design.
 * A real 2px `gap` (:5044) is what makes them read as separate cells while
 * they are all still grey — not a border, which the brief's thumbs never draw.
 *
 * FOUR cells in ONE row (:5044–5046, `repeat(4,1fr)`, `slice(0, mob?4:8)`),
 * not the desktop's eight across two rows: mobile is one row across the whole
 * width, always.
 *
 * The negative side margins let the grid reach the tile edge (the brief's word)
 * instead of sitting inside the tile's padding; the tile clips with
 * `overflow: hidden`. They exactly cancel `TILE_PAD` (./tile-model) — the same
 * padding ./LauncherGrid gives the card — so the bleed is provably flush
 * rather than flush by coincidence of two numbers kept in step by hand.
 *
 * The slot count and the cell height live in ./tile-model beside the selection
 * rules, so the geometry this tile depends on is asserted by a unit test rather
 * than only by looking at a phone.
 */
/**
 * ONE mosaic slot. A component rather than inline JSX because the cell needs
 * the retry ladder, and a ladder needs state per cell — the thumb URL the
 * mosaic builds 404s until the gateway's preview backstop has generated it,
 * and this tile has no failure state at all: it simply sat on its skeleton
 * ground for ever, so a vault full of photographs looked like a vault with no
 * bytes. `use-image-fallback.ts` carries the full reasoning.
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
      {/* The bottom bleed is dropped when the tile has a line to show, or the
          negative margin would pull the grid over its own explanation. */}
      <View style={[styles.mosaic, !waiting && styles.mosaicBleed]}>
        {cells.map((photo, index) => (
          <MosaicCell
            // Positional: the slot exists whether or not a photograph has
            // arrived for it, so the slot — not the asset — is the identity.
            key={index}
            photo={photo}
            skel={colors.skel}
          />
        ))}
      </View>
      {/* A grid of grey squares with no explanation reads as a failed render,
          and that is exactly what a gateway-side vault looks like from a
          phone that has the rows but not the bytes. */}
      {waiting ? (
        // Verbatim brief copy (:5042–5043), and MONO — the one prose line on
        // Home that is not sans or serif, because it is reporting a system
        // fact (where the bytes are) rather than writing to the member.
        <Text style={[styles.awaiting, { color: colors.textFaint }]}>
          Photographs live on the gateway — these fill in when it is back.
        </Text>
      ) : null}
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
  // No `photos` case: the mosaic draws its own waiting state, cell by cell, and
  // `TileBody` routes photos straight to it in every status.
  const widths: readonly `${number}%`[] =
    kind === "people" ? ["46%", "46%"] : ["88%", "70%", "54%"];
  return (
    <View
      accessibilityLabel="Loading"
      style={[styles.body, styles.skeletonBody]}
    >
      {/* Keyed by position, not by width: the people skeleton is two bars of
          the SAME width, so the width string is not a unique identity. The
          list is a fixed literal that never reorders, so the index is. */}
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
  // Shared by Agenda's after-line and Tally's third line (:5057/:5174 both
  // draw from the brief's one `eventAfterCss`): pinned to the tile bottom by
  // `marginTop: "auto"` in a non-centered flex column, so it reads as the
  // answer sitting apart from the rest of the body, not another row of it.
  afterLine: { ...t("small"), marginTop: "auto" },
  awaiting: { ...t("mono"), marginTop: "auto", paddingTop: 6 },
  body: { flex: 1, gap: 4 },
  // Pinned to the tile bottom exactly like `afterLine`, but in `t.ink` rather
  // than `t.ink3` (:5077's `lineCss`): People's and Locker's second line is a
  // plain sentence, not a muted aside the way the after-lines are.
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
    // Logical, so the overlap mirrors under RTL — the handoff's own mechanism
    // (:5072–5074's `margin-inline-end:-7px`), not a hardcoded `marginLeft`.
    marginEnd: -7,
    width: 30,
  },
  // The handoff uses the section role for initials: the people are content,
  // not a micro control. `smallStrong` is that role's shared lowering.
  faceInitials: { ...t("smallStrong") },
  // A large numeric figure uses the display rung while keeping tabular digits.
  figure: {
    ...t("display"),
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
  },
  invite: { ...t("control") },
  // No ground of its own and no minimum height: the CELLS are the mosaic. A
  // container that paints and sizes itself is a container that still looks like
  // a tile when every cell inside it has failed to lay out.
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
  // The Tally figure's caption (:5081's `figureLabelCss`, 13px sans/ink2) —
  // distinct from `invite`/`chipLabel`, which sit at other weights and roles.
  tallyLabel: { ...t("small") },
  // An EXPLICIT height, not `aspectRatio`: a percentage-width cell whose height
  // is derived can resolve to zero, and a zero-height cell inside a container
  // with its own minimum height is invisible — it looks exactly like a designed
  // blank rectangle. `flex: 1` (not a percentage width) is what lets FOUR cells
  // and a real 2px `gap` share the row without overflowing it — CSS grid's
  // `repeat(4,1fr)` has no percentage-width RN equivalent that also respects a
  // sibling `gap`.
  thumb: {
    flex: 1,
    height: MOSAIC_CELL_HEIGHT,
    overflow: "hidden",
  },
  // The image fills the cell it was already given, so the skeleton ground under
  // it is the exact geometry the photograph lands in — never a resize.
  thumbImage: { height: "100%", width: "100%" },
});
