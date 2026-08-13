// Wire-rail command-tail replay (issue #750 invariant 7): a member reached
// only over the peer plane receives the EXECUTABLE operation tail
// (`exportCommonsIncrement`) and re-runs it (`applyCommonsIncrement`) inside
// one transaction with its cursor advance. A tail this replica cannot replay
// is unusable — never a park, never fatal — and the full frame converges.
//
// The state-proof bound lives here too: replay-produced rows are exactly as
// unproven as the rows the old closure delta produced, so a seat may stand at
// most one checkpoint interval of them on top of the state it last proved.

import { afterEach, describe, expect, test } from "vitest";

import { nowIso } from "../ids.js";
import {
  placeCommonsBootstrapBlobs,
  placeCommonsIncrementBlobs,
} from "./commons-blobs.test-fixtures.js";
import {
  applyCommonsBootstrap,
  applyCommonsIncrement,
  exportCommonsSyncFrame,
  isCommonsIncrementUnusable,
} from "./commons-bootstrap.js";
import { readCommonsVerified } from "./commons-chain.js";
import { readCommonsCursor } from "./commons-cursor.js";
import {
  folderCommons,
  MEMBER_VAULT,
  replicaExecutor,
  STEWARD_VAULT,
} from "./commons-replay.test-fixtures.js";
import type { FolderCommons } from "./commons-replay.test-fixtures.js";
import {
  appendCommonsOperation,
  COMMONS_CHECKPOINT_INTERVAL,
  readCommonsGrant,
} from "./commons.js";
import type { CommonsMemberInput } from "./commons.js";
import { closeOpenVaults } from "./placement-fixture.js";

interface WireFixture {
  fixture: FolderCommons;
  /** One steward write nobody local sees; the member is wire-only. */
  write: (title: string, options?: { compile?: boolean }) => void;
  /** One member pull with its own cursor, applied the way a peer applies it. */
  sync: () => "increment" | "bootstrap";
  rebaseline: () => void;
  /** The sequence at which this seat last proved its whole state. */
  provenSequence: () => number;
  title: () => string | undefined;
}

/** A commons whose member is reached only over the WIRE: the steward compiles
 * no local seat for it, so every catch-up is an exported frame the member
 * applies exactly like a peer. */
function wireCommons(documentCount: number): WireFixture {
  const fixture = folderCommons(documentCount);
  const detached: CommonsMemberInput[] = [];
  const frameFor = (
    afterSequence?: number
  ): ReturnType<typeof exportCommonsSyncFrame> =>
    exportCommonsSyncFrame({
      steward: fixture.home.origin.vault,
      identitySeed: fixture.home.origin.identitySeed,
      stewardVaultId: STEWARD_VAULT,
      grantId: fixture.grantId,
      memberVaultId: MEMBER_VAULT,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
  const rebaseline = (): void => {
    const frame = frameFor();
    if (frame.state !== "bootstrap")
      throw new Error(`expected a full frame, got ${frame.state}`);
    placeCommonsBootstrapBlobs({
      source: fixture.home.origin,
      seat: fixture.home.audience,
      wire: frame.wire,
    });
    applyCommonsBootstrap({
      seat: fixture.home.audience,
      wire: frame.wire,
      now: nowIso(),
    });
  };
  const sync = (): "increment" | "bootstrap" => {
    const cursor = readCommonsCursor(
      fixture.home.audience.vault,
      fixture.grantId,
      MEMBER_VAULT
    );
    const frame = frameFor(cursor?.sequence);
    if (frame.state !== "increment") {
      rebaseline();
      return "bootstrap";
    }
    placeCommonsIncrementBlobs({
      source: fixture.home.origin,
      seat: fixture.home.audience,
      increment: frame.increment,
    });
    applyCommonsIncrement({
      seat: fixture.home.audience,
      increment: frame.increment,
      now: nowIso(),
      applyCommand: replicaExecutor(fixture.member),
    });
    return "increment";
  };
  rebaseline();
  return {
    fixture,
    write: (title, options) => {
      fixture.write(
        "core.rename_document",
        { document_id: fixture.documents[0]!, title },
        { seats: detached }
      );
      if (options?.compile !== false) fixture.compile({ seats: detached });
    },
    sync,
    rebaseline,
    provenSequence: () =>
      readCommonsGrant(fixture.home.audience.vault, fixture.grantId)
        .checkpointSequence,
    title: () => fixture.documentTitle(fixture.documents[0]!),
  };
}

/** The head this seat has proved the STEWARD's history up to. */
function verifiedSequence(wire: WireFixture): number | undefined {
  return readCommonsVerified(
    wire.fixture.home.audience.vault,
    wire.fixture.grantId
  )?.sequence;
}

describe("Commons command-tail replay, wire rail (issue #750 invariant 7)", () => {
  afterEach(closeOpenVaults);

  test("an increment carries the executable tail and the member replays it", () => {
    const wire = wireCommons(3);
    wire.write("Wire renamed");
    expect(wire.sync()).toBe("increment");
    expect(wire.title()).toBe("Wire renamed");
    expect(
      readCommonsCursor(
        wire.fixture.home.audience.vault,
        wire.fixture.grantId,
        MEMBER_VAULT
      )?.sequence
    ).toBe(1);
  });

  test("re-applying an already-applied increment is a no-op", () => {
    const wire = wireCommons(2);
    wire.write("Applied once");
    const frame = exportCommonsSyncFrame({
      steward: wire.fixture.home.origin.vault,
      identitySeed: wire.fixture.home.origin.identitySeed,
      stewardVaultId: STEWARD_VAULT,
      grantId: wire.fixture.grantId,
      memberVaultId: MEMBER_VAULT,
      afterSequence: 0,
    });
    if (frame.state !== "increment")
      throw new Error(`expected an increment frame, got ${frame.state}`);
    const apply = (): void => {
      applyCommonsIncrement({
        seat: wire.fixture.home.audience,
        increment: frame.increment,
        now: nowIso(),
        applyCommand: replicaExecutor(wire.fixture.member),
      });
    };
    apply();
    const after = wire.fixture.home.audience.vault
      .prepare(
        `SELECT document_id, title, current_content_id FROM core_document
          ORDER BY document_id`
      )
      .all();
    // The seat's cursor is the idempotency boundary: a redelivered frame whose
    // head it already holds changes nothing and re-executes nothing.
    apply();
    expect(
      wire.fixture.home.audience.vault
        .prepare(
          `SELECT document_id, title, current_content_id FROM core_document
            ORDER BY document_id`
        )
        .all()
    ).toStrictEqual(after);
  });

  test("a tail the member cannot replay is unusable, not a park, and the full frame converges", () => {
    const wire = wireCommons(2);
    wire.write("Before the skew");
    appendCommonsOperation({
      steward: wire.fixture.home.origin.vault,
      grantId: wire.fixture.grantId,
      actorPartyId: wire.fixture.home.originBoot.ownerPartyId,
      kind: "command",
      command: "future.reticulate_splines",
      input: { folder_id: wire.fixture.folderId },
      outcome: "executed",
      now: nowIso(),
    });
    const frame = exportCommonsSyncFrame({
      steward: wire.fixture.home.origin.vault,
      identitySeed: wire.fixture.home.origin.identitySeed,
      stewardVaultId: STEWARD_VAULT,
      grantId: wire.fixture.grantId,
      memberVaultId: MEMBER_VAULT,
      afterSequence: 0,
    });
    if (frame.state !== "increment")
      throw new Error(`expected an increment frame, got ${frame.state}`);
    let refusal: unknown;
    try {
      applyCommonsIncrement({
        seat: wire.fixture.home.audience,
        increment: frame.increment,
        now: nowIso(),
        applyCommand: replicaExecutor(wire.fixture.member),
      });
    } catch (error) {
      refusal = error;
    }
    expect(isCommonsIncrementUnusable(refusal)).toBe(true);
    // Rolled back whole: nothing from the replayable prefix survived.
    expect(wire.title()).toBe("Booking 0");
    expect(
      readCommonsCursor(
        wire.fixture.home.audience.vault,
        wire.fixture.grantId,
        MEMBER_VAULT
      )?.sequence
    ).toBe(0);
    // What the caller does with that refusal: pull the full frame.
    wire.rebaseline();
    expect(wire.title()).toBe("Before the skew");
  });

  test("a replica with no executor cannot use an increment and re-baselines", () => {
    const wire = wireCommons(2);
    wire.write("No executor");
    const frame = exportCommonsSyncFrame({
      steward: wire.fixture.home.origin.vault,
      identitySeed: wire.fixture.home.origin.identitySeed,
      stewardVaultId: STEWARD_VAULT,
      grantId: wire.fixture.grantId,
      memberVaultId: MEMBER_VAULT,
      afterSequence: 0,
    });
    if (frame.state !== "increment")
      throw new Error(`expected an increment frame, got ${frame.state}`);
    expect(() =>
      applyCommonsIncrement({
        seat: wire.fixture.home.audience,
        increment: frame.increment,
        now: nowIso(),
      })
    ).toThrow("replica command executor");
    wire.rebaseline();
    expect(wire.title()).toBe("No executor");
  });
});

/**
 * State proof is bounded, not continuous (issue #750 invariant 7): the one
 * attested state digest covers the STEWARD's closure bytes, which a member —
 * whose projection re-owns and may re-id what it stores — cannot recompute
 * from its own rows. So a seat may stand at most one checkpoint interval of
 * increments on top of the state it last proved; past that it refuses and
 * re-baselines through the full frame, whose digest it CAN assert. Rows a
 * replayed command produced are exactly as unproven as the rows the old
 * closure delta produced, so the bound applies to them unchanged.
 */
describe("Commons increment state-proof bound (issue #750 invariant 7)", () => {
  afterEach(closeOpenVaults);

  test("increments inside the bound apply and record the head they verified", () => {
    const wire = wireCommons(2);
    expect(wire.provenSequence()).toBe(0);
    const head = COMMONS_CHECKPOINT_INTERVAL - 1;
    for (let sequence = 1; sequence <= head; sequence += 1)
      wire.write(`Revision ${sequence}`);

    expect(wire.sync()).toBe("increment");
    expect(verifiedSequence(wire)).toBe(head);
    expect(
      readCommonsCursor(
        wire.fixture.home.audience.vault,
        wire.fixture.grantId,
        MEMBER_VAULT
      )?.sequence
    ).toBe(head);
    expect(wire.title()).toBe(`Revision ${head}`);
    // Honest about what that proved: the history, not the state. The seat's
    // proof point is still where the last full frame left it.
    expect(wire.provenSequence()).toBe(0);
  });

  test("an increment past the bound is refused whole, and the re-baseline it triggers replaces a drifted replica", () => {
    const wire = wireCommons(2);
    const audience = wire.fixture.home.audience;
    const head = COMMONS_CHECKPOINT_INTERVAL;
    for (let sequence = 1; sequence <= head; sequence += 1)
      // The last write skips the compile, so the steward cuts no new
      // checkpoint: nothing but this seat's own bound stops it from riding a
      // full interval of unproven operations.
      wire.write(`Revision ${sequence}`, { compile: sequence !== head });
    // Drift the replica under a row no operation in the window names: replay
    // carries no command for it, so the tail itself would apply cleanly and
    // leave the seat holding rows the steward does not have.
    audience.vault
      .prepare(
        "UPDATE core_document SET title = 'drifted' WHERE document_id = ?"
      )
      .run(wire.fixture.documents[1]!);

    let refusal: unknown;
    try {
      wire.sync();
    } catch (error) {
      refusal = error;
    }
    // The re-baseline-triggering kind, not a park: the member must be able to
    // heal itself through the full frame.
    expect(isCommonsIncrementUnusable(refusal)).toBe(true);
    // Rolled back whole: cursor, verified head, proof point and domain rows
    // are exactly what they were before the increment was offered.
    expect(
      readCommonsCursor(audience.vault, wire.fixture.grantId, MEMBER_VAULT)
        ?.sequence
    ).toBe(0);
    expect(verifiedSequence(wire)).toBe(0);
    expect(wire.provenSequence()).toBe(0);
    expect(wire.title()).toBe("Booking 0");

    // The full frame re-projects from a snapshot whose digest is asserted
    // inside the apply, so the drift is gone and the seat's proof point moves
    // up to the head — the bound starts again from proven state.
    wire.rebaseline();
    expect(
      (
        audience.vault
          .prepare("SELECT title FROM core_document WHERE document_id = ?")
          .get(wire.fixture.documents[1]!) as { title: string }
      ).title
    ).toBe("Booking 1");
    expect(wire.title()).toBe(`Revision ${head}`);
    expect(verifiedSequence(wire)).toBe(head);
    expect(wire.provenSequence()).toBe(head);
  });
});
