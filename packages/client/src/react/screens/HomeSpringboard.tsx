import type { JSX } from "react";

import { identityHueKey } from "@centraid/design";
import type { ColorKey, IconName } from "@centraid/design";

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
import AppMark from "../ui/AppMark.js";
import Button from "../ui/Button.js";
import { Icon } from "../ui/index.js";
import { DevicesDisagree, OutOfRoom, WorkingState } from "../ui/states.js";
import type { DevicesDisagreeProps, OutOfRoomProps } from "../ui/states.js";

import styles from "./HomeSpringboard.module.css";

const MARK = 30;
const FIRST_RUN_MARK = 22;

function Mark({
  iconKey,
  colorKey,
  size,
  className,
}: {
  iconKey: IconName;
  colorKey: ColorKey;
  size: number;

  className: string | undefined;
}): JSX.Element {
  return (
    <AppMark
      className={className}
      colorKey={colorKey}
      iconKey={iconKey}
      size={size}
    />
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
          {/* Pinned to the tile bottom. */}
          {body.after ? (
            <span className={styles.afterLine}>{body.after}</span>
          ) : null}
        </div>
      );
    case "people":
      return (
        <div className={styles.body}>
          <div className={styles.faces}>
            {/* Hue derives from the PARTY ID through `--c-<hue>`, never a name
                hash or inline hex: a rename must not repaint a person, mobile
                must agree, and only `--c-*` keeps AA in dark. */}
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
          {/* THE GLANCE (#834): body ink — never a badge, dot, or red. */}
          {body.glance.today ? (
            <span className={styles.eventTime}>{body.glance.today}</span>
          ) : null}
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
          {/* Pinned under the rows, as the agenda after-line is. */}
          {body.glance.next ? (
            <span className={styles.afterLine}>{body.glance.next}</span>
          ) : null}
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

function FirstMove({
  move,
  onPick,
  compact,
}: {
  move: HomeFirstMove;
  onPick: (move: HomeFirstMove) => void;
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

function SampleOffer({
  seed,
  filling,
  autoSeedPending = false,
}: {
  seed: () => void;
  filling: HomeSampleProgress | null;
  autoSeedPending?: boolean;
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
      ) : autoSeedPending ? (
        <WorkingState
          className={styles.offerProgress}
          label={HOME_SAMPLE_FILLING}
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

function fillLabel(progress: HomeSampleProgress): string {
  if (progress.appId === undefined) return HOME_SAMPLE_FILLING_CATCH_UP;
  return HOME_SAMPLE_FILLING_APP[progress.appId] ?? HOME_SAMPLE_FILLING;
}

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

const BAND_MOVES = 3;

export interface HomeSpringboardProps {
  tiles: readonly HomeTileModel[];
  loading: boolean;
  onOpen: (id: string) => void;
  onConnect: () => void;
  outOfRoom?: OutOfRoomProps;
  conflicts?: readonly DevicesDisagreeProps[];
  sample?: {
    canSeed: boolean;
    loaded: boolean;
    autoSeedPending?: boolean;
    filling: HomeSampleProgress | null;
    clearing: boolean;
    onSeed: () => void;
    onClear: () => void;
  };
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
  const { live, idle } = partitionHomeTiles(tiles);
  const dayOne = live.length === 0;
  const moves = homeFirstMoves(idle, dayOne ? undefined : BAND_MOVES);
  const pick = (move: HomeFirstMove): void =>
    move.kind === "connectors" ? onConnect() : onOpen(move.id);
  const offer =
    sample?.canSeed === true && !sample.loaded ? (
      <SampleOffer
        autoSeedPending={sample.autoSeedPending}
        seed={sample.onSeed}
        filling={sample.filling}
      />
    ) : null;
  return (
    <section className={styles.section} aria-label="Your apps">
      {outOfRoom || (conflicts?.length ?? 0) > 0 || sample?.loaded ? (
        <div className={styles.conditions}>
          {/* First: it changes how the rest reads. */}
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
          {/* Both treatments (#708): the owner's own People row ends day one
              immediately, so the condition is "seedable and not seeded", not
              which layout Home draws. */}
          {offer}
        </>
      )}
    </section>
  );
}
