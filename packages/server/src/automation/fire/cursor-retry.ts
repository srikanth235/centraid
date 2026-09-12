/**
 * THE RETRY BOOKKEEPING FOR ONE PENDING BATCH (#1014, B1).
 *
 * A trigger element used to be acknowledged the moment its fire returned, and
 * a handler failure returned. This is the state that replaces that: attempts
 * per element, a retry instant per element, and the cursor's bounded tail of
 * elements given up on. All of it is carried in the write-ahead batch and the
 * cursor row, so a restart mid-retry resumes the same count rather than
 * starting a fresh five attempts.
 *
 * ONE FAILURE DOES NOT STOP THE BATCH. A failed element is left
 * unacknowledged with its attempt counted and a retry time set, and delivery
 * CONTINUES to the rest of the batch: the committed position still cannot pass
 * it (a pending batch settles only when every element is acknowledged), so
 * nothing is skipped — but a poisoned Gmail message no longer holds the
 * nineteen after it hostage for the whole backoff.
 */

import {
  appendDeadLetter,
  readDeadLetters,
  triggerRetryDelayMs,
} from "./cursor-engine-support.js";
import type {
  CursorElement,
  PendingFireBatch,
  TriggerDeadLetterEntry,
} from "./cursor-engine-support.js";

export class CursorRetryState {
  private readonly attempts: Record<string, number>;
  private readonly retryAfter: Record<string, number>;
  private deadLetters: TriggerDeadLetterEntry[];
  private deadLettersDirty = false;

  constructor(
    prior: PendingFireBatch | undefined,
    deadLetterJson: string | undefined
  ) {
    this.attempts = { ...prior?.attempts };
    this.retryAfter = { ...prior?.retryAfter };
    this.deadLetters = readDeadLetters(deadLetterJson);
  }

  /** The batch fields this state contributes, omitted when empty. */
  snapshot(): Pick<PendingFireBatch, "attempts" | "retryAfter"> {
    return {
      ...(Object.keys(this.attempts).length > 0
        ? { attempts: this.attempts }
        : {}),
      ...(Object.keys(this.retryAfter).length > 0
        ? { retryAfter: this.retryAfter }
        : {}),
    };
  }

  /** The column value to write, or undefined to leave the stored tail alone. */
  deadLetterJson(): string | undefined {
    return this.deadLettersDirty ? JSON.stringify(this.deadLetters) : undefined;
  }

  /** Is this element's backoff still running at `now`? */
  deferred(position: string, now: number): boolean {
    const waitUntil = this.retryAfter[position];
    return waitUntil !== undefined && now < waitUntil;
  }

  attemptNumber(position: string): number {
    return (this.attempts[position] ?? 0) + 1;
  }

  clear(position: string): void {
    delete this.attempts[position];
    delete this.retryAfter[position];
  }

  /** Count one failure and set when the element may be tried again. */
  fail(position: string, attempt: number, now: number): void {
    this.attempts[position] = attempt;
    this.retryAfter[position] = now + triggerRetryDelayMs(attempt);
  }

  /** Give up on the element, durably, and hand back the record of it. */
  giveUp(
    element: CursorElement,
    attempts: number,
    error: string,
    now: number
  ): TriggerDeadLetterEntry {
    const entry: TriggerDeadLetterEntry = {
      position: element.position,
      occurredAt: element.occurredAt,
      attempts,
      error,
      deadLetteredAt: now,
    };
    this.deadLetters = appendDeadLetter(this.deadLetters, entry);
    this.deadLettersDirty = true;
    this.clear(element.position);
    return entry;
  }
}
