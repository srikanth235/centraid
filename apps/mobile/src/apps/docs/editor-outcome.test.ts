// The editor's seven write outcomes (#821, spec §9) — the mapping from the
// replica's REAL result union to the posture the member sees, and the copy
// each posture carries. The two distinctions the spec names as load-bearing
// are asserted by name: queued ≠ waiting-for-approval, and a no-op is not a
// version.
import { describe, expect, it } from "vitest";

import type { NativeWriteResult } from "../../lib/replica/native-session";
import {
  EDITOR_ACTION_LABELS,
  editorOutcomeCopy,
  NOT_TEXT_REASON,
  postureFromResult,
} from "./editor-outcome";

describe(postureFromResult, () => {
  it("maps executed → saved", () => {
    const result: NativeWriteResult = { intentId: "i", status: "executed" };
    expect(postureFromResult(result).id).toBe("saved");
  });

  it("maps parked → approval (held, not refused — and not queued)", () => {
    const result: NativeWriteResult = {
      intentId: "i",
      status: "parked",
      reason: "owner approval required",
    };
    expect(postureFromResult(result).id).toBe("approval");
  });

  it("maps queued → queued (nobody has to consent to a queued write)", () => {
    const result: NativeWriteResult = { intentId: "i", status: "queued" };
    expect(postureFromResult(result).id).toBe("queued");
  });

  it("maps in-flight → saving", () => {
    const result: NativeWriteResult = { intentId: "i", status: "in-flight" };
    expect(postureFromResult(result).id).toBe("saving");
  });

  it("maps denied, failed and conflict all to the Refused posture, carrying the vault's own reason", () => {
    for (const status of ["denied", "failed", "conflict"] as const) {
      const posture = postureFromResult({
        intentId: "i",
        status,
        reason: "body_is_text precondition failed",
      });
      expect(posture.id).toBe("refused");
      expect(posture.reason).toBe("body_is_text precondition failed");
    }
  });

  it("never invents a reason field's absence into silence", () => {
    const posture = postureFromResult({ intentId: "i", status: "denied" });
    expect(posture.reason).toBe("the vault rejected this change");
  });
});

describe(editorOutcomeCopy, () => {
  it("unsaved: the local-dirt line, Save enabled", () => {
    const copy = editorOutcomeCopy({ id: "unsaved" });
    expect(copy.line).toBe(
      "Unsaved changes on this device · nothing has been committed"
    );
    expect(copy.commit).toBe("Save");
    expect(copy.commitEnabled).toBe(true);
    expect(copy.net).toBe(false);
  });

  it("saving: one command in flight, commit not pressable", () => {
    const copy = editorOutcomeCopy({ id: "saving" });
    expect(copy.line).toBe("Saving · one command in flight");
    expect(copy.commit).toBe("Saving…");
    expect(copy.commitEnabled).toBe(false);
  });

  it("saved: interpolates the REAL version and clock, offers the history", () => {
    const copy = editorOutcomeCopy({
      id: "saved",
      savedVersion: 7,
      savedAt: "2026-08-18T14:02:00",
    });
    expect(copy.line).toBe("Saved · version 7 · 14:02");
    expect(copy.action).toBe("receipt");
    expect(copy.commit).toBe("Saved");
  });

  it("saved with no known chain count says Saved without inventing a number", () => {
    const copy = editorOutcomeCopy({
      id: "saved",
      savedVersion: null,
      savedAt: "2026-08-18T09:05:00",
    });
    expect(copy.line).toBe("Saved · 09:05");
    expect(copy.line).not.toContain("version");
  });

  it("nochange: a no-op is not a version", () => {
    const copy = editorOutcomeCopy({ id: "nochange" });
    expect(copy.line).toBe("Nothing changed · no new version, no receipt");
    expect(copy.note).toContain("a no-op is not a version");
    expect(copy.commitEnabled).toBe(true);
  });

  it("approval: held, not refused — and its note says it is not queued", () => {
    const copy = editorOutcomeCopy({ id: "approval" });
    expect(copy.line).toBe(
      "Waiting for the owner's approval · held, not refused"
    );
    expect(copy.note).toContain("is not the same state as queued");
    expect(copy.action).toBe("approvals");
    expect(copy.net).toBe(false);
  });

  it("queued: the gateway is unreachable, nothing lost, net tone", () => {
    const copy = editorOutcomeCopy({ id: "queued" });
    expect(copy.line).toBe(
      "Queued on this device · the gateway is unreachable"
    );
    expect(copy.note).toContain("Nobody has to approve it");
    expect(copy.net).toBe(true);
    expect(copy.action).toBeUndefined();
  });

  it("refused (not text): names the rule and offers 'What can be edited?'", () => {
    const copy = editorOutcomeCopy({ id: "refused", reason: NOT_TEXT_REASON });
    expect(copy.line).toBe("Refused · this document is not text");
    expect(copy.note).toContain("A body can only be set on a text document");
    expect(copy.action).toBe("editable");
    expect(EDITOR_ACTION_LABELS[copy.action!]).toBe("What can be edited?");
    expect(copy.net).toBe(true);
  });

  it("refused (vault reason): carries the vault's own sentence, no rule invented", () => {
    const copy = editorOutcomeCopy({
      id: "refused",
      reason: "read-only on this vault",
    });
    expect(copy.line).toBe("Refused · read-only on this vault");
    expect(copy.action).toBeUndefined();
  });
});
