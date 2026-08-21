import { describe, expect, it, vi } from "vitest";

import { TurnPlane } from "./turn-plane.js";
import type { RunTurnFn } from "./turn.js";

describe(TurnPlane, () => {
  it("routes every posture through the required host-accounted seam", async () => {
    const accountedDispatch = vi.fn<RunTurnFn>(async (_input, config) => ({
      harnessKind: config.prefs.kind,
    }));
    const plane = new TurnPlane(accountedDispatch);
    const abortSignal = new AbortController().signal;

    await plane.runTurn(
      {
        conversationId: "c",
        cwd: "/tmp",
        message: "hello",
        extraSystemPrompt: "",
        abortSignal,
        onEvent: () => undefined,
      },
      { kind: "codex" },
      {
        surface: "automation",
        egress: "unattended",
        egressConsent: () => true,
        failover: "fire-boundary",
        permissionPolicy: "deny",
        artifacts: "delegate-only",
      }
    );

    expect(accountedDispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ permissionPolicy: "deny" }),
      { prefs: { kind: "codex" } }
    );
  });

  it("does not weaken an explicit permission policy", async () => {
    const dispatch = vi.fn<RunTurnFn>(async (_input, config) => ({
      harnessKind: config.prefs.kind,
    }));
    const plane = new TurnPlane(dispatch);
    await plane.runTurn(
      {
        conversationId: "c",
        cwd: "/tmp",
        message: "hello",
        extraSystemPrompt: "",
        abortSignal: new AbortController().signal,
        permissionPolicy: "deny",
        onEvent: () => undefined,
      },
      { kind: "codex" },
      {
        surface: "interactive",
        egress: "attended",
        egressConsent: () => true,
        failover: "turn-boundary",
        permissionPolicy: "auto-allow",
        artifacts: "capture",
      }
    );
    expect(dispatch.mock.calls[0]?.[0].permissionPolicy).toBe("deny");
  });

  it("fails closed at the door before an unconsented harness dispatch", async () => {
    const dispatch = vi.fn<RunTurnFn>();
    const plane = new TurnPlane(dispatch);
    await expect(
      plane.runTurn(
        {
          conversationId: "c",
          cwd: "/tmp",
          message: "hello",
          extraSystemPrompt: "",
          abortSignal: new AbortController().signal,
          onEvent: () => undefined,
        },
        { kind: "codex" },
        {
          surface: "interactive",
          egress: "attended",
          egressConsent: () => false,
          failover: "none",
          permissionPolicy: "deny",
          artifacts: "delegate-only",
        }
      )
    ).rejects.toMatchObject({
      code: "provider-egress-consent-required",
      harnessKind: "codex",
      egress: "attended",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
