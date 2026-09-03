import { describe, expect, test } from "vitest";

import { parseModelId } from "@centraid/vault";

import {
  CAPABILITY_INPUT_KINDS,
  ENRICH_CAPABILITIES,
  ENRICH_CAPABILITY_IDS,
  capabilitiesForDomain,
  capabilityContract,
  capabilityDefaultRef,
  capabilityForTemplateId,
  capabilityOutputVersion,
  isEnrichCapability,
} from "./capability-registry.js";

describe("capability registry", () => {
  test("covers every capability the bundled automations declare", () => {
    expect([...ENRICH_CAPABILITY_IDS].sort()).toStrictEqual([
      "doc-entities",
      "doc-filing",
      "doc-text",
      "embed-image",
      "embed-text",
      "faces",
      "obligations",
      "ocr",
      "place-names",
      "transcript",
    ]);
  });

  test("every output schema parses as <name>@<version>", () => {
    for (const contract of ENRICH_CAPABILITIES) {
      expect(
        parseModelId(contract.outputSchema),
        `${contract.id} output schema ${contract.outputSchema}`
      ).not.toBeNull();
      expect(capabilityOutputVersion(contract)).toBe(1);
    }
  });

  test("ids and default implementations are each unique", () => {
    expect(new Set(ENRICH_CAPABILITY_IDS).size).toBe(
      ENRICH_CAPABILITIES.length
    );
    expect(
      new Set(ENRICH_CAPABILITIES.map((cap) => cap.defaultTemplateId)).size
    ).toBe(ENRICH_CAPABILITIES.length);
  });

  test("the domain union stays closed at photos | docs", () => {
    expect(new Set(ENRICH_CAPABILITIES.map((cap) => cap.domain))).toStrictEqual(
      new Set(["photos", "docs"])
    );
    expect(capabilitiesForDomain("photos").map((cap) => cap.id)).toStrictEqual([
      "ocr",
      "faces",
      "embed-image",
      "transcript",
      "place-names",
    ]);
    expect(capabilitiesForDomain("docs")).toHaveLength(5);
  });

  test("lookup by id and by implementing template agree", () => {
    const ocr = capabilityContract("ocr");
    expect(ocr?.input).toBe("image");
    expect(capabilityForTemplateId("photo-ocr")).toBe(ocr);
    expect(ocr && capabilityDefaultRef(ocr)).toBe("photo-ocr/photo-ocr");
  });

  test("a coordinate is its own input kind", () => {
    expect(CAPABILITY_INPUT_KINDS).toContain("coordinate");
    const places = capabilityContract("place-names");
    expect(places?.input).toBe("coordinate");
    expect(places?.domain).toBe("photos");
    expect(places?.outputSchema).toBe("place-names@1");
    expect(places && capabilityDefaultRef(places)).toBe(
      "place-names/place-names"
    );
  });

  test("naming a coordinate is never delegated to anyone", () => {
    expect(capabilityContract("place-names")?.delegateCapable).toBe(false);
  });

  test("every contract's input kind is one the union declares", () => {
    for (const contract of ENRICH_CAPABILITIES) {
      expect(CAPABILITY_INPUT_KINDS, contract.id).toContain(contract.input);
    }
  });

  test("an unknown id is never a default", () => {
    expect(capabilityContract("captions")).toBeUndefined();
    expect(isEnrichCapability("captions")).toBe(false);
    expect(isEnrichCapability("ocr")).toBe(true);
  });
});
