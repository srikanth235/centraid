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
 * Per #743 Part 2 item (c) the handler now names its harness PER CALL
 * (`ctx.delegate({ harness })`) rather than the fire's whole ambient harness
 * changing mid-flight — the literal shape the issue's acceptance criterion
 * describes: "a fire whose handler calls ctx.delegate twice with two
 * different harnesses resumes each harness's own acp_session_id and settles
 * both bindings' watermarks".
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

  test("ctx.delegate twice with two different harnesses resumes each one's own session id and settles both watermarks", async () => {
    const { workdir, journalDbFile, ref } =
      await seededJournal("session-codex-old");

    // Two LITERAL ctx.delegate calls, each naming its own harness — the
    // shape the issue's acceptance criterion describes, not two calls that
    // happen to land on different backends through the same ambient kind.
    const claude = stubHarness("claude-code", (input) => {
      input.onEvent({ type: "final", text: "answer" });
      return { harnessKind: "claude-code", sessionId: "session-claude-new" };
    });
    const codex = stubHarness("codex", (input) => {
      input.onEvent({ type: "final", text: "answer" });
      return { harnessKind: "codex", sessionId: "session-codex-new" };
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
    await dispatch.delegateDispatcher(
      { prompt: "step one", harness: "claude-code" },
      dispatchCtx
    );
    await dispatch.delegateDispatcher(
      { prompt: "step two", harness: "codex" },
      dispatchCtx
    );
    store.finishTurn({ turnId: "fire-1", endedAt: 4, ok: true });
    dispatch.finalizeTurn(store, ref, "fire-1", true);
    store.close();
    await dispatch.close();

    // Each named harness heard exactly its own call.
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    // Resume: codex's own durable handle, not the one claude-code minted a
    // moment earlier — the regression an unkeyed slot would have produced.
    expect(codex.calls[0]?.prevSessionId).toBe("session-codex-old");
    expect(codex.calls[0]?.prevSessionId).not.toBe("session-claude-new");
    expect(claude.calls[0]?.prevSessionId).toBeUndefined();

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
