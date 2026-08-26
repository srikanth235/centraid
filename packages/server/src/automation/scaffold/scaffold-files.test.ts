import { describe, expect, it } from "vitest";

import type { ScaffoldFile } from "@centraid/blueprints";

import { lintHandlerSource } from "../handler/lint.js";
import {
  scaffoldAppFiles,
  setEnabledInFiles,
  deleteFromFiles,
} from "./scaffold.js";

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe(scaffoldAppFiles, () => {
  it("emits app.json + manifest + handler under the derived automation id", () => {
    const out = byPath(
      scaffoldAppFiles("briefing", { name: "Briefing", cronExpr: "0 8 * * *" })
    );
    expect(out.has("app.json")).toBeTruthy();
    // The app.json marks itself an automation app via `kind` (not a dotted id).
    expect((JSON.parse(out.get("app.json")!) as { kind?: string }).kind).toBe(
      "automation"
    );
    expect(out.has("automations/briefing/automation.json")).toBeTruthy();
    expect(out.has("automations/briefing/handler.js")).toBeTruthy();
    const mf = JSON.parse(out.get("automations/briefing/automation.json")!) as {
      enabled: boolean;
      triggers: { kind: string; expr: string }[];
    };
    expect(mf.enabled).toBe(true);
    expect(mf.triggers).toStrictEqual([{ kind: "cron", expr: "0 8 * * *" }]);
  });

  it("rejects a dotted / path-unsafe app id", () => {
    expect(() => scaffoldAppFiles("auto.briefing")).toThrow(
      /Invalid automation app id/u
    );
  });

  it("emits a replay-safe default handler (passes the determinism lint)", () => {
    const out = byPath(scaffoldAppFiles("briefing"));
    expect(
      lintHandlerSource(out.get("automations/briefing/handler.js")!)
    ).toStrictEqual([]);
  });

  it("accepts a condition/data trigger paired with a vault block", () => {
    const vault = {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "core", table: "invoice", verbs: "read" as const }],
    };
    const out = byPath(
      scaffoldAppFiles("watcher", {
        triggers: [
          { kind: "data", entities: ["core.invoice"], every: "*/10 * * * *" },
        ],
        vault,
      })
    );
    const mf = JSON.parse(out.get("automations/watcher/automation.json")!) as {
      triggers: { kind: string; entities?: string[]; every?: string }[];
      vault?: { purpose: string };
    };
    expect(mf.triggers).toStrictEqual([
      { kind: "data", entities: ["core.invoice"], every: "*/10 * * * *" },
    ]);
    expect(mf.vault?.purpose).toBe("dpv:ServiceProvision");
  });

  it("rejects a condition/data trigger with no vault block", () => {
    expect(() =>
      scaffoldAppFiles("watcher2", {
        triggers: [{ kind: "condition", entity: "core.invoice" }],
      })
    ).toThrow(/manifest\.vault block/u);
  });

  it("emits an empty requires slot (harness/model only when given, no tools rail)", () => {
    const plain = byPath(scaffoldAppFiles("briefing"));
    const reqs = (
      JSON.parse(plain.get("automations/briefing/automation.json")!) as {
        requires: { tools?: unknown; harness?: unknown; model?: unknown };
      }
    ).requires;
    // No tools allowlist is scaffolded — there is no `ctx.tool` rail (#484).
    expect(reqs.tools).toBeUndefined();
    expect(reqs.harness).toBeUndefined();
    expect(reqs.model).toBeUndefined();

    const withModel = byPath(
      scaffoldAppFiles("briefing", {
        harness: "claude-code",
        model: "anthropic/x",
      })
    );
    const reqs2 = (
      JSON.parse(withModel.get("automations/briefing/automation.json")!) as {
        requires: { harness?: unknown; model?: unknown };
      }
    ).requires;
    expect(reqs2.harness).toBe("claude-code");
    expect(reqs2.model).toBe("anthropic/x");
  });
});

describe("setEnabledInFiles / deleteFromFiles", () => {
  const draft = (): ScaffoldFile[] =>
    scaffoldAppFiles("briefing", { name: "Briefing", enabled: true });

  it("flips enabled and returns only the changed manifest", () => {
    const changed = setEnabledInFiles(draft(), "briefing", false);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.path).toBe("automations/briefing/automation.json");
    expect(
      (JSON.parse(changed[0]!.content) as { enabled: boolean }).enabled
    ).toBe(false);
  });

  it("no-ops when already at the requested state or absent", () => {
    expect(setEnabledInFiles(draft(), "briefing", true)).toStrictEqual([]);
    expect(setEnabledInFiles(draft(), "nope", false)).toStrictEqual([]);
  });

  it("removes every file under the automation subdir", () => {
    const { keep, removed } = deleteFromFiles(draft(), "briefing");
    expect(removed.sort()).toStrictEqual([
      "automations/briefing/automation.json",
      "automations/briefing/handler.js",
    ]);
    expect(keep.map((f) => f.path)).toStrictEqual(["app.json"]);
  });
});
