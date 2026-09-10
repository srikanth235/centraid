/*
 * The provenance tiers (#1011).
 *
 * Two lists, and which list an id is on decides three things nothing else may
 * decide: which sandbox lane its handler runs in (`automation/fire/fire.ts`),
 * whether the scheduler arms it from the catalogue or from a per-vault
 * `enabled` bit (`serve/build-gateway.ts`), and whether an unwritten enrichment
 * policy refuses it or runs it on-device (`automation/fire/enrich-gate.ts`).
 * The assertions below pin both lists against the shipped manifests.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUNDLED_OPTIONAL_AUTOMATION_IDS,
  SYSTEM_AUTOMATION_IDS,
  SYSTEM_AUTOMATION_REFS,
  SYSTEM_CAPTURE_OCR_REF,
  SYSTEM_RECOGNITION_REFS,
  SYSTEM_RECOGNITION_TEMPLATE_IDS,
  isSystemAutomationId,
  isSystemAutomationRef,
  isSystemRecognitionRef,
} from "./system-recognition.js";

const require = createRequire(import.meta.url);
const BLUEPRINTS_ROOT = path.dirname(
  require.resolve("@centraid/blueprints/package.json")
);

function manifestOf(id: string): {
  enabled?: boolean;
  triggers?: unknown[];
  sandbox?: { lane?: string };
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
  ) as { enabled?: boolean; triggers?: unknown[]; sandbox?: { lane?: string } };
}

describe("bundled automation provenance tiers", () => {
  it("names the system tier and the bundled-optional tier, disjointly", () => {
    expect([...SYSTEM_AUTOMATION_IDS]).toStrictEqual([
      "faces",
      "photo-ocr",
      "doc-text-extractor",
    ]);
    expect([...BUNDLED_OPTIONAL_AUTOMATION_IDS]).toStrictEqual([
      "embed-image",
      "embed-text",
      "transcript",
      "place-names",
    ]);
    const overlap = SYSTEM_AUTOMATION_IDS.filter((id) =>
      (BUNDLED_OPTIONAL_AUTOMATION_IDS as readonly string[]).includes(id)
    );
    expect(overlap).toStrictEqual([]);
  });

  it("reserves every bundled id, either tier", () => {
    expect([...SYSTEM_RECOGNITION_TEMPLATE_IDS]).toStrictEqual([
      ...SYSTEM_AUTOMATION_IDS,
      ...BUNDLED_OPTIONAL_AUTOMATION_IDS,
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

  it("the system predicate answers for the system tier alone", () => {
    expect([...SYSTEM_AUTOMATION_REFS]).toStrictEqual([
      "faces/faces",
      "photo-ocr/photo-ocr",
      "doc-text-extractor/doc-text-extractor",
    ]);
    expect(isSystemAutomationRef("faces/faces")).toBe(true);
    // Bundled, reserved, rendered as owner-controlled — and NOT system: it
    // keeps its `enabled` bit and its sandbox lane.
    expect(isSystemRecognitionRef("transcript/transcript")).toBe(true);
    expect(isSystemAutomationRef("transcript/transcript")).toBe(false);
    expect(isSystemAutomationRef("faces")).toBe(false);
    expect(isSystemAutomationRef(undefined)).toBe(false);
    expect(isSystemAutomationId("photo-ocr")).toBe(true);
    expect(isSystemAutomationId("embed-image")).toBe(false);
    expect(isSystemAutomationId(undefined)).toBe(false);
  });

  it("every listed recipe ships a manifest at the ref it claims", () => {
    for (const id of SYSTEM_RECOGNITION_TEMPLATE_IDS) {
      expect(() => manifestOf(id), id).not.toThrow();
    }
  });

  it.each([...SYSTEM_AUTOMATION_IDS])(
    "%s ships enabled — a system automation is on by provenance",
    (id) => {
      expect(manifestOf(id).enabled).toBe(true);
    }
  );

  it.each([...BUNDLED_OPTIONAL_AUTOMATION_IDS])(
    "%s ships disabled — bundled, but the member's own ask",
    (id) => {
      expect(manifestOf(id).enabled).toBe(false);
    }
  );

  it("no manifest declares the system lane; it is routed by provenance", () => {
    for (const id of SYSTEM_RECOGNITION_TEMPLATE_IDS)
      expect(manifestOf(id).sandbox?.lane, id).not.toBe("system");
  });

  it("faces fires on media ingest, not only on its request queue", () => {
    // The queue is still the PRIORITY lane inside the handler; the trigger is
    // what makes the ambient library reachable at all.
    expect(manifestOf("faces").triggers).toStrictEqual([
      { kind: "data", entities: ["media.asset"], every: "*/5 * * * *" },
    ]);
  });
});
