import { describe, expect, it } from "vitest";

import {
  photoAccessCopy,
  photoAccessState,
  photoAccessTakesOverTimeline,
} from "./photo-access";

const KNOWN = { canAskAgain: true, readableCount: 12 };

describe(photoAccessState, () => {
  it("reads a limited iOS grant as limited, not as granted", () => {
    expect(
      photoAccessState({
        status: "granted",
        accessPrivileges: "limited",
        canAskAgain: true,
      })
    ).toBe("limited");
  });

  it("reads a full grant as granted, on both platforms", () => {
    expect(
      photoAccessState({
        status: "granted",
        accessPrivileges: "all",
        canAskAgain: false,
      })
    ).toBe("granted");
    expect(photoAccessState({ status: "granted", canAskAgain: false })).toBe(
      "granted"
    );
  });

  it("separates a refusal from a question never asked", () => {
    expect(photoAccessState({ status: "denied", canAskAgain: false })).toBe(
      "denied"
    );
    expect(
      photoAccessState({ status: "undetermined", canAskAgain: true })
    ).toBe("undetermined");
  });
});

describe(photoAccessCopy, () => {
  it("never offers an ask the operating system will refuse to show", () => {
    const stopped = photoAccessCopy("denied", {
      canAskAgain: false,
      readableCount: null,
    });
    expect(stopped.primary).toStrictEqual({
      action: "settings",
      label: "Open Settings",
    });
    expect(stopped.secondary).toBeNull();

    const askable = photoAccessCopy("denied", KNOWN);
    expect(askable.primary?.action).toBe("ask");
  });

  it("has no ask at all once the grant is complete", () => {
    const copy = photoAccessCopy("granted", KNOWN);
    expect(copy.primary).toBeNull();
    expect(copy.secondary?.action).toBe("settings");
  });

  it("says what a limited grant cannot see, and marks that row net", () => {
    const copy = photoAccessCopy("limited", KNOWN);
    expect(copy.primary).toStrictEqual({
      action: "settings",
      label: "Choose more in Settings",
    });
    const cannot = copy.rows.find((row) => row.net);
    expect(cannot?.label).toBe("What Photos cannot see");
    expect(cannot?.sub).toContain("anything taken since you chose");
  });

  it("prints the readable count only when it is known", () => {
    expect(photoAccessCopy("limited", KNOWN).rows[0]?.meta).toBe("12");
    expect(
      photoAccessCopy("limited", { canAskAgain: true, readableCount: null })
        .rows[0]?.meta
    ).toBe("");
  });

  it("never says the storage noun to a member (#599)", () => {
    for (const state of [
      "granted",
      "limited",
      "denied",
      "undetermined",
    ] as const) {
      const copy = photoAccessCopy(state, KNOWN);
      const prose = [
        copy.headline,
        copy.lede,
        copy.primary?.label ?? "",
        copy.secondary?.label ?? "",
        ...copy.rows.flatMap((row) => [row.label, row.sub, row.meta]),
      ].join(" ");
      expect(prose.toLowerCase()).not.toContain("vault");
    }
  });
});

describe(photoAccessTakesOverTimeline, () => {
  const base = { deviceReadableCount: 0, loading: false };

  it("takes the grid over for a refused grant, and for one never asked for", () => {
    expect(photoAccessTakesOverTimeline({ ...base, state: "denied" })).toBe(
      true
    );
    expect(
      photoAccessTakesOverTimeline({ ...base, state: "undetermined" })
    ).toBe(true);
  });

  it("leaves a granted grant alone", () => {
    expect(photoAccessTakesOverTimeline({ ...base, state: "granted" })).toBe(
      false
    );
  });

  it("only takes over a LIMITED grant when the chosen set is empty", () => {
    expect(
      photoAccessTakesOverTimeline({
        ...base,
        state: "limited",
        deviceReadableCount: 12,
      })
    ).toBe(false);
    expect(photoAccessTakesOverTimeline({ ...base, state: "limited" })).toBe(
      true
    );
  });

  it("never hides vault photographs behind a device-grant panel", () => {
    for (const state of ["denied", "undetermined", "limited"] as const)
      expect(
        photoAccessTakesOverTimeline({
          ...base,
          state,
          vaultReadableCount: 18,
        })
      ).toBe(false);
    expect(
      photoAccessTakesOverTimeline({
        ...base,
        state: "denied",
        vaultReadableCount: 0,
      })
    ).toBe(true);
  });

  it("declines while the answer is unknown or the walk is still running", () => {
    expect(photoAccessTakesOverTimeline({ ...base, state: null })).toBe(false);
    expect(
      photoAccessTakesOverTimeline({
        ...base,
        state: "denied",
        loading: true,
      })
    ).toBe(false);
  });
});
