// THE op-sqlite PROBE (#890 follow-up) — the one claim the Node tier cannot make.
//
// WHY THIS EXISTS, precisely. `tests/integration-mobile/` proves 52 of the 56
// app × state cells, and every one of them runs against `NodeSqliteDriver` —
// the repo's `node:sqlite` stand-in, which says so in its own header
// (`tests/integration-mobile/lib/seat.ts`). Same SQL, different engine, and the
// difference is not cosmetic:
//
//   - node:sqlite runs IN MEMORY in that tier. There is no database file, no
//     `-wal` / `-shm` sidecar, and therefore no write-ahead log to recover.
//   - op-sqlite runs on the device's flash through a native module, with real
//     fsync behaviour and real statement lifetimes across a JS reload.
//   - `apps/mobile/src/lib/replica/sqlite-intent-store.test.ts` states plainly
//     that its interleaving cases pin atomicity across `await` boundaries and
//     NOT OS-level contention on a file, because single-threaded node:sqlite
//     cannot produce it.
//
// So 52 green cells are evidence about the stand-in. This flow is the smallest
// thing that is evidence about the engine the product actually ships.
//
// ─── THE CLAIM ──────────────────────────────────────────────────────────────
// A burst of five writes, each read back before the next begins, ALL survive
// process death on real flash. The per-write assertions are individual rather
// than a single "a note is visible" check, because the vacuous shape passes
// while four of five writes are missing (#483).
//
// NOT A CONCURRENCY CLAIM, and an earlier draft of this header wrongly made one
// ("every write lands while the previous write's replica commit and the list's
// read are still in flight… that overlap is the contention this flow exists to
// create"). It cannot be: each `ctx.run` spawns a `maestro test` process and
// awaits its exit, and the read assertion must SUCCEED before that process
// exits, so every write strictly follows a completed read. Maestro drives one
// device serially and has no primitive for overlapping two chunks. Contention on
// the real driver would need a second writer the harness cannot produce — it
// stays a gap, and it is a smaller and more honest one than a claim this flow
// does not support.
//
// ─── WHAT THIS DOES NOT PROVE, stated so the cell is not over-read ──────────
//   - LOSSLESS IS PROVEN; EXACTLY-ONCE IS ONLY PARTLY PROVEN. The final
//     assertion catches a duplicate that WAL recovery re-executes and re-stamps
//     (the leading row would then be an earlier index than the last write). It
//     does NOT catch a row re-inserted verbatim with its original timestamp:
//     that copy sorts in the same place, and `assertVisible` is satisfied by
//     either copy. Maestro has no count assertion, so closing this needs a
//     surface that publishes a row count — not a cleverer selector. Written down
//     because an earlier draft of this header claimed "exactly once" flatly,
//     which the assertion below does not support.
//   - Statement lifetime across a JS reload. Maestro cannot force a Hermes
//     reload without also restarting the process, which resets the thing being
//     measured.
//   - op-sqlite's error surfaces (busy timeouts, corrupt-file handling). Those
//     need a fault injector the harness does not have, and inventing one here
//     would test the injector.
//   - Anything about iOS specifically on a lane that runs Android first (D1).
// Each of those is a smaller, nameable gap than the one this closes, and none is
// silently implied by a green run of this file.
//
// ─── STATUS ─────────────────────────────────────────────────────────────────
// NEVER RUN. This flow was written in an environment with no emulator and no
// simulator, so it is verified statically only. It is deliberately scheduled on
// the NIGHTLY roster rather than the PR gate: an unproven flow must not be able
// to block a merge, and the first real runs are what earn it a promotion.
// Recorded the same way in tests/agent-e2e-mobile/roster.json.

import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

/** How many notes the contention burst writes. Small enough to stay inside the
 *  suite budget, large enough that losing or duplicating one is unmistakable in
 *  a count rather than a judgement call. */
const BURST = 5;

await runFlow("op-sqlite-probe", async (ctx) => {
  await ctx.ensureDemo("notes");
  await ctx.configureGateway();

  // Per-RUN, never per-suite: a note left by yesterday's nightly on a
  // long-lived gateway would satisfy a survival assertion the run did not earn.
  const tag = `opsqlite ${ctx.state.runId}`;

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- assertVisible:
    id: "notes-row-first"
`,
    "notes-open"
  );
  ctx.note("Notes cover open on the seeded corpus");

  // ─── The burst ────────────────────────────────────────────────────────────
  // Each iteration opens the composer, writes one uniquely-numbered note, saves,
  // and reads it back from the library list before the next begins. SEQUENTIAL,
  // deliberately and unavoidably — see the header. What five sequential writes
  // buy over one is a durable file with five committed transactions and a WAL
  // that has been appended to repeatedly before the kill, which is the state
  // recovery actually has to handle and which an in-memory stand-in never has.
  for (let index = 0; index < BURST; index += 1) {
    const title = `${tag} ${index}`;
    // The overlap IS the test: these writes must be ordered against each other,
    // and Promise.all would drive one UI with five concurrent Maestro chunks,
    // which is not a thing.
    // oxlint-disable-next-line no-await-in-loop
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible:
      id: "notes-capture"
    timeout: 30000
- tapOn:
    id: "notes-capture"
- extendedWaitUntil:
    visible:
      id: "notes-editor-close"
    timeout: 30000
- tapOn: "Title"
- inputText: "${title}"
- assertVisible: "${title}"
- hideKeyboard
- tapOn: "Save this note"
# The list is a different tree from the editor and sorts pinned-then-newest, so
# the note just written is the leading row. Asserting it HERE, before the next
# iteration opens the composer again, is what keeps the next write overlapping
# this read rather than following it.
- extendedWaitUntil:
    visible:
      id: "notes-row-first"
    timeout: 30000
- assertVisible: "Open ${title}"
`,
      `burst-${index}`
    );
  }
  ctx.note(`${BURST} notes written and each read back before the next`);

  // ─── Process death ────────────────────────────────────────────────────────
  await ctx.restart();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${retryableTapCommands("Open Notes.*")}
- extendedWaitUntil:
    visible: "New note"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`,
    "relaunch"
  );

  // EVERY write is present after the kill. Asserted one at a time rather than
  // as a count, because Maestro has no count assertion and a single "some note
  // is visible" check is exactly the vacuous shape #483 outlawed: it passes
  // while four of five writes are missing.
  for (let index = 0; index < BURST; index += 1) {
    // Ordered assertions against one device; see the burst loop above.
    // oxlint-disable-next-line no-await-in-loop
    await ctx.run(
      `appId: ${ctx.state.appId}
---
- assertVisible: "Open ${tag} ${index}"
`,
      `survived-${index}`
    );
  }
  ctx.note(`all ${BURST} writes survived process death`);

  // ─── No RE-EXECUTED intent on recovery ────────────────────────────────────
  // What distinguishes this from `notes-library`'s survival claim, and the exact
  // limit of it. `notes-row-first` carries the newest note, which after a clean
  // recovery is the last write of the burst. If WAL recovery RE-EXECUTED an
  // earlier queued intent, the resulting row is stamped now and therefore sorts
  // ahead — so the leading row would carry an earlier index and this fails.
  //
  // It does NOT detect a row re-inserted verbatim with its original timestamp:
  // that duplicate sorts where the original did and every assertion here still
  // passes. This assertion is a re-execution detector, not a uniqueness proof,
  // and the header says so rather than letting the section title imply more.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- assertVisible:
    id: "notes-row-first"
- assertVisible: "Open ${tag} ${BURST - 1}"
`,
    "exactly-once"
  );
  ctx.note(
    "leading row is still the last write of the burst — no intent re-executed on recovery"
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- takeScreenshot: op-sqlite-probe
`,
    "evidence"
  );
});
