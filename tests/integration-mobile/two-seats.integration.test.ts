/*
 * TWO PHONES ON ONE VAULT, AND WHAT AN OUTAGE DOES BETWEEN THEM (#996).
 *
 * The suites beside this one open ONE seat. Every question a household asks —
 * "my wife edited it on her phone while mine was in a tunnel" — needs two, and
 * the harness already supports it: `openSeat` takes a label precisely so two
 * replicas can sit on one gateway.
 *
 * Three claims, none of them posed. Each arranges an outage the product's own
 * `cut()` produces, writes through the shipped session, and then reads what
 * the gateway and BOTH copies actually hold:
 *
 *   1. DISJOINT ROWS — two phones offline together, each editing a row the
 *      other never touched, both converge and neither write is lost;
 *   2. THE SAME ROW — the loser of a two-phone race is TOLD. A silent
 *        overwrite is the failure this exists to catch;
 *   3. DELETE VERSUS EDIT — one phone renames a row the other deleted; the
 *      survivor's copy and the gateway agree on one answer, and the phone
 *      whose write did not survive can see why.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bumpReplicaEpoch } from "../../packages/vault/src/replica/change-log.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { entityIdColumn, readEntity } from "./lib/reads.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

interface PendingEntry {
  intentId: string;
  status?: string;
  reason?: string;
  expectedVersion?: number;
  actualVersion?: number;
}

const DOC_BYTES = "data:text/plain;base64,c2VlZGVk";

async function uploadDoc(
  gateway: MobileGateway,
  title: string
): Promise<string> {
  const outcome = await gateway.callAction("docs", "upload", {
    data_uri: DOC_BYTES,
    title,
  });
  if (outcome.body.status !== "executed")
    throw new Error(`docs.upload: ${JSON.stringify(outcome.body)}`);
  const output = outcome.body.output as { document_id?: string } | undefined;
  const documentId = output?.document_id;
  if (!documentId) throw new Error("docs.upload returned no document_id");
  return documentId;
}

/**
 * This phone's CANONICAL copy — the same page `readEntity` takes, minus the
 * pending overlay. Needed here because the overlay keeps drawing a REFUSED
 * write's optimistic value (`conflict` is in `OVERLAY_STATES` by design), so
 * an overlaid read cannot answer "do the two phones agree about the row?".
 */
async function readCanonical(
  seat: MobileSeat,
  entity: string
): Promise<Array<Record<string, unknown>>> {
  const idColumn = entityIdColumn(entity);
  const page = await seat.seat.page<Record<string, unknown>>(
    {
      name: `two-seats.canonical.${entity}`,
      select: "*",
      from: `"core_document"`,
      order: { sortColumn: idColumn, pkColumn: idColumn, descending: false },
    },
    { limit: 500 }
  );
  return page.rows;
}

function titleOf(
  rows: Array<Record<string, unknown>>,
  documentId: string
): unknown {
  return rows.find((row) => row["document_id"] === documentId)?.["title"];
}

async function pendingFor(
  seat: MobileSeat,
  intentId: string
): Promise<PendingEntry | undefined> {
  const pending = (await seat.session.pendingChanges()) as PendingEntry[];
  return pending.find((entry) => entry.intentId === intentId);
}

/** Ship both queues and let the gateway's answers land on both copies. */
async function settleBoth(a: MobileSeat, b: MobileSeat): Promise<void> {
  await a.session.flushIntents();
  await b.session.flushIntents();
  await a.session.pullNow();
  await b.session.pullNow();
}

describe("two phones on one vault", () => {
  let gateway: MobileGateway;
  let phoneA: MobileSeat;
  let phoneB: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("two-seats");
    phoneA = await openSeat(gateway, { label: "a" });
    phoneB = await openSeat(gateway, { label: "b" });
  });

  afterAll(async () => {
    await phoneA?.close();
    await phoneB?.close();
    await gateway?.close();
  });

  test("disjoint rows: both offline edits survive and both copies converge", async () => {
    const docA = await uploadDoc(gateway, "A's document");
    const docB = await uploadDoc(gateway, "B's document");
    await phoneA.session.pullNow();
    await phoneB.session.pullNow();

    // Both phones lose the network at once, and each edits a row the other
    // never touches.
    phoneA.cut();
    phoneB.cut();
    const writeA = (await phoneA.session.write("docs", {
      action: "rename",
      input: { document_id: docA, title: "Renamed on A while offline" },
    })) as { intentId: string };
    const writeB = (await phoneB.session.write("docs", {
      action: "rename",
      input: { document_id: docB, title: "Renamed on B while offline" },
    })) as { intentId: string };
    phoneA.restore();
    phoneB.restore();

    await settleBoth(phoneA, phoneB);

    const onA = (await readEntity(phoneA, "core.document")).rows;
    const onB = (await readEntity(phoneB, "core.document")).rows;

    // Neither write is lost, and each phone sees the OTHER phone's edit.
    expect(titleOf(onA, docA)).toBe("Renamed on A while offline");
    expect(titleOf(onA, docB)).toBe("Renamed on B while offline");
    expect(titleOf(onB, docA)).toBe("Renamed on A while offline");
    expect(titleOf(onB, docB)).toBe("Renamed on B while offline");

    // And both queues really settled, rather than converging by never shipping.
    expect((await pendingFor(phoneA, writeA.intentId))?.status).not.toBe(
      "queued"
    );
    expect((await pendingFor(phoneB, writeB.intentId))?.status).not.toBe(
      "queued"
    );
  });

  test("the same row: the phone whose edit did not survive is told", async () => {
    const contested = await uploadDoc(gateway, "Contested document");
    await phoneA.session.pullNow();
    await phoneB.session.pullNow();

    phoneA.cut();
    phoneB.cut();
    const writeA = (await phoneA.session.write("docs", {
      action: "rename",
      input: { document_id: contested, title: "A says this" },
    })) as { intentId: string };
    const writeB = (await phoneB.session.write("docs", {
      action: "rename",
      input: { document_id: contested, title: "B says this" },
    })) as { intentId: string };
    phoneA.restore();
    phoneB.restore();

    await settleBoth(phoneA, phoneB);

    const canonicalA = await readCanonical(phoneA, "core.document");
    const canonicalB = await readCanonical(phoneB, "core.document");
    const settled = titleOf(canonicalA, contested);

    // ONE ANSWER. Read without the overlay, the two copies must not disagree.
    expect(
      titleOf(canonicalB, contested),
      "the two phones' canonical copies disagree about the contested row"
    ).toBe(settled);
    expect(
      settled === "A says this" || settled === "B says this",
      `one of the two writes must win, got ${String(settled)}`
    ).toBe(true);

    // THE CLAIM. The phone whose edit did not survive is told, with the two
    // versions that separate a conflict from a bare refusal.
    const loser =
      settled === "A says this"
        ? { seat: phoneB, intentId: writeB.intentId, label: "B" }
        : { seat: phoneA, intentId: writeA.intentId, label: "A" };
    const verdict = await pendingFor(loser.seat, loser.intentId);
    expect(
      verdict?.status,
      `phone ${loser.label} lost and its outbox says ${JSON.stringify(verdict)}`
    ).toBe("conflict");
    expect(verdict?.expectedVersion).toBeTypeOf("number");
    expect(verdict?.actualVersion).toBeGreaterThan(verdict!.expectedVersion!);

    // THE OTHER HALF, and the reason this suite reads canonically above: the
    // loser's REFUSED text is still drawn over the row by `OVERLAY_STATES`, so
    // what the member sees on each phone still differs. Deliberate (#922 G5) —
    // recorded here so a change to it is a change to a tested fact.
    const overlaidOnLoser = titleOf(
      (await readEntity(loser.seat, "core.document")).rows,
      contested
    );
    expect(overlaidOnLoser).not.toBe(settled);
  });

  test("delete versus edit: one answer, and the losing phone can see why", async () => {
    const doomed = await uploadDoc(gateway, "Doomed document");
    await phoneA.session.pullNow();
    await phoneB.session.pullNow();

    phoneA.cut();
    phoneB.cut();
    const deleteOnA = (await phoneA.session.write("docs", {
      action: "trash",
      input: { document_id: doomed },
    })) as { intentId: string };
    const renameOnB = (await phoneB.session.write("docs", {
      action: "rename",
      input: { document_id: doomed, title: "B renamed the doomed document" },
    })) as { intentId: string };
    phoneA.restore();
    phoneB.restore();

    await settleBoth(phoneA, phoneB);

    const onA = (await readEntity(phoneA, "core.document")).rows;
    const onB = (await readEntity(phoneB, "core.document")).rows;
    const aliveOnA = onA.some((row) => row["document_id"] === doomed);
    const aliveOnB = onB.some((row) => row["document_id"] === doomed);

    // Whatever the ruling is, the two copies must not disagree about it.
    expect(
      aliveOnA,
      "the two phones disagree about whether the row exists"
    ).toBe(aliveOnB);

    // Whichever write the ruling went against cannot silently evaporate: its
    // outbox must not claim it executed. Which one that is depends on the
    // ruling, so the branch picks the intent — never the assertion.
    const overruled = aliveOnA
      ? { seat: phoneA, intentId: deleteOnA.intentId, label: "A's trash" }
      : { seat: phoneB, intentId: renameOnB.intentId, label: "B's rename" };
    const verdict = await pendingFor(overruled.seat, overruled.intentId);
    expect(
      verdict?.status,
      `the row ${aliveOnA ? "survives" : "is gone"} and ${overruled.label} says ${JSON.stringify(verdict)}`
    ).not.toBe("executed");
  });

  test("an epoch change under an offline phone: rebootstrap, and the queued write is not lost silently", async () => {
    const doc = await uploadDoc(gateway, "Document across an epoch");
    await phoneA.session.pullNow();
    await phoneB.session.pullNow();

    // B goes into a tunnel and edits.
    phoneB.cut();
    const queued = (await phoneB.session.write("docs", {
      action: "rename",
      input: { document_id: doc, title: "B renamed it across the epoch" },
    })) as { intentId: string };

    // The vault's replica epoch rotates underneath it — what a restore or a
    // compaction does. Every seat cursor is now stale by construction.
    const before = (await readCanonical(phoneB, "core.document")).length;
    expect(before).toBeGreaterThan(0);
    const plane = gateway.handle.vaults.get(gateway.vaultId);
    expect(plane, "the gateway must expose its vault plane").toBeTruthy();
    const rotated = bumpReplicaEpoch(plane!.db.vault, { reason: "restored" });
    const attemptsBefore = phoneB.attempts.length;

    // A is online across the rotation and must recover on its own.
    await phoneA.session.pullNow();
    const onA = await readCanonical(phoneA, "core.document");
    expect(
      onA.some((row) => row["document_id"] === doc),
      "the online phone lost the row across an epoch change"
    ).toBe(true);

    // B comes back.
    phoneB.restore();
    await phoneB.session.flushIntents();
    await phoneB.session.pullNow();

    const onB = await readCanonical(phoneB, "core.document");
    expect(
      onB.some((row) => row["document_id"] === doc),
      "the offline phone did not recover the vault across an epoch change"
    ).toBe(true);

    // The rotation was real and B answered it by taking a fresh snapshot —
    // without this the recovery assertions above could pass on a stale copy
    // that was simply never asked to move.
    expect(rotated.epoch).toBeTypeOf("string");
    expect(
      phoneB.attempts
        .slice(attemptsBefore)
        .some((pathname) => pathname.includes("snapshot")),
      `B did not rebootstrap after the epoch rotated: ${phoneB.attempts.slice(attemptsBefore).join(", ")}`
    ).toBe(true);

    // THE CLAIM. The write queued before the rotation still lands after it —
    // a rebootstrap replaces the copy, and must not take the outbox with it.
    expect(
      titleOf(onB, doc),
      `the write queued before the epoch rotated did not survive it: outbox=${JSON.stringify(await pendingFor(phoneB, queued.intentId))}`
    ).toBe("B renamed it across the epoch");
  });
});
