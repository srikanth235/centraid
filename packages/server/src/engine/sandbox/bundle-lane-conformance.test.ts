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
  automationHandlerPolicy,
  builtinDecision,
  mediaTranscodePolicy,
  modelRuntimePolicy,
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
