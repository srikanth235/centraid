// THE SNAPSHOT DOOR, AS A SEAT SPEAKS TO IT (#996, R4).
//
// The door is a static file on purpose — ranges, a strong ETag and conditional
// requests come from the transport rather than from an RPC we would have had
// to design — so this is the small amount of code that takes it up on that.
//
// TWO THINGS IT REFUSES TO GUESS:
//
//   - A RESUME THAT IS NOT THE SAME FILE. `If-Range` with the ETag makes the
//     server answer 206 for the artifact the seat already has bytes of, and
//     200 (the whole file) when it has moved on. A 200 answering a ranged
//     request is not an error to retry — it is the server saying "different
//     file", and splicing it onto the staged prefix is how a seat ends up with
//     a database that gunzips and then fails an integrity check hours later.
//   - A SNAPSHOT WITHOUT ITS NUMBERS. Where the file sits in the log is not
//     recoverable from the bytes, so a response missing the seq header is
//     refused rather than defaulted to zero — which would make the seat replay
//     the entire retained log over a file that already contains it.

import {
  SEAT_SNAPSHOT_EPOCH_HEADER,
  SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER,
  SEAT_SNAPSHOT_SEQ_HEADER,
} from "@centraid/core/protocol";
import type { SeatSnapshotHead } from "@centraid/core/protocol";

import type { SeatSnapshotTransport } from "./bootstrap.js";
import { SeatSnapshotMovedError } from "./seat-snapshot-moved-error.js";

export class SeatSnapshotUnavailableError extends Error {
  readonly code = "seat_snapshot_unavailable";
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "SeatSnapshotUnavailableError";
  }
}

export interface HttpSeatSnapshotOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) {
    throw new SeatSnapshotUnavailableError(
      response.status,
      `seat snapshot: response carries no ${name}`
    );
  }
  return value;
}

function headOf(response: Response, bytes: number): SeatSnapshotHead {
  const etag = requiredHeader(response, "etag");
  const seq = Number(requiredHeader(response, SEAT_SNAPSHOT_SEQ_HEADER));
  const schemaEpoch = Number(
    requiredHeader(response, SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER)
  );
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(schemaEpoch)) {
    throw new SeatSnapshotUnavailableError(
      response.status,
      "seat snapshot: seq or schema epoch is not an integer"
    );
  }
  return {
    etag,
    bytes,
    seq,
    epoch: requiredHeader(response, SEAT_SNAPSHOT_EPOCH_HEADER),
    schemaEpoch,
  };
}

export function httpSeatSnapshotTransport(
  options: HttpSeatSnapshotOptions
): SeatSnapshotTransport {
  const call = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers = { ...options.headers };
  return {
    head: async (): Promise<SeatSnapshotHead> => {
      // A HEAD, not a ranged GET of one byte: the door builds the artifact on
      // demand and the seat wants that build to have happened before it starts
      // measuring free space against the size.
      const response = await call(options.url, { method: "HEAD", headers });
      if (!response.ok) {
        throw new SeatSnapshotUnavailableError(
          response.status,
          `seat snapshot: door answered ${response.status}`
        );
      }
      const length = response.headers.get("content-length");
      if (length === null) {
        throw new SeatSnapshotUnavailableError(
          response.status,
          "seat snapshot: response carries no content-length"
        );
      }
      return headOf(response, Number(length));
    },
    range: (start: number, etag: string): AsyncIterable<Uint8Array> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        const response = await call(options.url, {
          headers: {
            ...headers,
            ...(start > 0
              ? { Range: `bytes=${start}-`, "If-Range": etag }
              : { "If-None-Match": "" }),
          },
        });
        if (!response.ok) {
          throw new SeatSnapshotUnavailableError(
            response.status,
            `seat snapshot: door answered ${response.status}`
          );
        }
        // The two ways the artifact can have moved: a different ETag, or a 200
        // where a 206 was asked for. The second is `If-Range` doing its job.
        const served = response.headers.get("etag");
        if (served !== etag)
          throw new SeatSnapshotMovedError(etag, served ?? undefined);
        if (start > 0 && response.status !== 206) {
          throw new SeatSnapshotMovedError(etag, served ?? undefined);
        }
        const body = response.body;
        if (!body) {
          const buffer = await response.arrayBuffer();
          yield new Uint8Array(buffer);
          return;
        }
        const reader = body.getReader();
        for (;;) {
          // Sequential BY DEFINITION: this is a byte stream, and the next
          // chunk does not exist until the previous one has been read.
          // oxlint-disable-next-line no-await-in-loop
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      },
    }),
  };
}
