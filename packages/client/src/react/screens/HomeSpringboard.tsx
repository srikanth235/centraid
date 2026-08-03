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

import { iconChipRadius } from "@centraid/design";
import type { IconName } from "@centraid/design";

import {
  HOME_FIRST_RUN_BODY,
  HOME_FIRST_RUN_PLACEHOLDERS,
  HOME_FIRST_RUN_TITLE,
  HOME_SEARCH_EVERYTHING,
} from "../../home-copy.js";
import type { HomeTileBody, HomeTileModel } from "../shell/routes/homeTiles.js";
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
  className: string;
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
            {body.faces.map((face) => (
              <span className={styles.face} key={face.name} title={face.name}>
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
          <p className={styles.reading}>{body.line}</p>
          <span className={styles.readingStamp}>{body.at}</span>
        </div>
      );
    default:
      // The DESIGNED empty body: dashed, with what-to-do copy. Not a skeleton
      // (that would say "still loading") and not a blank (that would say
      // nothing at all).
      return (
        <div className={styles.body}>
          <span className={styles.emptyBody}>{body.hint}</span>
        </div>
      );
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
 * First run — the vault has no content ANYWHERE. Eight empty tiles would be
 * eight apologies; one instruction with dashed placeholders is a door.
 *
 * The copy is the brief's, verbatim, out of the shared constants — mobile draws
 * the same two sentences from the same module, because one state may not have
 * two spellings.
 *
 * FOUR placeholders, not one per installed app: they are a picture of what Home
 * becomes, not an inventory of what you own.
 */
function FirstRun({
  tiles,
  onOpen,
}: {
  tiles: readonly HomeTileModel[];
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <section className={styles.firstRun} data-testid="home-first-run">
      <h2 className={styles.firstRunTitle}>{HOME_FIRST_RUN_TITLE}</h2>
      <p className={styles.firstRunBody}>{HOME_FIRST_RUN_BODY}</p>
      <ul className={styles.firstRunSteps}>
        {tiles.slice(0, HOME_FIRST_RUN_PLACEHOLDERS).map((tile) => (
          <li key={tile.id}>
            <button
              type="button"
              className={styles.firstRunStep}
              data-app-id={tile.id}
              onClick={() => onOpen(tile.id)}
            >
              <Mark
                className={styles.firstRunMark}
                colorKey={tile.colorKey}
                iconKey={tile.iconKey}
                size={FIRST_RUN_MARK}
              />
              <span>
                {(tile.body.kind === "empty" && tile.body.hint) || tile.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Home's own cross-app search entry point — the third of the brief's three
 * (⌘K anywhere, the stem's Search control, "Search everything" on Home).
 *
 * It opens the SAME palette the other two do rather than owning any search of
 * its own: three doors, one room. A bounded control because an action may not
 * be bare text, and it sits above the grid because "find the thing" outranks
 * "browse the apps" on the screen you land on.
 */
function SearchEverything({ onSearch }: { onSearch: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={styles.searchEverything}
      data-testid="home-search-everything"
      onClick={onSearch}
    >
      <span className={styles.searchIcon} aria-hidden="true">
        <Icon name="Search" size={15} />
      </span>
      <span>{HOME_SEARCH_EVERYTHING}</span>
      <span className={styles.searchKbd} aria-hidden="true">
        ⌘K
      </span>
    </button>
  );
}

export interface HomeSpringboardProps {
  tiles: readonly HomeTileModel[];
  /** True only once the reads have SETTLED and found nothing anywhere. */
  firstRun: boolean;
  /** The reads are still in flight: static skeletons, never a spinner. */
  loading: boolean;
  onOpen: (id: string) => void;
  /** Opens the ⌘K palette. Home's "Search everything" is a third door onto it,
   *  never a second search. */
  onSearch: () => void;
  /** Vault-level conditions, wired to their real signals by the route. */
  outOfRoom?: OutOfRoomProps;
  conflicts?: readonly DevicesDisagreeProps[];
}

export default function HomeSpringboard({
  tiles,
  firstRun,
  loading,
  onOpen,
  onSearch,
  outOfRoom,
  conflicts,
}: HomeSpringboardProps): JSX.Element {
  return (
    <section className={styles.section} aria-label="Your apps">
      {outOfRoom || (conflicts?.length ?? 0) > 0 ? (
        <div className={styles.conditions}>
          {outOfRoom ? <OutOfRoom {...outOfRoom} /> : null}
          {conflicts?.map((conflict) => (
            <DevicesDisagree key={conflict.subject} {...conflict} />
          ))}
        </div>
      ) : null}
      {/* Above every treatment, including first run and loading: search is the
          one thing that works before the grid has anything to say. */}
      <SearchEverything onSearch={onSearch} />
      {loading ? (
        // The springboard stays mounted and the app stays usable; only the
        // tiles that have nothing yet show placeholder rows.
        <WorkingState label="Reading your vault…" skeletonRows={3} />
      ) : firstRun ? (
        <FirstRun tiles={tiles} onOpen={onOpen} />
      ) : (
        <div className={styles.springboard} data-testid="home-springboard">
          {tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}
