/*
 * Which lane every SHIPPED automation bundle could actually run under (#846 P9).
 *
 * The automation plane's default USED to be no lane at all, and the reason was
 * one builtin: the recognition bundles resolved `runtime/node_modules` through
 * `node:module`'s `createRequire`, which every lane here refuses — correctly,
 * since a `createRequire` in the graph resolves through Node's own loader and
 * skips the lane's hooks entirely. While that was true, no recognition
 * automation could run sandboxed, so nothing did.
 *
 * #846 P9 removed that dependency (`packages/model-runtime/src/onnx.ts` now
 * does its own entry resolution, pinned by `onnx.test.ts`) and the worker now
 * installs the strict floor unconditionally. This suite is what keeps that
 * safe, measured against the bundles the product actually executes rather than
 * against the source they are built from:
 *
 *   - every non-recognition bundle imports NO node builtin at all, so the
 *     `automation-handler` lane admits it as-is;
 *   - the four ONNX recognition bundles now import only `fs`, `fs/promises`,
 *     `path` and `url`, all admitted by the `model-runtime` lane;
 *   - `transcript` is the one bundle that still cannot run under any lane,
 *     because it shells out to ffmpeg through `node:child_process`. That is a
 *     product fact, not an oversight, and it is asserted here so it cannot
 *     quietly become two.
 *
 * The load-bearing assertion is "every bundle is admitted by the lane its own
 * manifest declares": with the floor unconditional, a bundle that grows a new
 * builtin without declaring the lane for it breaks on its first fire in
 * production, and this moves that failure to commit time.
 *
 * What this suite does NOT prove: that the native ONNX runtime loads and
 * infers correctly once inside the lane. `nativeAddons: true` means the addon
 * runs outside anything this policy constrains, and the runtime is installed
 * by `bun run --cwd packages/model-runtime setup` rather than by a root
 * install, so that half needs a machine with the runtime present. This is the
 * static half: no bundle is refused for a BUILTIN reason any more.
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

/** The ONNX recognition bundles — the ones that load model weights. */
const RECOGNITION = new Set([
  "photo-ocr",
  "embed-image",
  "embed-text",
  "faces",
]);

/** Ships a bundle that shells out to ffmpeg; see the header. */
const SHELLS_OUT = new Set(["transcript"]);

interface Bundle {
  readonly id: string;
  readonly builtins: readonly string[];
  /** `manifest.sandbox.lane`, or undefined for the strict floor. */
  readonly declared: "model-runtime" | "media-transcode" | undefined;
}

/**
 * Every committed bundle and the node builtins its text imports.
 *
 * A text scan, deliberately: the bundle is a single pre-built file with no
 * dynamic `require`, so its `node:` specifiers are exactly what the loader
 * hook will be asked to rule on. Reading the built artifact rather than the
 * source is the point — the built artifact is what the worker executes.
 */
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

/** Ids a lane refuses, with the reason, for one bundle. */
function refusals(
  bundle: Bundle,
  policy: ReturnType<typeof automationHandlerPolicy>
): string[] {
  return bundle.builtins.filter(
    (id) => builtinDecision(policy, id).kind === "deny"
  );
}

/** The policy a bundle actually runs under, given what its manifest declares. */
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
    // An empty or shrunken corpus would make every assertion below vacuous.
    expect(ALL.length).toBeGreaterThan(20);
    for (const id of [...RECOGNITION, ...SHELLS_OUT])
      expect(ALL.map((bundle) => bundle.id)).toContain(id);
  });

  test("no shipped bundle imports node:module any more (#846 P9)", () => {
    // The blocker itself. `createRequire` skips the loader hooks, so a lane
    // that admitted it would be a lane in name only — which is why every lane
    // refuses it, and why this had to leave the bundles rather than be
    // allowlisted into them.
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
    // …and they really do reach for the filesystem, so the lane's read
    // confinement is doing work rather than being satisfied vacuously.
    for (const bundle of ALL.filter((entry) => RECOGNITION.has(entry.id)))
      expect(bundle.builtins).toContain("fs");
  });

  test("every bundle is admitted by the lane its own manifest declares", () => {
    /*
     * The load-bearing one (#846 P9). Since the automation worker installs the
     * strict floor for a handler whose manifest declares nothing, a bundle that
     * grows a `node:fs` import without declaring `model-runtime` stops working
     * at RUN time, in production, on the first fire. This is that failure moved
     * to commit time, and it is checked against the built artifact rather than
     * the source, because the artifact is what the loader hook rules on.
     */
    const blocked = ALL.map((bundle) => ({
      id: bundle.id,
      declared: bundle.declared ?? "automation-handler (floor)",
      denied: refusals(bundle, declaredPolicy(bundle)),
    })).filter((entry) => entry.denied.length > 0);
    expect(blocked).toStrictEqual([]);
  });

  test("no bundle declares a lane wider than it needs", () => {
    // The grants are holes — an unneeded one is a hole for nothing. A bundle
    // that would run under the floor must not ask for a filesystem, and one
    // that would run under `model-runtime` must not ask for a subprocess.
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
    // Asserted rather than tolerated: the day a second bundle shells out, or
    // the day this one stops, that is a deliberate change to how much of the
    // automation plane can be sandboxed and it should be visible here.
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
