import { describe, expect, it } from "vitest";

import {
  errorText,
  moduleAvailability,
  unwrapPopupEnvelope,
} from "./popup-core.js";
import type { ModuleStatus } from "./types.js";

describe(errorText, () => {
  it("prefers Error.message and stringifies otherwise", () => {
    expect(errorText(new Error("nope"))).toBe("nope");
    expect(errorText("string-err")).toBe("string-err");
    expect(errorText(12)).toBe("12");
  });
});

describe(moduleAvailability, () => {
  it("enables only granted modules and toggles agenda/people visibility", () => {
    const modules: ModuleStatus[] = [
      { id: "tasks", name: "Tasks", state: "granted" },
      { id: "notes", name: "Notes", state: "paused" },
      { id: "agenda", name: "Agenda", state: "granted" },
      { id: "people", name: "People", state: "revoked" },
    ];
    const avail = moduleAvailability(modules);
    expect(avail.enabled.has("tasks")).toBe(true);
    expect(avail.enabled.has("notes")).toBe(false);
    expect(avail.agendaVisible).toBe(true);
    expect(avail.peopleVisible).toBe(false);
  });
});

describe(unwrapPopupEnvelope, () => {
  it("returns value or throws with a stable fallback message", () => {
    expect(
      unwrapPopupEnvelope({ ok: true, value: { paired: true } })
    ).toStrictEqual({
      paired: true,
    });
    expect(() => unwrapPopupEnvelope({ ok: false, error: "locked" })).toThrow(
      "locked"
    );
    expect(() => unwrapPopupEnvelope(undefined)).toThrow("Request failed.");
  });
});
