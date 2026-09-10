/*
 * Which lane every SHIPPED bundle could run under (#846). The worker installs
 * the strict floor unconditionally, so a bundle that grows a builtin without
 * declaring its lane breaks on first fire; this suite moves that to commit
 * time, measured on the BUILT artifact the loader hook actually rules on.
 * Every lane refuses `node:module`: a `createRequire` resolves through Node's
 * own loader and skips the hooks. Nothing here proves the native ONNX runtime.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  SYSTEM_AUTOMATION_IDS,
  BUNDLED_OPTIONAL_AUTOMATION_IDS,
} from "../../enrich/system-recognition.ts";
import {
  automationHandlerPolicy,
  builtinDecision,
  mediaTranscodePolicy,
  modelRuntimePolicy,
  systemAutomationPolicy,
} from "./policy.ts";

const AUTOMATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../../blueprints/automations"
);

const RECOGNITION = new Set([
  "photo-ocr",
  "embed-image",
  "embed-text",
  "faces",
]);

const SHELLS_OUT = new Set(["transcript"]);

/** Provenance, read from the ONE constant that decides it. */
const SYSTEM = new Set<string>(SYSTEM_AUTOMATION_IDS);

interface Bundle {
  readonly id: string;
  readonly builtins: readonly string[];
  /** `manifest.sandbox.lane`, or undefined for the strict floor. */
  readonly declared: "model-runtime" | "media-transcode" | undefined;
}

function bundles(): Bundle[] {
  return readdirSync(AUTOMATIONS_DIR)
    .sort()
    .flatMap((id) => {
      const file = path.join(
        AUTOMATIONS_DIR,
        id,
        "automations",
        id,
        "handler.js"
      );
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return [];
      }
      const builtins = [
        ...new Set(
          [...text.matchAll(/["']node:(?<id>[a-z_]+(?:\/[a-z]+)?)["']/gu)].map(
            (match) => match.groups!["id"]!
          )
        ),
      ].sort();
      let declared: Bundle["declared"];
      try {
        const manifest = JSON.parse(
          readFileSync(
            path.join(
              AUTOMATIONS_DIR,
              id,
              "automations",
              id,
              "automation.json"
            ),
            "utf8"
          )
        ) as { sandbox?: { lane?: Bundle["declared"] } };
        declared = manifest.sandbox?.lane;
      } catch {
        declared = undefined;
      }
      return [{ id, builtins, declared }];
    });
}

const ALL = bundles();

function refusals(
  bundle: Bundle,
  policy: ReturnType<typeof automationHandlerPolicy>
): string[] {
  return bundle.builtins.filter(
    (id) => builtinDecision(policy, id).kind === "deny"
  );
}

function declaredPolicy(
  bundle: Bundle
): ReturnType<typeof automationHandlerPolicy> {
  if (bundle.declared === "model-runtime")
    return modelRuntimePolicy(["/roots"]);
  if (bundle.declared === "media-transcode")
    return mediaTranscodePolicy(["/roots"]);
  return automationHandlerPolicy();
}

describe("shipped automation bundles against the sandbox lanes", () => {
  test("the corpus is the real one, not an empty scan", () => {
    expect(ALL.length).toBeGreaterThan(20);
    for (const id of [...RECOGNITION, ...SHELLS_OUT])
      expect(ALL.map((bundle) => bundle.id)).toContain(id);
  });

  test("no shipped bundle imports node:module any more (#846 P9)", () => {
    const offenders = ALL.filter((bundle) =>
      bundle.builtins.includes("module")
    ).map((bundle) => bundle.id);
    expect(offenders).toStrictEqual([]);
  });

  test("every non-recognition bundle is admitted by the automation-handler lane", () => {
    const policy = automationHandlerPolicy();
    const blocked = ALL.filter(
      (bundle) => !RECOGNITION.has(bundle.id) && !SHELLS_OUT.has(bundle.id)
    )
      .map((bundle) => ({ id: bundle.id, denied: refusals(bundle, policy) }))
      .filter((entry) => entry.denied.length > 0);
    expect(blocked).toStrictEqual([]);
  });

  test("every ONNX recognition bundle declares, and is admitted by, the model-runtime lane", () => {
    for (const bundle of ALL.filter((entry) => RECOGNITION.has(entry.id)))
      expect(bundle.declared).toBe("model-runtime");
    const policy = modelRuntimePolicy(["/models"]);
    const blocked = ALL.filter((bundle) => RECOGNITION.has(bundle.id))
      .map((bundle) => ({ id: bundle.id, denied: refusals(bundle, policy) }))
      .filter((entry) => entry.denied.length > 0);
    expect(blocked).toStrictEqual([]);
    // …and they really do reach for it, so the confinement is not vacuous.
    for (const bundle of ALL.filter((entry) => RECOGNITION.has(entry.id)))
      expect(bundle.builtins).toContain("fs");
  });

  test("every bundle is admitted by the lane its own manifest declares", () => {
    const blocked = ALL.map((bundle) => ({
      id: bundle.id,
      declared: bundle.declared ?? "automation-handler (floor)",
      denied: refusals(bundle, declaredPolicy(bundle)),
    })).filter((entry) => entry.denied.length > 0);
    expect(blocked).toStrictEqual([]);
  });

  test("no bundle declares a lane wider than it needs", () => {
    // The grants are holes: an unneeded one is a hole for nothing.
    const overreaching = ALL.filter(
      (bundle) =>
        bundle.declared !== undefined &&
        refusals(bundle, automationHandlerPolicy()).length === 0
    ).map((bundle) => bundle.id);
    expect(overreaching).toStrictEqual([]);

    const needlessSubprocess = ALL.filter(
      (bundle) =>
        bundle.declared === "media-transcode" &&
        refusals(bundle, modelRuntimePolicy(["/roots"])).length === 0
    ).map((bundle) => bundle.id);
    expect(needlessSubprocess).toStrictEqual([]);
  });

  test("the system tier is exactly the constant, and nothing declares its lane", () => {
    // Provenance is a repo constant, never a manifest field: the parser accepts
    // only `model-runtime` / `media-transcode` under `sandbox.lane`, so no
    // bundle — bundled-optional or a future code-store one — can ask for the
    // system lane. Widening this set is a deliberate edit to that constant.
    expect([...SYSTEM].sort()).toStrictEqual(
      ["doc-text-extractor", "faces", "photo-ocr"].sort()
    );
    expect(
      [...SYSTEM].some((id) =>
        BUNDLED_OPTIONAL_AUTOMATION_IDS.includes(id as never)
      )
    ).toBe(false);
    const declaringSystem = ALL.filter(
      (bundle) => (bundle.declared as string | undefined) === "system"
    ).map((bundle) => bundle.id);
    expect(declaringSystem).toStrictEqual([]);
  });

  test("the same require is admitted in the system lane and refused in model-runtime", () => {
    // The whole change is WHICH CODE IS ROUTED WHERE. `node:child_process` is
    // what `sharp` reaches for through `detect-libc` at load; the system lane
    // takes it because first-party release code runs with the gateway's own
    // authority, and the model-runtime lane still refuses it, so the boundary
    // for bundled-optional and future external code is demonstrably unmoved.
    expect(
      builtinDecision(systemAutomationPolicy(), "child_process")
    ).toStrictEqual({
      kind: "allow",
    });
    const refused = builtinDecision(
      modelRuntimePolicy(["/models"]),
      "child_process"
    );
    expect(refused.kind).toBe("deny");
    expect(refused.kind === "deny" ? refused.reason : "").toContain(
      'lane "model-runtime"'
    );
    // …and the floor is unmoved too.
    expect(
      builtinDecision(automationHandlerPolicy(), "child_process").kind
    ).toBe("deny");
  });

  test("every non-system bundle conforms exactly as it did before", () => {
    // The optional tier is measured against the lane its own manifest declares,
    // with no system-tier exemption anywhere in the calculation.
    const blocked = ALL.filter((bundle) => !SYSTEM.has(bundle.id))
      .map((bundle) => ({
        id: bundle.id,
        declared: bundle.declared ?? "automation-handler (floor)",
        denied: refusals(bundle, declaredPolicy(bundle)),
      }))
      .filter((entry) => entry.denied.length > 0);
    expect(blocked).toStrictEqual([]);
  });

  test("transcript is the ONE bundle that needs a subprocess, and it declares it", () => {
    // Asserted, not tolerated: a second one shelling out is a deliberate change.
    const needsSubprocess = ALL.filter(
      (bundle) =>
        refusals(bundle, automationHandlerPolicy()).length > 0 &&
        refusals(bundle, modelRuntimePolicy(["/models"])).length > 0
    ).map((bundle) => bundle.id);
    expect(needsSubprocess).toStrictEqual(["transcript"]);

    const transcript = ALL.find((bundle) => bundle.id === "transcript")!;
    expect(refusals(transcript, modelRuntimePolicy(["/models"]))).toStrictEqual(
      ["child_process"]
    );
    expect(transcript.declared).toBe("media-transcode");
    expect(
      refusals(transcript, mediaTranscodePolicy(["/models"]))
    ).toStrictEqual([]);
  });
});
