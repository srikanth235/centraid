/** An epoch-qualified position in one vault's durable change log. */
export interface ReplicaCursor {
  epoch: string;
  seq: number;
}

export type ReplicaCursorInput = ReplicaCursor | string;

export class InvalidReplicaCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReplicaCursorError';
  }
}

function validSeq(seq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 0;
}

/** Stable URL-safe wire form used by checkpoints and `?since=`. */
export function formatReplicaCursor(cursor: ReplicaCursor): string {
  if (!cursor.epoch || cursor.epoch.includes(':')) {
    throw new InvalidReplicaCursorError(
      'replica cursor epoch must be non-empty and contain no colon',
    );
  }
  if (!validSeq(cursor.seq)) {
    throw new InvalidReplicaCursorError('replica cursor seq must be a non-negative safe integer');
  }
  return `${cursor.epoch}:${cursor.seq}`;
}

/** Parse and validate either the wire form or an already-structured cursor. */
export function parseReplicaCursor(input: ReplicaCursorInput): ReplicaCursor {
  if (typeof input !== 'string') {
    // Return a copy so callers cannot mutate an object retained by an API.
    formatReplicaCursor(input);
    return { epoch: input.epoch, seq: input.seq };
  }
  const split = input.lastIndexOf(':');
  if (split <= 0 || split === input.length - 1) {
    throw new InvalidReplicaCursorError('replica cursor must have the form <epoch>:<seq>');
  }
  const epoch = input.slice(0, split);
  const rawSeq = input.slice(split + 1);
  if (!/^\d+$/.test(rawSeq)) {
    throw new InvalidReplicaCursorError('replica cursor seq must contain decimal digits only');
  }
  const seq = Number(rawSeq);
  if (!validSeq(seq)) {
    throw new InvalidReplicaCursorError('replica cursor seq must be a non-negative safe integer');
  }
  const cursor = { epoch, seq };
  formatReplicaCursor(cursor);
  return cursor;
}
