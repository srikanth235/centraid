import { describe, expect, it } from "vitest";

import { READ_ONLY_SOURCE_REASON } from "../../kit/replica/row-provenance";
import { viewerToolbarStates } from "./viewer-toolbar-states";

// #1015 B10 — the bottom row used to render all five controls identically,
// with four of them disabled at full opacity and no reason anywhere.
describe("viewerToolbarStates — no armed-looking dead control", () => {
  const base = {
    writable: true,
    hasVaultAsset: true,
    editable: true,
    canSaveToMyVault: true,
    hasEditor: true,
  };

  it("arms all five on a writable vault photograph with an editor and a commons offer", () => {
    const states = viewerToolbarStates(base);
    expect(Object.values(states).every((state) => state.enabled)).toBe(true);
  });

  it("never disables a control without a reason on it", () => {
    for (const input of [
      base,
      { ...base, writable: false },
      { ...base, hasVaultAsset: false },
      { ...base, editable: false },
      { ...base, canSaveToMyVault: false },
      { ...base, hasEditor: false },
    ])
      for (const [id, state] of Object.entries(viewerToolbarStates(input)))
        expect({
          id,
          hasReason: state.enabled || Boolean(state.reason),
        }).toStrictEqual({ id, hasReason: true });
  });

  it("refuses every write with the ladder's own sentence on a read-only source", () => {
    const states = viewerToolbarStates({ ...base, writable: false });
    for (const id of ["favorite", "trash", "edit"] as const)
      expect(states[id]).toStrictEqual({
        enabled: false,
        reason: READ_ONLY_SOURCE_REASON,
      });
    // Info reads; it is never refused.
    expect(states.info).toStrictEqual({ enabled: true });
  });

  it("says a video has no non-destructive editor rather than reusing the write refusal", () => {
    expect(
      viewerToolbarStates({ ...base, editable: false }).edit
    ).toStrictEqual({
      enabled: false,
      reason: "Crop and rotate work on photographs, not on this kind of media",
    });
  });

  it("tells a member their own photograph is already theirs, rather than dimming Copy in silence", () => {
    expect(
      viewerToolbarStates({ ...base, canSaveToMyVault: false }).copy
    ).toStrictEqual({
      enabled: false,
      reason: "This photograph is already yours",
    });
  });
});
