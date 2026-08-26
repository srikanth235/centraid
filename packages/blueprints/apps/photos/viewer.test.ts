// @vitest-environment jsdom
// (viewer.ts reaches the kit through format.ts, and the kit's custom-element
// base extends HTMLElement at module scope — a DOM has to exist to import it.)
//
// The editor's meta line has to be true about lineage, not decorative
// (#711). An edited copy is dated the day it was SAVED, so the only
// thing that can honestly place it in time is its recorded source — and when
// there is no source, or the source is not loaded, the line must say so
// rather than reading a save date back as a capture date.
import { describe, expect, test } from "vitest";

import type { Asset } from "./types.ts";
import { editorSourceLine, originParagraph } from "./viewer.ts";

function asset(fields: Partial<Asset> & { asset_id: string }): Asset {
  return fields as Asset;
}

describe(editorSourceLine, () => {
  test("an original names the day it was taken, claiming no source", () => {
    const line = editorSourceLine(
      asset({ asset_id: "a1", captured_at: "2026-03-04T09:00:00Z" })
    );
    expect(line).toMatch(/^from a photograph taken /u);
    expect(line).not.toContain("edit");
  });

  test("an original with no capture time says nothing about when", () => {
    expect(editorSourceLine(asset({ asset_id: "a1" }))).toBe(
      "from a photograph in this library"
    );
  });

  test("an edited copy names its source's capture day, not its own save day", () => {
    const original = asset({
      asset_id: "a1",
      captured_at: "2026-03-04T09:00:00Z",
    });
    const edited = asset({
      asset_id: "a2",
      source_asset_id: "a1",
      captured_at: "2026-08-05T12:00:00Z",
    });
    const line = editorSourceLine(edited, original);
    expect(line).toContain("from an edit of a photograph taken ");
    // The save date must not surface as if the shutter fired that day.
    expect(line).not.toContain("August");
    expect(line).toContain(
      new Date("2026-03-04T09:00:00Z").toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    );
  });

  test("an edited copy whose source is not loaded still says it is an edit", () => {
    const edited = asset({
      asset_id: "a2",
      source_asset_id: "a1",
      captured_at: "2026-08-05T12:00:00Z",
    });
    expect(editorSourceLine(edited, null)).toBe(
      "from an edit of another photograph in this library"
    );
  });

  test("a source row that is not the recorded source is not trusted", () => {
    const edited = asset({
      asset_id: "a2",
      source_asset_id: "a1",
      captured_at: "2026-08-05T12:00:00Z",
    });
    const wrong = asset({
      asset_id: "a9",
      captured_at: "2020-01-01T00:00:00Z",
    });
    expect(editorSourceLine(edited, wrong)).toBe(
      "from an edit of another photograph in this library"
    );
  });
});

// PER-COPY PROVENANCE (#712). The panel's one prose sentence about
// where the original lives gives each custody state its own answer. A trailing
// `return` catching three different worlds — `local-only`, `pending-offsite`,
// and NO custody row at all — is the defect pinned here: with the gateway's
// blob sweep not yet run there is no fact to report, and the panel must not
// assert a location anyway.
describe(originParagraph, () => {
  const GATEWAY = "the gateway";

  test("each custody state gets its own sentence", () => {
    const said = new Set(
      (
        [
          "replicated",
          "remote-only",
          "missing",
          "pending-offsite",
          "local-only",
        ] as const
      ).map((state) =>
        originParagraph(
          asset({ asset_id: "a1", custody_state: state }),
          GATEWAY
        )
      )
    );
    expect(said.size).toBe(5);
  });

  test("a queued copy is not reported as a copy", () => {
    const pending = originParagraph(
      asset({ asset_id: "a1", custody_state: "pending-offsite" }),
      GATEWAY
    );
    expect(pending).toContain("queued");
    expect(pending).toContain("on this device only");
  });

  test("no custody row claims no location", () => {
    const unknown = originParagraph(asset({ asset_id: "a1" }), GATEWAY);
    expect(unknown).toContain("has not been checked yet");
    // The bug guarded: the absent-row case borrowing local-only's sentence.
    expect(unknown).not.toContain("The original is on this device");
  });
});
