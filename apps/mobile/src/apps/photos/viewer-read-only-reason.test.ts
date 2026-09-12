// The viewer's read-only reason (#711 item M). This package has no React
// Native render harness, so these assert by reading the component sources:
// `READ_ONLY_VAULT_REASON` is imported (never re-typed) everywhere the truth
// is stated, and reaches JSX as element children — not only as an
// `accessibilityHint` a sighted member never sees.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { READ_ONLY_SOURCE_REASON } from "../../kit/replica/row-provenance";
import {
  NOT_IN_A_VAULT_YET_REASON,
  READ_ONLY_VAULT_REASON,
  VIEWER_BOTTOM_ACTIONS,
  viewerWriteRefusal,
} from "./viewer-model";

const TOOLBAR_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "PhotoLightboxToolbar.tsx"),
  "utf8"
);
const LIGHTBOX_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "PhotoLightbox.tsx"),
  "utf8"
);
const CHROME_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "PhotoLightboxChrome.tsx"),
  "utf8"
);
const MENU_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "viewer-menu.ts"),
  "utf8"
);

describe("READ_ONLY_VAULT_REASON — one sentence for one truth", () => {
  it("names the vault AND what cannot be written into it — not a stub", () => {
    expect(READ_ONLY_VAULT_REASON).toBe(
      "This vault is read-only for you, so meaning cannot be written into it."
    );
  });

  it("IS the kit's one sentence since #880 — Docs, Tasks, Agenda and People say it too", () => {
    expect(READ_ONLY_VAULT_REASON).toBe(READ_ONLY_SOURCE_REASON);
  });

  it("reaches PhotoLightboxToolbar, PhotoLightbox and the overflow menu from viewer-model — never re-typed", () => {
    // Since the ladder moved into `viewerWriteRefusal`, the toolbar and the
    // menu read the sentence THROUGH it; the lightbox still names it directly
    // for the editor refusal. Either way the import is from `viewer-model`.
    expect(TOOLBAR_SRC).toMatch(
      /import\s*\{[^}]*viewerWriteRefusal[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
    expect(MENU_SRC).toMatch(
      /import\s*\{[^}]*viewerWriteRefusal[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
    expect(LIGHTBOX_SRC).toMatch(
      /import\s*\{[^}]*READ_ONLY_VAULT_REASON[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
    for (const src of [TOOLBAR_SRC, LIGHTBOX_SRC, MENU_SRC]) {
      expect(src).not.toContain(READ_ONLY_VAULT_REASON);
      expect(src).not.toContain(NOT_IN_A_VAULT_YET_REASON);
    }
  });

  it("leaves no trace of the two old, DIFFERENT stub strings", () => {
    expect(TOOLBAR_SRC).not.toMatch(
      /["']This vault is read-only["'](?!\s*for)/u
    );
    expect(LIGHTBOX_SRC).not.toMatch(
      /["']This vault is read-only for you, so meaning cannot be written into it\.["']/u
    );
  });
});

describe("the viewer bottom bar states the reason inline, never only in a hint (§6, §18)", () => {
  it("renders the refusal sentence as visible Text children, not only as accessibilityHint", () => {
    expect(TOOLBAR_SRC).toMatch(/<Text[^>]*>\s*\{refusal\}\s*<\/Text>/u);
  });

  it("still offers accessibilityHint too — belt and suspenders, not a replacement", () => {
    expect(TOOLBAR_SRC).toMatch(/\bhint=\{why\}/u);
    expect(CHROME_SRC).toMatch(
      /accessibilityHint=\{disabled \? hint : undefined\}/u
    );
  });

  it("keeps naming all five actions — the phone rearranges the viewer, it does not water it down", () => {
    expect(VIEWER_BOTTOM_ACTIONS).toHaveLength(5);
  });

  it("names every target even though the chip/capsule row draws no words", () => {
    expect(TOOLBAR_SRC).toMatch(
      /const label\s*=\s*id === ["']copy["'] && onSaveToMyVault\s*\?\s*["']Save to my vault["']\s*:\s*action\.label/u
    );
    expect(TOOLBAR_SRC).toMatch(/label=\{label\}/u);
    expect(CHROME_SRC).toMatch(/accessibilityLabel=\{label\}/u);
  });

  it("greys a refused target with the STAGE's soft ink, never the page's disabled ink", () => {
    // `--text-disabled` is mixed against paper: on the stage it reads as an
    // absent control, not a refused one.
    expect(CHROME_SRC).toMatch(/disabled\s*\?\s*colors\.onStageSoft/u);
    expect(CHROME_SRC).not.toMatch(/colors\.textDisabled/u);
  });
});

describe("a disabled viewer control's handler does not fire (§6, §18)", () => {
  it("guards onPress with the same `on` flag the target's `disabled` reads, not the handler alone", () => {
    expect(TOOLBAR_SRC).toMatch(/disabled=\{!on\}/u);
    expect(TOOLBAR_SRC).toMatch(
      /onPress=\{\(\) => \{\s*if \(!on\) return;\s*run\[id\]\(\);\s*\}\}/u
    );
  });
});

describe("the refusal ladder — a device row is not a read-only vault (#1011 M1)", () => {
  it("says nothing when the vault row is writable", () => {
    expect(
      viewerWriteRefusal({ writable: true, hasVaultAsset: true })
    ).toBeUndefined();
  });

  it("blames the vault only when the grant is read-only", () => {
    expect(viewerWriteRefusal({ writable: false, hasVaultAsset: true })).toBe(
      READ_ONLY_VAULT_REASON
    );
  });

  it("says the photograph is not in a vault yet for a device row the seat has not pulled", () => {
    expect(viewerWriteRefusal({ writable: true, hasVaultAsset: false })).toBe(
      NOT_IN_A_VAULT_YET_REASON
    );
  });

  // ORDER FLIPPED BY #1014 (R17). `canWrite` is a property of a VAULT row, so
  // for a photograph no vault holds yet it is false by absence, not by grant —
  // and the member was told to "ask its owner for write access" about their own
  // vault, which would take the write the moment the row arrived.
  it("says not-in-a-vault-yet, not read-only, when there is no vault row", () => {
    expect(viewerWriteRefusal({ writable: false, hasVaultAsset: false })).toBe(
      NOT_IN_A_VAULT_YET_REASON
    );
  });

  it("is the toolbar's OWN ladder: it feeds canWrite and the vault row separately", () => {
    expect(TOOLBAR_SRC).toMatch(
      /viewerWriteRefusal\(\{\s*writable: asset\.canWrite === true,\s*hasVaultAsset: Boolean\(asset\.assetId && asset\.sourceVaultId\),/u
    );
  });
});
