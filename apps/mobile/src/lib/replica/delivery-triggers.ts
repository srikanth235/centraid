/*
 * WHEN THIS PHONE ASKS (#1014, R15/R22/C3/C4).
 *
 * A gateway write reached neither of two foregrounded phones: the wake feed's
 * request had been cancelled at the platform and never re-issued, and there was
 * nothing else — no clock, no watchdog — so the only working trigger left in
 * the product was a background→foreground transition. The feed is an
 * optimisation and it is allowed to die; delivery is not.
 *
 * Held apart from `native-session.ts` because this is the session's SCHEDULE
 * rather than its rails: which triggers exist, and what each of them is for.
 * The rails — the outbox drain, the catch-up, the write path — are the other
 * file's, and are reached from here only as the callbacks below.
 */

import { seatChangeInvalidations } from "@centraid/client/replica/native";
import type {
  ReplicaCursor,
  ReplicaInvalidation,
  SeatWatermark,
  SeatWorkerSink,
} from "@centraid/client/replica/native";

import type { AppStateLike, NativeChangeFeed } from "./native-session-types";
import { REPLICA_PULL_INTERVAL_MS } from "./offline-budgets";

export interface SeatDeliveryOptions {
  readonly feed: NativeChangeFeed;
  readonly appState: AppStateLike | undefined;
  /** A frame arrived: a wake, or a verdict the session has to act on. */
  readonly onMessage: (message: { type: string; detail?: unknown }) => void;
  /** The app came forward: the session's own rails restart from here. */
  readonly onForeground: () => void;
  /** One tick of the clock below. The session decides whether to spend it. */
  readonly pull: () => void;
  readonly pullIntervalMs?: number;
}

/**
 * Every delivery trigger this session has, and their lifecycle.
 *
 *  - THE WAKE FEED, active while the app is foregrounded.
 *  - THE CLOCK. While foregrounded, a catch-up every
 *    `REPLICA_PULL_INTERVAL_MS`, whatever the feed is doing. Over a level seat
 *    one tick is a single conditional log-page request answering zero rows;
 *    over a phone whose feed the platform cancelled it is the difference
 *    between a minute stale and the 43 the live trace sat at.
 *  - THE FOREGROUND TRANSITION, which used to be the only one that worked.
 */
export class SeatDelivery {
  #unsubscribe: (() => void) | undefined;
  #appStateSub: { remove: () => void } | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: SeatDeliveryOptions) {}

  start(): void {
    this.#unsubscribe = this.options.feed.subscribe(this.options.onMessage);
    if (this.foregrounded()) this.wake();
    else this.options.feed.setActive(false);
    this.#appStateSub = this.options.appState?.addEventListener(
      "change",
      this.onAppStateChange
    );
  }

  /**
   * The tunnel moved (`updateGatewayBase`): the open stream is pointed at a
   * dead loopback port, so it is dropped and re-opened on the new base.
   */
  rebase(): void {
    this.options.feed.setActive(false);
    if (this.foregrounded()) this.options.feed.setActive(true);
  }

  /**
   * THE ONE THING THAT UNMUTES THE WAKE FEED (#1014, C4).
   *
   * A feed told to rebootstrap latches that scope off — it must not go on
   * delivering frames for an epoch the phone is replacing — and `resume()` was
   * the only reset, with no production caller anywhere. So one rebootstrap
   * frame muted that vault's feed for the life of the process.
   *
   * Called when the re-bootstrap has FINISHED, whatever it reached: a catch-up
   * that did not land still has to unmute the feed, or the failure is permanent
   * rather than the next attempt's problem. With no watermark the position is
   * the initial cursor, which costs a replay of wake FRAMES and nothing else —
   * a frame is a wake, and the catch-up behind it is idempotent.
   */
  resumeFrom(watermark: SeatWatermark | undefined): void {
    const cursor: ReplicaCursor = watermark
      ? { epoch: watermark.epoch, seq: watermark.applied }
      : { epoch: "0", seq: 0 };
    void Promise.resolve(this.options.feed.resume(cursor)).catch(
      () => undefined
    );
  }

  stop(): void {
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.options.feed.setActive(false);
    this.sleep();
  }

  private foregrounded(): boolean {
    return this.options.appState
      ? this.options.appState.currentState !== "background"
      : true;
  }

  private wake(): void {
    this.options.feed.setActive(true);
    if (this.#timer) return;
    this.#timer = setInterval(
      () => this.options.pull(),
      this.options.pullIntervalMs ?? REPLICA_PULL_INTERVAL_MS
    );
  }

  private sleep(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  private readonly onAppStateChange = (state: string): void => {
    if (state === "active") {
      this.wake();
      this.options.onForeground();
    } else if (state === "background") {
      this.options.feed.setActive(false);
      this.sleep();
    }
  };
}

/**
 * ROWS LANDING ARE THE CANONICAL INVALIDATION, ON THIS HOST TOO (#1014, C3).
 *
 * The browser has wired the applier's sink since #996 W5
 * (`packages/client/src/replica/shell-session.ts`); the phone built its seat
 * core with none, so a page of another device's rows landed in the file and no
 * screen re-read. The notice names the TABLES the batch wrote, which is
 * narrower and truer than anything a frame could have said — and `applied` is
 * the position the FILE reached, never the one a frame predicted, because a
 * stamp bumped from the frame says "current" over rows not yet applied.
 */
export function seatDeliverySink(options: {
  emit: (invalidations: ReplicaInvalidation[]) => void;
  applied?: (at: number) => void;
  /**
   * R24's other half (#1014, C10/C11): the applier cleared these overlays
   * inside the commit's transaction and told us AFTER it committed. The
   * browser has consumed this since #996; the phone did not, so an executed
   * write's pending badge sat over the very rows that settled it until
   * something else happened to move the queue.
   */
  overlaysCleared?: (intentIds: readonly string[]) => void;
}): SeatWorkerSink {
  return {
    onChange: (notice) => {
      options.emit(seatChangeInvalidations(notice));
      options.applied?.(notice.cursor);
    },
    ...(options.overlaysCleared
      ? { onOverlaysCleared: options.overlaysCleared }
      : {}),
  };
}
