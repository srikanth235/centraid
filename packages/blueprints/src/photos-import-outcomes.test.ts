import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface ImportResult {
  added: number;
  deduped: number;
  restored: number;
}

const { tallyDedupes, ImportPanels } = (await import(
  app("components/Import.tsx")
)) as {
  tallyDedupes: (
    dedupedAssetIds: readonly string[],
    wasTrashed: (assetId: string) => boolean
  ) => { deduped: number; restored: number };
  ImportPanels: ComponentType<Record<string, unknown>>;
};

const NOOP = () => {};

function render(result: ImportResult): string {
  return renderToStaticMarkup(
    createElement(ImportPanels, { result, onDismiss: NOOP })
  );
}

describe("tallyDedupes", () => {
  it("splits the run's dedupes by what the trash held before it", () => {
    const trashed = new Set(["a", "c"]);
    expect(
      tallyDedupes(["a", "b", "c", "d"], (id) => trashed.has(id))
    ).toStrictEqual({ deduped: 2, restored: 2 });
  });

  it("counts nothing when the run deduped nothing", () => {
    expect(tallyDedupes([], () => true)).toStrictEqual({
      deduped: 0,
      restored: 0,
    });
  });

  it("counts every dedupe as already-here when the trash was empty", () => {
    expect(tallyDedupes(["a", "b"], () => false)).toStrictEqual({
      deduped: 2,
      restored: 0,
    });
  });

  it("never claims a restore for an id the command did not name", () => {
    expect(tallyDedupes(["", ""], () => true)).toStrictEqual({
      deduped: 2,
      restored: 0,
    });
  });
});

describe("ImportPanels", () => {
  it("explains only the outcome that actually happened", () => {
    const html = render({ added: 6, deduped: 4, restored: 0 });
    expect(html).toContain("Deduped");
    expect(html).toContain("4 of these were already here");
    expect(html).toContain("4 files matched photographs already here");
    expect(html).not.toContain("Restored");
  });

  it("draws both panels when the run did both", () => {
    const html = render({ added: 5, deduped: 4, restored: 1 });
    expect(html).toContain("1 of these you had deleted");
    expect(html).toContain("1 file matched something in the trash");
    expect(html).toContain("4 of these were already here");
  });

  it("says one, singular, when one file was already here", () => {
    const html = render({ added: 0, deduped: 1, restored: 0 });
    expect(html).toContain("1 of these was already here");
    expect(html).toContain("1 file matched photographs already here");
  });

  it("carries exactly one control, and it is the one that is backed", () => {
    const html = render({ added: 0, deduped: 4, restored: 0 });
    expect(html.match(/<button/gu)).toHaveLength(1);
    expect(html).toContain(">Dismiss</button>");
  });
});
// @vitest-environment jsdom
