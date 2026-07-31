import { describe, expect, it } from "vitest";

import {
  buildTestInput,
  canCommitConnectFlow,
  canStartTest,
  connectFlowReducer,
  createInitialConnectFlowState,
  vaultCapability,
} from "./connectFlow-core.js";
import type { ConnectFlowState } from "./connectFlow-core.js";

const at = (patch: Partial<ConnectFlowState>): ConnectFlowState => ({
  ...createInitialConnectFlowState(),
  ...patch,
});

describe(connectFlowReducer, () => {
  it("selectMethod(local) skips straight to the vault step", () => {
    const s = connectFlowReducer(createInitialConnectFlowState(), {
      method: "local",
      type: "selectMethod",
    });
    expect(s.step).toBe("vault");
    expect(s.method).toBe("local");
  });

  it("selectMethod(gateway) lands on details", () => {
    const s = connectFlowReducer(createInitialConnectFlowState(), {
      method: "gateway",
      type: "selectMethod",
    });
    expect(s.step).toBe("details");
  });

  it("selectMethod resets any state left over from a prior method", () => {
    const dirty = at({ method: "gateway", step: "test", ticket: "stale" });
    const s = connectFlowReducer(dirty, {
      method: "local",
      type: "selectMethod",
    });
    expect(s.ticket).toBe("");
    expect(s.step).toBe("vault");
  });

  it("createInitialConnectFlowState(method) opens straight into that method", () => {
    expect(createInitialConnectFlowState("gateway")).toMatchObject({
      method: "gateway",
      step: "details",
    });
    expect(createInitialConnectFlowState()).toMatchObject({
      method: null,
      step: "method",
    });
  });

  // The pairing UI stopped asking, so the initial state IS the product
  // default — including through a method switch, which rebuilds the state.
  it("rememberDevice starts ON and survives selecting a method", () => {
    expect(createInitialConnectFlowState().rememberDevice).toBe(true);
    expect(createInitialConnectFlowState("gateway").rememberDevice).toBe(true);
    expect(
      connectFlowReducer(createInitialConnectFlowState(), {
        method: "local",
        type: "selectMethod",
      }).rememberDevice
    ).toBe(true);
  });

  it("setRememberDevice is still honoured for a host that opts out", () => {
    expect(
      connectFlowReducer(createInitialConnectFlowState("gateway"), {
        type: "setRememberDevice",
        value: false,
      }).rememberDevice
    ).toBe(false);
  });

  it("setField updates the named field only", () => {
    const s = connectFlowReducer(createInitialConnectFlowState(), {
      field: "ticket",
      type: "setField",
      value: "abc",
    });
    expect(s.ticket).toBe("abc");
    expect(s.label).toBe("");
  });

  it("startTest moves to the test step and clears the previous report", () => {
    const withReport = at({
      report: { ok: true, stages: [] },
      step: "details",
    });
    const s = connectFlowReducer(withReport, { type: "startTest" });
    expect(s.step).toBe("test");
    expect(s.testing).toBe(true);
    expect(s.report).toBeNull();
  });

  it("testSettled records the report and clears testing", () => {
    const testing = at({ step: "test", testing: true });
    const report = {
      ok: true,
      stages: [
        {
          detail: "v0.5",
          id: "reach" as const,
          label: "Reach",
          status: "pass" as const,
        },
      ],
    };
    const s = connectFlowReducer(testing, { report, type: "testSettled" });
    expect(s.testing).toBe(false);
    expect(s.report).toStrictEqual(report);
  });

  it("continueToVault defaults to the first reported existing vault", () => {
    const withVaults = at({
      report: {
        ok: true,
        stages: [],
        vaults: [
          { name: "A", vaultId: "a" },
          { name: "B", vaultId: "b" },
        ],
      },
      step: "test",
    });
    const s = connectFlowReducer(withVaults, { type: "continueToVault" });
    expect(s.step).toBe("vault");
    expect(s.vaultChoice).toStrictEqual({ kind: "existing", vaultId: "a" });
  });

  it('continueToVault defaults to "create" for a create-capable method with no reported vaults', () => {
    const localNoVaults = at({
      method: "local",
      report: { ok: true, stages: [] },
      step: "test",
    });
    const s = connectFlowReducer(localNoVaults, { type: "continueToVault" });
    expect(s.vaultChoice).toStrictEqual({ kind: "create" });
  });

  it("localVaultsLoaded records a successful read as options with no error", () => {
    const s = connectFlowReducer(at({ method: "local", step: "vault" }), {
      result: { ok: true, vaults: [{ name: "Personal", vaultId: "p" }] },
      type: "localVaultsLoaded",
    });
    expect(s.report?.vaults).toStrictEqual([
      { name: "Personal", vaultId: "p" },
    ]);
    expect(s.vaultsError).toBeNull();
  });

  it("localVaultsLoaded records a FAILED read as an error, not an empty registry", () => {
    const s = connectFlowReducer(at({ method: "local", step: "vault" }), {
      result: { ok: false, message: "gateway is down" },
      type: "localVaultsLoaded",
    });
    // Settled (so the step leaves "Loading vaults…") but unhappy.
    expect(s.report).not.toBeNull();
    expect(s.vaultsError).toBe("gateway is down");
    expect(
      canCommitConnectFlow({
        ...s,
        vaultChoice: { kind: "create" },
        newVaultName: "X",
      })
    ).toBe(false);
  });

  it("continueToVault leaves vaultChoice null for a ticket connect (locked, not a real choice)", () => {
    const ticket = at({
      method: "gateway",
      report: {
        ok: true,
        stages: [],
        ticket: { expiresAt: "", gatewayEndpointId: "", vaultName: "Home" },
      },
      step: "test",
    });
    const s = connectFlowReducer(ticket, { type: "continueToVault" });
    expect(s.vaultChoice).toBeNull();
  });

  it("back from details clears the method and returns to method", () => {
    const s = connectFlowReducer(
      at({ method: "gateway", step: "details", ticket: "x" }),
      {
        type: "back",
      }
    );
    expect(s.step).toBe("method");
    expect(s.method).toBeNull();
  });

  it("back from test returns to details, keeping the method", () => {
    const s = connectFlowReducer(at({ method: "gateway", step: "test" }), {
      type: "back",
    });
    expect(s.step).toBe("details");
    expect(s.method).toBe("gateway");
  });

  it("back from vault for a local method returns straight to method (skips details/test)", () => {
    const s = connectFlowReducer(at({ method: "local", step: "vault" }), {
      type: "back",
    });
    expect(s.step).toBe("method");
  });

  it("back from vault for a gateway method returns to test, keeping the report", () => {
    const report = { ok: true, stages: [] };
    const s = connectFlowReducer(
      at({ method: "gateway", report, step: "vault" }),
      {
        type: "back",
      }
    );
    expect(s.step).toBe("test");
    expect(s.report).toStrictEqual(report);
  });

  it("back from the error step returns to vault so the user can retry", () => {
    const s = connectFlowReducer(
      at({ commitError: "boom", method: "local", step: "error" }),
      {
        type: "back",
      }
    );
    expect(s.step).toBe("vault");
    expect(s.commitError).toBeNull();
  });

  it("commit -> commitSettled reaches done with the result", () => {
    let s = connectFlowReducer(createInitialConnectFlowState(), {
      type: "commit",
    });
    expect(s.step).toBe("committing");
    expect(s.committing).toBe(true);
    s = connectFlowReducer(s, {
      result: { displayLabel: "Home", gatewayId: "gw1", vaultId: "v1" },
      type: "commitSettled",
    });
    expect(s.step).toBe("done");
    expect(s.committing).toBe(false);
    expect(s.result).toStrictEqual({
      displayLabel: "Home",
      gatewayId: "gw1",
      vaultId: "v1",
    });
  });

  it("commitFailed reaches the error step with the message", () => {
    const s = connectFlowReducer(at({ committing: true, step: "committing" }), {
      error: "unreachable",
      type: "commitFailed",
    });
    expect(s.step).toBe("error");
    expect(s.commitError).toBe("unreachable");
  });

  it("reset returns to the initial state", () => {
    const dirty = at({ method: "local", step: "vault", ticket: "x" });
    expect(connectFlowReducer(dirty, { type: "reset" })).toStrictEqual(
      createInitialConnectFlowState()
    );
  });
});

describe("buildTestInput / canStartTest", () => {
  it("is null with nothing filled in", () => {
    expect(buildTestInput(createInitialConnectFlowState())).toBeNull();
    expect(canStartTest(createInitialConnectFlowState())).toBe(false);
  });

  it('gateway/ticket mode: {kind:"ticket"} once a ticket is present', () => {
    const s = at({ method: "gateway", ticket: "  t.icket  " });
    expect(buildTestInput(s)).toStrictEqual({
      kind: "ticket",
      ticket: "t.icket",
    });
  });

  it("local never has a testable input — the embedded gateway is always reachable", () => {
    expect(buildTestInput(at({ method: "local" }))).toBeNull();
    expect(canStartTest(at({ method: "local" }))).toBe(false);
  });
});

describe(vaultCapability, () => {
  it("local: create-capable, no lock", () => {
    const cap = vaultCapability(at({ method: "local" }));
    expect(cap).toStrictEqual({ canCreate: true, locked: null, options: [] });
  });

  it("local: options come from the loaded vault list", () => {
    const cap = vaultCapability(
      at({
        method: "local",
        report: { ok: true, stages: [], vaults: [{ name: "A", vaultId: "a" }] },
      })
    );
    expect(cap).toStrictEqual({
      canCreate: true,
      locked: null,
      options: [{ name: "A", vaultId: "a" }],
    });
  });

  it("gateway/ticket: locked to the ticket vault name, not create-capable", () => {
    const cap = vaultCapability(
      at({
        method: "gateway",
        report: {
          ok: true,
          stages: [],
          ticket: { expiresAt: "", gatewayEndpointId: "", vaultName: "Office" },
        },
      })
    );
    expect(cap).toStrictEqual({
      canCreate: false,
      locked: { vaultName: "Office" },
      options: [],
    });
  });
});

describe(canCommitConnectFlow, () => {
  it("local requires a vault choice, and a name when creating", () => {
    expect(canCommitConnectFlow(at({ method: "local" }))).toBe(false);
    expect(
      canCommitConnectFlow(
        at({ method: "local", vaultChoice: { kind: "existing", vaultId: "a" } })
      )
    ).toBe(true);
    expect(
      canCommitConnectFlow(
        at({ method: "local", vaultChoice: { kind: "create" } })
      )
    ).toBe(false);
    expect(
      canCommitConnectFlow(
        at({
          method: "local",
          newVaultName: "Mine",
          vaultChoice: { kind: "create" },
        })
      )
    ).toBe(true);
  });

  it("gateway/ticket requires a non-empty ticket", () => {
    expect(canCommitConnectFlow(at({ method: "gateway" }))).toBe(false);
    expect(canCommitConnectFlow(at({ method: "gateway", ticket: "t" }))).toBe(
      true
    );
  });

  // Issue #603 D10: a redeemed enrollment that names no vault left the vault
  // step rendering an empty list with "Continue" still live.
  it("gateway/ticket blocks commit when the redeemed report grants no vault", () => {
    const report = { ok: true, stages: [] };
    expect(
      canCommitConnectFlow(
        at({ method: "gateway", report, step: "vault", ticket: "t" })
      )
    ).toBe(false);
    expect(
      canCommitConnectFlow(
        at({
          method: "gateway",
          report: {
            ...report,
            ticket: {
              expiresAt: "",
              gatewayEndpointId: "",
              vaultName: "Office",
            },
          },
          step: "vault",
          ticket: "t",
        })
      )
    ).toBe(true);
  });
});
