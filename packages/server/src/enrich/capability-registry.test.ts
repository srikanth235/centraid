// The capability registry (issue #807) — that the contracts cover what this
// build actually ships, and that the output-schema ids obey the one
// version-identity convention the vault already owns.

import { describe, expect, test } from "vitest";

import { parseModelId } from "@centraid/vault";

import {
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
      "transcript",
    ]);
  });

  test("every output schema parses as <name>@<version>", () => {
    // The convention is model-id.ts's, not a second one invented here — a
    // consumer pinned to `ocr@1` compares versions with the same helpers.
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
    ]);
    expect(capabilitiesForDomain("docs")).toHaveLength(5);
  });

  test("lookup by id and by implementing template agree", () => {
    const ocr = capabilityContract("ocr");
    expect(ocr?.input).toBe("image");
    expect(capabilityForTemplateId("photo-ocr")).toBe(ocr);
    expect(ocr && capabilityDefaultRef(ocr)).toBe("photo-ocr/photo-ocr");
  });

  test("an unknown id is never a default", () => {
    expect(capabilityContract("captions")).toBeUndefined();
    expect(isEnrichCapability("captions")).toBe(false);
    expect(isEnrichCapability("ocr")).toBe(true);
  });
});
