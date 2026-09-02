/*
 * The system recognition lane, `place-names` included (#816).
 *
 * This list is small and load-bearing in three different places, and one of them
 * is easy to get backwards: membership here is what makes the scheduler reconcile
 * honour a recipe's `enabled` bit instead of the experimental-automations gate
 * (`serve/build-gateway.ts`). An off-by-default recipe therefore BELONGS here —
 * leaving it out would make it an ordinary automation that only arms when the
 * experimental gate is on, which is a different product promise than "opt-in".
 * The assertions below pin that reading against the shipped manifests.
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

function manifestOf(id: string): { enabled?: boolean } {
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
  ) as { enabled?: boolean };
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

  it("place-names ships disabled, which is what makes it opt-in", () => {
    // The reconcile in build-gateway.ts filters these rows on `row.enabled`, so this one bit is the whole opt-in mechanism: no scheduler registration and no data cursor until a member turns it on.
    expect(manifestOf("place-names").enabled).toBe(false);
  });
});
