/**
 * THE GOLDEN SEAT FILE (#927 P4, rewired by #996 wave 2).
 *
 * The vault half of the golden artifact is `year3-vault.ts`. This is the other
 * half: the SQLite file a phone holds after bootstrapping that vault, plus the
 * outbox of pending intents the converge journey needs (N ∈ 1, 10, 40).
 *
 * WHAT CHANGED, AND WHY IT HAD TO. Until #996 a replica was a SLICE: per-app
 * shapes walked with `readReplicaRows` and applied into a `replica_row`
 * projection, and this module built the snapshot that walk produced. Under
 * ruling R1 a seat holds `vault.db` WHOLE, so a fixture still shaped like a
 * slice would let a wave exit green on the wrong volume — the review sweep
 * filed it as F5. The artifact is now what a real seat has: the gateway's
 * SANITISED FILE, copied, with a tail of real log rows applied on top.
 *
 * THE RULE THAT DID NOT CHANGE: NEVER A HAND-BUILT REPLICA. Every byte arrives
 * through the real path — `buildSeatSnapshot` on the gateway side,
 * `bootstrapSeatFile` and `applySeatLogPage` on the seat side, and the seat's
 * own outbox for the intents. A fixture that wrote its own tables would agree
 * with itself and with nothing else, and would survive a change to the apply
 * path that breaks every phone.
 *
 * `@centraid/test-kit` deliberately does not depend on `@centraid/vault` or
 * `@centraid/client` (see `year3FixtureCacheKey`), so those seams are
 * INJECTED. `tests/helpers/factories.ts` wires the real ones; the kit's own
 * suite wires them too, which is what keeps the shapes below honest.
 */
import { createHash } from "node:crypto";

import { seededRandom } from "./random.js";

/** The converge journey's three volumes (#927, journey table). */
export const YEAR3_PENDING_INTENT_VOLUMES = [1, 10, 40] as const;
export type Year3PendingIntentVolume =
  (typeof YEAR3_PENDING_INTENT_VOLUMES)[number];

/** What a seat's file contains (#996, OQ-2). The golden artifact is `full`. */
export type Year3SeatContents = "full" | "rows-minus-fts";

/** The sanitised snapshot the gateway built, as the fixture sees it. */
export interface Year3SeatSnapshot {
  /** Where the artifact was written. */
  readonly path: string;
  /** The log position the copy stands at; the tail starts here. */
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly bytes: number;
}

/** One page of the gateway log, as the fixture hands it to the applier. */
export interface Year3SeatLogPage {
  readonly rows: readonly unknown[];
  readonly watermark: number;
}

/** The seat file, once installed. */
export interface Year3SeatFile {
  /** `applySeatLogPage`, bound to this file. Returns rows applied. */
  readonly apply: (page: Year3SeatLogPage) => number;
  /** The phone's own outbox — never a table this fixture invented. */
  readonly queue: (intent: Year3PendingIntent) => void;
  /** Tables in the file, excluding SQLite's own. */
  readonly tables: () => number;
  /** Where the seat's applied cursor stands. */
  readonly cursor: () => number;
  readonly close: () => void;
}

/**
 * The three seams the builder needs, all on the far side of a package
 * boundary this package will not cross.
 */
export interface Year3SeatSeams {
  /** `buildSeatSnapshot(vault, destination)`. */
  readonly snapshot: (destination: string) => Year3SeatSnapshot;
  /**
   * Commits made on the GATEWAY after the snapshot, read back as log rows.
   *
   * A snapshot alone proves the copy; only a tail applied on top proves the
   * log, and the converge journey is about the log.
   */
  readonly tail: (since: number) => Year3SeatLogPage;
  /** `bootstrapSeatFile` over the local artifact, then open it. */
  readonly install: (snapshot: Year3SeatSnapshot) => Promise<Year3SeatFile>;
}

export interface Year3SeatBuildOptions {
  readonly pendingIntents: number;
  /** Deterministic in the fixture seed, like every other part of the golden set. */
  readonly seed: number;
  readonly hashPayload: (intent: {
    appId: string;
    action: string;
    input: Record<string, unknown>;
  }) => Promise<string>;
}

/** What the built artifact knows about itself. */
export interface Year3SeatFacts {
  readonly snapshotBytes: number;
  readonly snapshotSeq: number;
  readonly tailRows: number;
  readonly cursor: number;
  readonly tables: number;
  readonly pendingIntents: number;
  readonly contents: Year3SeatContents;
}

/**
 * Build the golden seat file: snapshot copy, then log tail, then the outbox.
 *
 * IN THAT ORDER, AND THE ORDER IS THE POINT. A seat that only ever sees a
 * snapshot has never exercised the applier; a fixture assembled the other way
 * round would queue intents into a file that is about to be replaced.
 */
export async function buildYear3SeatReplica(
  seams: Year3SeatSeams,
  destination: string,
  options: Year3SeatBuildOptions
): Promise<Year3SeatFacts> {
  const snapshot = seams.snapshot(destination);
  const file = await seams.install(snapshot);
  try {
    const page = seams.tail(snapshot.seq);
    const tailRows = page.rows.length > 0 ? file.apply(page) : 0;
    const intents = await year3PendingIntents(
      options.pendingIntents,
      options.hashPayload,
      options.seed
    );
    for (const intent of intents) file.queue(intent);
    const facts: Year3SeatFacts = {
      snapshotBytes: snapshot.bytes,
      snapshotSeq: snapshot.seq,
      tailRows,
      cursor: file.cursor(),
      tables: file.tables(),
      pendingIntents: intents.length,
      contents: "full",
    };
    assertYear3SeatNotHandBuilt(facts);
    return facts;
  } finally {
    file.close();
  }
}

/**
 * The rule, as an assertion rather than a comment.
 *
 * A seat file carries the GATEWAY's schema, so it has scores of tables and a
 * cursor at or past the snapshot's position. A hand-built fixture — one
 * table, a cursor of zero — fails here, at build time, rather than by quietly
 * passing a parity test that was only ever comparing itself.
 */
export function assertYear3SeatNotHandBuilt(facts: Year3SeatFacts): void {
  if (facts.tables < 20) {
    throw new Error(
      `golden seat: ${facts.tables} tables — this is not a copy of the gateway's file`
    );
  }
  if (facts.cursor < facts.snapshotSeq) {
    throw new Error(
      `golden seat: cursor ${facts.cursor} is behind the snapshot at ${facts.snapshotSeq}`
    );
  }
}

export interface Year3PendingIntent {
  intentId: string;
  payloadHash: string;
  appId: string;
  action: string;
  input: Record<string, unknown>;
  state: "queued";
  attempts: 0;
  enqueuedAt: string;
  optimistic: never[];
}

/**
 * The outbox a phone holds when the network returns: N intents queued, never
 * sent, in the order they were made. Deterministic in the fixture seed, so the
 * same N always produces the same N rows.
 *
 * `hashPayload` is the phone's OWN canonical hash
 * (`packages/client/src/replica/payload-hash.ts`) — the daemon verifies an
 * intent id against it, so a fixture that invented its own digest would queue
 * intents no gateway would accept.
 */
export async function year3PendingIntents(
  count: number,
  hashPayload: (intent: {
    appId: string;
    action: string;
    input: Record<string, unknown>;
  }) => Promise<string>,
  seed: number
): Promise<Year3PendingIntent[]> {
  const random = seededRandom(seed);
  const intents: Year3PendingIntent[] = [];
  for (let index = 0; index < count; index += 1) {
    const input = {
      noteId: `year3-note-${String(random.int(0, 999)).padStart(6, "0")}`,
      title: `Edited offline ${index}`,
    };
    const payload = {
      appId: "notes",
      action: "notes.rename_note",
      input,
    };
    intents.push({
      intentId: `year3-intent-${String(index).padStart(4, "0")}`,
      // Sequential by construction: the hash is the payload's, and the loop
      // draws its next payload from the same seeded stream.
      // oxlint-disable-next-line no-await-in-loop
      payloadHash: await hashPayload(payload),
      appId: payload.appId,
      action: payload.action,
      input,
      state: "queued",
      attempts: 0,
      // Inside the fixture's own 2023–2025 window, one minute apart.
      enqueuedAt: new Date(
        Date.parse("2025-12-31T00:00:00.000Z") + index * 60_000
      ).toISOString(),
      optimistic: [],
    });
  }
  return intents;
}

/**
 * Content address of one golden seat file.
 *
 * Distinct from the vault's key by the pending-intent count and by what the
 * file CONTAINS: two seats built from the same vault with different outboxes
 * are different artifacts, and so are a full seat and one whose search index
 * was dropped for a browser quota (OQ-2). The entity list that used to be part
 * of this key is gone with the slice — a seat holds the whole file.
 */
export function year3ReplicaCacheKey(
  vaultKey: string,
  pendingIntents: number,
  contents: Year3SeatContents = "full"
): string {
  return createHash("sha256")
    .update(JSON.stringify({ vaultKey, pendingIntents, contents }))
    .digest("hex");
}
