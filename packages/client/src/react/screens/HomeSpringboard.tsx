// The Home springboard (issue #708, section A).
//
// Tier-1 CONTENT tiles, not an icon launcher. The header is invariant — app
// mark, app name at the UI role, count in the numeric register — and the body
// is structurally different per app, because the content is. That division is
// the whole design: the header is what makes eight apps one house, the body is
// what makes them eight rooms.
//
// The vault-level conditions (out of room, two devices disagree) sit ABOVE the
// tiles rather than in Settings, because Home is the front door and those are
// facts about the vault, not about a preferences page.
import type { JSX } from "react";

import { iconChipRadius, identityHueKey } from "@centraid/design";
import type { IconName } from "@centraid/design";

import {
  HOME_FIRST_RUN_BODY,
  HOME_FIRST_RUN_TITLE,
  HOME_SAMPLE_CLEAR,
  HOME_SAMPLE_FILLING,
  HOME_SAMPLE_FILLING_APP,
  HOME_SAMPLE_FILLING_CATCH_UP,
  HOME_SAMPLE_FILLING_UNIT,
  HOME_SAMPLE_LOADED_BODY,
  HOME_SAMPLE_LOADED_TITLE,
  HOME_SAMPLE_OFFER_HINT,
  HOME_SAMPLE_OFFER_LABEL,
  HOME_SAMPLE_OFFER_LEAD,
  HOME_START_LEAD,
  HOME_START_TITLE,
} from "../../home-copy.js";
import type { HomeSampleProgress } from "../shell/routes/homeSample.js";
import {
  homeFirstMoves,
  partitionHomeTiles,
} from "../shell/routes/homeTiles.js";
import type {
  HomeFirstMove,
  HomeTileBody,
  HomeTileModel,
} from "../shell/routes/homeTiles.js";
import Button from "../ui/Button.js";
import { Icon } from "../ui/index.js";
import { DevicesDisagree, OutOfRoom, WorkingState } from "../ui/states.js";
import type { DevicesDisagreeProps, OutOfRoomProps } from "../ui/states.js";

import styles from "./HomeSpringboard.module.css";

const MARK = 30;
const FIRST_RUN_MARK = 22;

/** The app's identity hue, and the only place a tile spends one. */
const hueOf = (colorKey: string): string => `var(--c-${colorKey})`;

function Mark({
  iconKey,
  colorKey,
  size,
  className,
}: {
  iconKey: IconName;
  colorKey: string;
  size: number;
  /* `string | undefined`, not `string`: a CSS-module lookup is an index read,
     and the desktop's React program checks it as one. A required `string` here
     type-errors at every call site under that program while passing under the
     client's — which is how this went unnoticed until the desktop typecheck
     ran (see docs/traps/worktrees.md on per-program drift). */
  className: string | undefined;
}): JSX.Element {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        background: hueOf(colorKey),
        // 26% of its own size — the one radius no static token can carry.
        borderRadius: `${iconChipRadius(size)}px`,
      }}
    >
      <Icon name={iconKey} size={Math.round(size * 0.56)} strokeWidth={1.9} />
    </span>
  );
}

function TileBody({ body }: { body: HomeTileBody }): JSX.Element {
  switch (body.kind) {
    case "photos":
      return (
        <div className={styles.mosaic}>
          {body.thumbs.map((src) => (
            <img className={styles.mosaicCell} key={src} src={src} alt="" />
          ))}
          {body.more > 0 ? (
            <span
              className={styles.mosaicMore}
            >{`+${body.more.toLocaleString()}`}</span>
          ) : null}
        </div>
      );
    case "docs":
      return (
        <div className={styles.body}>
          <p className={styles.readingTitle}>{body.title}</p>
          {body.excerpt ? (
            <p className={styles.reading}>{body.excerpt}</p>
          ) : null}
        </div>
      );
    case "agenda":
      return (
        <div className={styles.body}>
          <span className={styles.eventTime}>{body.at}</span>
          <p className={styles.eventTitle}>{body.title}</p>
          {/* Pinned to the tile bottom whatever the title above it does. */}
          {body.after ? (
            <span className={styles.afterLine}>{body.after}</span>
          ) : null}
        </div>
      );
    case "people":
      return (
        <div className={styles.body}>
          <div className={styles.faces}>
            {/* Coloured, because a person is the subject here — a row of grey
                pills reads as another table; the handoff's faces read as
                people, which is the whole argument for the tile.

                Derived from the PARTY ID and painted through the `--c-<hue>`
                custom property rather than an inline hex, for two reasons the
                previous name-hashed `identityColor` got wrong: a rename must
                not repaint a person (and the phone's Home derives from the
                same id, so the two clients agree), and `--c-*` is per theme,
                so `--text-inv` clears AA on it in DARK as well — an inline
                light-ring hex left near-black initials on it at 3.1:1. */}
            {body.faces.map((face) => (
              <span
                className={styles.face}
                key={face.id}
                style={{ background: `var(--c-${identityHueKey(face.id)})` }}
                title={face.name}
              >
                {face.initials}
              </span>
            ))}
            {body.more > 0 ? (
              <span
                className={styles.facesMore}
              >{`+${body.more.toLocaleString()}`}</span>
            ) : null}
          </div>
        </div>
      );
    case "tasks":
      return (
        <div className={styles.body}>
          <ul className={styles.taskRows}>
            {body.rows.map((row) => (
              <li
                className={styles.taskRow}
                data-done={String(row.done)}
                key={row.title}
              >
                <span className={styles.taskBox} aria-hidden="true" />
                <span className={styles.taskText}>{row.title}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "tally":
      return (
        <div className={styles.body}>
          <span className={styles.figure}>{body.figure}</span>
          <span className={styles.figureCaption}>{body.caption}</span>
        </div>
      );
    case "locker":
      return (
        <div className={styles.body}>
          <span className={styles.chip} data-tone={body.tone}>
            {body.chip}
          </span>
        </div>
      );
    case "notes":
      return (
        <div className={styles.body}>
          <p className={`${styles.reading} ${styles.noteLine}`}>{body.line}</p>
          <span className={styles.readingStamp}>{body.at}</span>
        </div>
      );
    case "empty":
      // `empty` is partitioned out of the grid into first-moves (see
      // `partitionHomeTiles`). Kept exhaustive so type-aware lint catches new
      // body kinds; rendering an empty body would put both treatments on screen.
      return <div className={styles.body} />;
  }
}

function Tile({
  tile,
  onOpen,
}: {
  tile: HomeTileModel;
  onOpen: (id: string) => void;
}): JSX.Element {
  // The accessible name is the whole header sentence — a reader tabbing the
  // grid hears "Photos, 1,204 photos", which is what a sighted reader sees.
  const label =
    tile.count === null
      ? tile.name
      : `${tile.name}, ${tile.count.toLocaleString()} ${tile.countLabel}`;
  return (
    <button
      type="button"
      className={styles.tile}
      data-app-id={tile.id}
      data-size={tile.size}
      data-testid="home-tile"
      aria-label={label}
      onClick={() => onOpen(tile.id)}
    >
      <span className={styles.head}>
        <Mark
          className={styles.mark}
          colorKey={tile.colorKey}
          iconKey={tile.iconKey}
          size={MARK}
        />
        <span className={styles.name}>{tile.name}</span>
        {tile.count === null ? null : (
          <span className={styles.count}>{tile.count.toLocaleString()}</span>
        )}
      </span>
      <TileBody body={tile.body} />
    </button>
  );
}

/**
 * One first move — a door into somewhere that can actually take content.
 *
 * Dashed, because a dashed border reads as "not filled in yet" where a solid one
 * reads as "this is the finished thing, and it is empty". The geometry, the mark
 * and the type are the tile's own, so a move becoming a tile is a FILL rather
 * than a re-layout.
 */
function FirstMove({
  move,
  onPick,
  compact,
}: {
  move: HomeFirstMove;
  onPick: (move: HomeFirstMove) => void;
  /** The band under a populated grid: label only, one row tall. */
  compact?: boolean;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={styles.move}
        data-app-id={move.id}
        data-compact={compact ? "true" : undefined}
        data-testid="home-first-move"
        onClick={() => onPick(move)}
      >
        <Mark
          className={styles.moveMark}
          colorKey={move.colorKey}
          iconKey={move.iconKey}
          size={FIRST_RUN_MARK}
        />
        <span className={styles.moveText}>
          <span className={styles.moveLabel}>{move.label}</span>
          {compact ? null : (
            <span className={styles.moveHint}>{move.hint}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * Day one — the vault has no content ANYWHERE.
 *
 * The copy is the brief's, verbatim, out of the shared constants (mobile draws
 * the same two sentences from the same module, because one state may not have
 * two spellings). What sits under it changed: the four dashed rectangles used to
 * open the empty app they were named after, which is a dead end wearing an
 * invitation. They are now the four things that actually put something on this
 * page — and the copy finally offers what it promises, since "bring your
 * photographs and documents in" now has a control that does it.
 */
function DayOne({
  moves,
  onPick,
}: {
  moves: readonly HomeFirstMove[];
  onPick: (move: HomeFirstMove) => void;
}): JSX.Element {
  return (
    <section className={styles.firstRun} data-testid="home-first-run">
      <h2 className={styles.firstRunTitle}>{HOME_FIRST_RUN_TITLE}</h2>
      <p className={styles.firstRunBody}>{HOME_FIRST_RUN_BODY}</p>
      <p className={styles.startLead}>{HOME_START_LEAD}</p>
      <ul className={styles.moves}>
        {moves.map((move) => (
          <FirstMove key={move.id} move={move} onPick={onPick} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The start band — what the apps with nothing in them become once at least one
 * app HAS something.
 *
 * Three, not all of them: the band is a nudge under a page that is already
 * working, and a nudge as tall as the grid stops being one.
 */
function StartBand({
  moves,
  onPick,
}: {
  moves: readonly HomeFirstMove[];
  onPick: (move: HomeFirstMove) => void;
}): JSX.Element {
  return (
    <section className={styles.startBand} data-testid="home-start-band">
      <h2 className={styles.startTitle}>{HOME_START_TITLE}</h2>
      <ul className={styles.moves}>
        {moves.map((move) => (
          <FirstMove key={move.id} move={move} onPick={onPick} compact />
        ))}
      </ul>
    </section>
  );
}

/**
 * The sample offer.
 *
 * It sits BELOW the real first moves, behind a rule, phrased as a question
 * rather than a step — because ordering is an argument. Putting "fill it with
 * fake data" above "connect your account" would tell a member the demo matters
 * more than their own archive, on the one screen where that claim is being
 * made for the first time.
 *
 * The hint is not a caption; it is the disclosure, and it is placed where a
 * disclosure belongs — BEFORE the control, not underneath it as an apology.
 * Three facts, in the order they matter: the content is invented, nothing
 * leaves the device, one tap undoes it.
 *
 * Pressing REPLACES the control with the working state rather than disabling
 * it in place. The fill takes about ten seconds — seven generators, of which
 * the photo one is ten uploads — and a disabled button wearing a fixed
 * sentence is the exact shape of a surface that has hung. The working state is
 * the designed answer and it already exists (`ui/states.tsx`): the act named
 * as a sentence, the exact counts beside it, a proportional rule under both,
 * and no spinner anywhere. Home keeps working behind it, which is why this is
 * a block in the offer rather than an overlay over the page.
 */
function SampleOffer({
  seed,
  filling,
}: {
  seed: () => void;
  filling: HomeSampleProgress | null;
}): JSX.Element {
  return (
    <section className={styles.offer} data-testid="home-sample-offer">
      <p className={styles.offerLead}>{HOME_SAMPLE_OFFER_LEAD}</p>
      <p className={styles.offerHint}>{HOME_SAMPLE_OFFER_HINT}</p>
      {filling ? (
        <WorkingState
          className={styles.offerProgress}
          label={fillLabel(filling)}
          progress={{
            done: filling.done,
            total: filling.total,
            unit: HOME_SAMPLE_FILLING_UNIT,
          }}
        />
      ) : (
        <Button
          className={styles.offerAction}
          label={HOME_SAMPLE_OFFER_LABEL}
          variant="secondary"
          onClick={seed}
        />
      )}
    </section>
  );
}

/**
 * The fill's sentence for one moment of it.
 *
 * No app named means the generators are done and the run is on its closing
 * replica catch-up — the step that would otherwise read as the bar arriving at
 * the end and Home staying empty for another beat.
 */
function fillLabel(progress: HomeSampleProgress): string {
  if (progress.appId === undefined) return HOME_SAMPLE_FILLING_CATCH_UP;
  return HOME_SAMPLE_FILLING_APP[progress.appId] ?? HOME_SAMPLE_FILLING;
}

/**
 * What Home says while the sample is loaded.
 *
 * ONE line, at vault level, in the same band as "out of room" and "two devices
 * disagree" — because "some of what you are looking at is not yours" is a fact
 * about the vault, exactly like those. Deliberately NOT a badge per tile: eight
 * badges is the eight-apologies failure again, and it would make the sample
 * feel like damage rather than a demo.
 */
function SampleLoaded({
  clear,
  clearing,
}: {
  clear: () => void;
  clearing: boolean;
}): JSX.Element {
  return (
    <section className={styles.sampleNote} data-testid="home-sample-note">
      <span className={styles.sampleMark} aria-hidden="true">
        <Icon name="Eye" size={13} strokeWidth={2} />
      </span>
      <span className={styles.sampleText}>
        <span className={styles.sampleTitle}>{HOME_SAMPLE_LOADED_TITLE}</span>
        <span className={styles.sampleBody}>{HOME_SAMPLE_LOADED_BODY}</span>
      </span>
      <Button
        className={styles.sampleAction}
        label={clearing ? "Clearing…" : HOME_SAMPLE_CLEAR}
        variant="secondary"
        disabled={clearing}
        onClick={clear}
      />
    </section>
  );
}

/** Moves shown beneath a populated grid. Fewer than day one's four — a nudge as
 *  tall as the grid it sits under stops being a nudge. */
const BAND_MOVES = 3;

export interface HomeSpringboardProps {
  tiles: readonly HomeTileModel[];
  /** The reads are still in flight: static skeletons, never a spinner. */
  loading: boolean;
  onOpen: (id: string) => void;
  /** The one first move that is not an app surface. */
  onConnect: () => void;
  /** Vault-level conditions, wired to their real signals by the route. */
  outOfRoom?: OutOfRoomProps;
  conflicts?: readonly DevicesDisagreeProps[];
  /** The sample: offerable when the vault ships scenarios, present when loaded. */
  sample?: {
    canSeed: boolean;
    loaded: boolean;
    /** Where the fill has got to, or null when no fill is running. Not a
     *  boolean: "it is filling" is not a thing this screen can usefully say. */
    filling: HomeSampleProgress | null;
    clearing: boolean;
    onSeed: () => void;
    onClear: () => void;
  };
  /** True for the one render after a seed lands — the grid arrives staggered
   *  ONCE, as the payoff for pressing, and never again on a routine revisit. */
  justFilled?: boolean;
}

export default function HomeSpringboard({
  tiles,
  loading,
  onOpen,
  onConnect,
  outOfRoom,
  conflicts,
  sample,
  justFilled = false,
}: HomeSpringboardProps): JSX.Element {
  // Graded, not binary (issue #708). A tile earns the grid by having something
  // to show; everything else becomes an invitation. So Home is never a wall of
  // apologies, and it FILLS IN — the same page, one tile richer — rather than
  // switching between two unrelated layouts at the first piece of content.
  const { live, idle } = partitionHomeTiles(tiles);
  const dayOne = live.length === 0;
  const moves = homeFirstMoves(idle, dayOne ? undefined : BAND_MOVES);
  const pick = (move: HomeFirstMove): void =>
    move.kind === "connectors" ? onConnect() : onOpen(move.id);
  const offer =
    sample?.canSeed === true && !sample.loaded ? (
      <SampleOffer seed={sample.onSeed} filling={sample.filling} />
    ) : null;
  return (
    <section className={styles.section} aria-label="Your apps">
      {outOfRoom || (conflicts?.length ?? 0) > 0 || sample?.loaded ? (
        <div className={styles.conditions}>
          {/* First, because it changes how everything under it should be read. */}
          {sample?.loaded ? (
            <SampleLoaded clear={sample.onClear} clearing={sample.clearing} />
          ) : null}
          {outOfRoom ? <OutOfRoom {...outOfRoom} /> : null}
          {conflicts?.map((conflict) => (
            <DevicesDisagree key={conflict.subject} {...conflict} />
          ))}
        </div>
      ) : null}
      {loading ? (
        // The springboard stays mounted and the app stays usable; only the
        // tiles that have nothing yet show placeholder rows.
        <WorkingState label="Reading your vault…" skeletonRows={3} />
      ) : dayOne ? (
        <>
          <DayOne moves={moves} onPick={pick} />
          {offer}
        </>
      ) : (
        <>
          <div
            className={styles.springboard}
            data-filled={justFilled ? "true" : undefined}
            data-testid="home-springboard"
          >
            {live.map((tile) => (
              <Tile key={tile.id} tile={tile} onOpen={onOpen} />
            ))}
          </div>
          {moves.length > 0 ? <StartBand moves={moves} onPick={pick} /> : null}
          {/* The offer belongs to BOTH treatments (issue #708). It used to hang
              off day one alone, which quietly made it unreachable: a vault has
              a People row for its own owner the moment it exists, so one live
              tile ends day one before the member has added anything — and
              clearing the sample then left them with no way back to it. The
              condition that matters is "there is something to seed and it is
              not seeded", not which layout Home happens to be drawing. */}
          {offer}
        </>
      )}
    </section>
  );
}
