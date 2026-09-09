/*
 * The system recognition lane, `place-names` included (#816).
 *
 * This list is small and load-bearing in three different places, and one of them
 * is easy to get backwards: membership here is what makes the scheduler reconcile
 * honour a recipe's `enabled` bit instead of the experimental-automations gate
 * (`serve/build-gateway.ts`). Since the 2026-09-09 ruling every listed recipe
 * ships ON, so that filter is the OPT-OUT: turning one off is what drops its
 * scheduler registration and its data cursor. The assertions below pin that
 * reading against the shipped manifests.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SYSTEM_CAPTURE_OCR_REF,
  SYSTEM_RECOGNITION_REFS,
  SYSTEM_RECOGNITION_TEMPLATE_IDS,
  isSystemRecognitionRef,
} from "./system-recognition.js";

const require = createRequire(import.meta.url);
const BLUEPRINTS_ROOT = path.dirname(
  require.resolve("@centraid/blueprints/package.json")
);

function manifestOf(id: string): {
  enabled?: boolean;
  triggers?: unknown[];
} {
  return JSON.parse(
    readFileSync(
      path.join(
        BLUEPRINTS_ROOT,
        "automations",
        id,
        "automations",
        id,
        "automation.json"
      ),
      "utf8"
    )
  ) as { enabled?: boolean; triggers?: unknown[] };
}

describe("system recognition lane", () => {
  it("names exactly the bundled recognition recipes", () => {
    expect([...SYSTEM_RECOGNITION_TEMPLATE_IDS]).toStrictEqual([
      "photo-ocr",
      "transcript",
      "embed-image",
      "embed-text",
      "faces",
      "place-names",
    ]);
  });

  it("builds one ref per recipe, both halves the same id", () => {
    expect([...SYSTEM_RECOGNITION_REFS]).toStrictEqual(
      SYSTEM_RECOGNITION_TEMPLATE_IDS.map((id) => `${id}/${id}`)
    );
    expect(isSystemRecognitionRef("place-names/place-names")).toBe(true);
    expect(isSystemRecognitionRef("place-names")).toBe(false);
    expect(isSystemRecognitionRef(undefined)).toBe(false);
    expect(SYSTEM_RECOGNITION_REFS).toContain(SYSTEM_CAPTURE_OCR_REF);
  });

  it("every listed recipe ships a manifest at the ref it claims", () => {
    for (const id of SYSTEM_RECOGNITION_TEMPLATE_IDS) {
      expect(() => manifestOf(id), id).not.toThrow();
    }
  });

  it.each([...SYSTEM_RECOGNITION_TEMPLATE_IDS])(
    "%s ships enabled, so a fresh vault recognizes on ingest",
    (id) => {
      // Ruled 2026-09-09: every bundled recognition recipe is on by default,
      // `faces` included. The reconcile in build-gateway.ts filters these rows
      // on `row.enabled`, so that bit is now the whole OPT-OUT mechanism — a
      // recipe a member switches off holds no scheduler registration and
      // bootstraps no data cursor.
      expect(manifestOf(id).enabled).toBe(true);
    }
  );

  it("faces fires on media ingest, not only on its request queue", () => {
    // The queue is still the PRIORITY lane inside the handler; the trigger is
    // what makes the ambient library reachable at all.
    expect(manifestOf("faces").triggers).toStrictEqual([
      { kind: "data", entities: ["media.asset"], every: "*/5 * * * *" },
    ]);
  });
});
