/*
 * One fire, two harnesses (#743 Part 2 item 2) — the `latestAdapter`
 * regression.
 *
 * The fire path used to keep ONE unkeyed slot for "the binding this fire
 * touched". A fire that reached two harnesses therefore (a) handed the second
 * one the opaque ACP session id the first one minted, and (b) could settle
 * only one binding's hydration watermark, silently stranding the other at a
 * watermark it had already moved past. `HarnessSessions` keys both by
 * `(conversationRef, harnessKind)`, so each harness resumes its OWN session id
 * and every binding the fire touched settles itself.
 *
 * The second harness enters through the accounted seam: `runTurn` reports the
 * harness that actually produced the session id, which is not necessarily the
 * one the call asked for. Naming a harness per `ctx.delegate` call is #743
 * item (c); the invariant under test is the same either way — a session id
 * belongs to whoever minted it.
 */

import { afterEach, describe, expect, test } from "vitest";

import { ConversationStore, makeJournalDbProvider } from "@centraid/app-engine";
import type {
  RunTurnFn,
  TurnConfig,
  TurnInput,
  TurnResult,
} from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { HARNESSES } from "../registry.ts";
import type { HarnessKind } from "../types.ts";
import { startLiveDispatch } from "./run-automation-live-dispatch.ts";

/** The host's injected, resource-accounted driver, as the gateway wires it. */
const accountedRunTurn: RunTurnFn = (input, config) =>
  HARNESSES[config.prefs.kind].runTurn(input, config);

const dispatchCtx = {
  runId: "fire-1",
  automationId: "demo/nightly",
  abortSignal: new AbortController().signal,
};

const restores: Array<() => void> = [];

describe("one fire, two harnesses", () => {
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });

  /** Swap one harness's `runTurn` for a recording stub. */
  function stubHarness(
    kind: HarnessKind,
    impl: (input: TurnInput, config: TurnConfig) => TurnResult
  ): { calls: TurnInput[] } {
    const original = HARNESSES[kind];
    const calls: TurnInput[] = [];
    HARNESSES[kind] = {
      ...original,
      runTurn: async (input, config) => {
        calls.push(input);
        return impl(input, config);
      },
    };
    restores.push(() => {
      HARNESSES[kind] = original;
    });
    return { calls };
  }

  /** A journal holding one settled history turn plus a codex binding on it. */
  async function seededJournal(codexSessionId: string): Promise<{
    workdir: string;
    journalDbFile: string;
    ref: string;
  }> {
    const workdir = await tempDir("centraid-two-harness-");
    const journalDbFile = `${workdir}/journal.db`;
    const ref = "demo/nightly";
    const seed = new ConversationStore(makeJournalDbProvider(journalDbFile));
    seed.ensureAutomationConversation(ref, "demo", "Nightly", "codex");
    seed.insertTurn({
      turnId: "history-0",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 1,
    });
    seed.finishTurn({
      turnId: "history-0",
      endedAt: 2,
      ok: true,
      summary: "earlier outcome",
    });
    seed.noteTurn(ref, "", [
      { kind: "codex", sessionId: codexSessionId, ok: true },
    ]);
    seed.close();
    return { workdir, journalDbFile, ref };
  }

  test("each harness resumes its own session id and both watermarks settle", async () => {
    const { workdir, journalDbFile, ref } =
      await seededJournal("session-codex-old");

    // The accounted seam lands on claude-code for the first delegate call and
    // on codex for the second — one fire, two harnesses, two session ids.
    let landing = 0;
    const codex = stubHarness("codex", (input) => {
      input.onEvent({ type: "final", text: "answer" });
      landing += 1;
      return landing === 1
        ? { harnessKind: "claude-code", sessionId: "session-claude-new" }
        : { harnessKind: "codex", sessionId: "session-codex-new" };
    });

    const dispatch = await startLiveDispatch({
      workdir,
      runId: "fire-1",
      automationRef: ref,
      journalDbFile,
      runTurn: accountedRunTurn,
      harness: "codex",
      onLog: () => undefined,
    });
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    store.insertTurn({
      turnId: "fire-1",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 3,
    });
    await dispatch.delegateDispatcher({ prompt: "step one" }, dispatchCtx);
    await dispatch.delegateDispatcher({ prompt: "step two" }, dispatchCtx);
    store.finishTurn({ turnId: "fire-1", endedAt: 4, ok: true });
    dispatch.finalizeTurn(store, ref, "fire-1", true);
    store.close();
    await dispatch.close();

    // Resume: codex's own durable handle, on BOTH calls. The second call is
    // the regression — an unkeyed slot would have offered it the session id
    // claude-code minted a moment earlier.
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[0]?.prevSessionId).toBe("session-codex-old");
    expect(codex.calls[1]?.prevSessionId).toBe("session-codex-old");
    expect(codex.calls[1]?.prevSessionId).not.toBe("session-claude-new");

    // Settlement: BOTH bindings exist, each holding its own minted session id,
    // and BOTH watermarks advanced to this fire's turn (seq 1).
    const after = new ConversationStore(makeJournalDbProvider(journalDbFile));
    expect(after.getHarnessBinding(ref, "claude-code")).toMatchObject({
      acpSessionId: "session-claude-new",
      hydratedThroughSeq: 1,
    });
    expect(after.getHarnessBinding(ref, "codex")).toMatchObject({
      acpSessionId: "session-codex-new",
      hydratedThroughSeq: 1,
    });
    after.close();

    const db = makeJournalDbProvider(journalDbFile)();
    const rows = db
      .prepare(
        `SELECT harness_kind, acp_session_id, hydrated_through_seq, status
           FROM conversation_harness_sessions
          WHERE conversation_id = ?
          ORDER BY harness_kind, acp_session_id`
      )
      .all(ref) as Array<{
      harness_kind: string;
      acp_session_id: string;
      hydrated_through_seq: number;
      status: string;
    }>;
    expect(
      rows.map((row) => ({
        harness_kind: row.harness_kind,
        acp_session_id: row.acp_session_id,
        hydrated_through_seq: Number(row.hydrated_through_seq),
        status: row.status,
      }))
    ).toStrictEqual([
      {
        harness_kind: "claude-code",
        acp_session_id: "session-claude-new",
        hydrated_through_seq: 1,
        status: "warm",
      },
      {
        harness_kind: "codex",
        acp_session_id: "session-codex-new",
        hydrated_through_seq: 1,
        status: "active",
      },
      // The superseded codex handle is kept as audit, never re-offered.
      {
        harness_kind: "codex",
        acp_session_id: "session-codex-old",
        hydrated_through_seq: 0,
        status: "stale",
      },
    ]);
    db.close();
  });

  test("a fire retires a binding whose resume handle the harness abandoned", async () => {
    // Chat has retired these since #567 D9; the fire path never did, so a dead
    // handle was re-offered on every later fire — a failed resume plus a
    // full-ledger recovery fold, for ever.
    const { workdir, journalDbFile, ref } = await seededJournal("session-dead");
    stubHarness("codex", (input) => {
      input.onEvent({ type: "final", text: "answer" });
      return {
        harnessKind: "codex",
        sessionId: "session-healed",
        hydrated: true,
        hydrationKind: "recovery",
      };
    });

    const dispatch = await startLiveDispatch({
      workdir,
      runId: "fire-1",
      automationRef: ref,
      journalDbFile,
      runTurn: accountedRunTurn,
      harness: "codex",
      onLog: () => undefined,
    });
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    store.insertTurn({
      turnId: "fire-1",
      conversationId: ref,
      triggerKind: "scheduled",
      startedAt: 3,
    });
    await dispatch.delegateDispatcher({ prompt: "go" }, dispatchCtx);
    store.finishTurn({ turnId: "fire-1", endedAt: 4, ok: true });
    dispatch.finalizeTurn(store, ref, "fire-1", true);
    store.close();
    await dispatch.close();

    const after = new ConversationStore(makeJournalDbProvider(journalDbFile));
    expect(after.getHarnessBinding(ref, "codex")).toMatchObject({
      acpSessionId: "session-healed",
    });
    // The recovery fold the harness consumed is billed onto the fire's turn.
    expect(after.getTurn("fire-1")?.hydrationTokens).toBeGreaterThan(0);
    after.close();

    const db = makeJournalDbProvider(journalDbFile)();
    expect(
      db
        .prepare(
          `SELECT status FROM conversation_harness_sessions
            WHERE conversation_id = ? AND acp_session_id = 'session-dead'`
        )
        .get(ref)
    ).toMatchObject({ status: "stale" });
    db.close();
  });
});
