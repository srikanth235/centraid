// The viewer's read-only reason (v4 handoff §6, §18; issue #711 item M).
//
// Two defects closed here:
//
//   1. `PhotoLightboxToolbar` may not state the reason ONLY via
//      `accessibilityHint` — invisible to a sighted member, which is exactly
//      the tooltip pattern the handoff forbids ("a refusal reason must be
//      stated inline, never as a tooltip"). It also renders a visible
//      `<Text>` line under the bar, in `--net` mono.
//   2. `PhotoLightboxToolbar` and `PhotoLightbox` may not carry two DIFFERENT
//      strings for the same fact ("This vault is read-only" vs "This vault
//      is read-only for you, so meaning cannot be written into it."). Both
//      import the one `READ_ONLY_VAULT_REASON` from viewer-model.ts.
//
// There is no React Native render harness in this package (no
// react-test-renderer / @testing-library/react-native dependency — see
// every other *.test.ts under this app, which test pure logic, never JSX
// output), so this asserts the same properties a render would, by reading
// the component sources directly: the shared constant is referenced (not a
// re-typed literal) in both files, the old duplicate stub strings are gone,
// and the reason reaches JSX as element children — not only as a prop value
// a screen reader alone would announce.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { READ_ONLY_VAULT_REASON, VIEWER_BOTTOM_ACTIONS } from "./viewer-model";

const TOOLBAR_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "PhotoLightboxToolbar.tsx"),
  "utf8"
);
const LIGHTBOX_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "PhotoLightbox.tsx"),
  "utf8"
);
// The chip/capsule restyle (#712) moved the target itself into the chrome
// module, so the hint and the disabled INK now live there while the visible
// reason and the guard stay with the toolbar that owns the grant.
const CHROME_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "PhotoLightboxChrome.tsx"),
  "utf8"
);
// The `···` chip's anchored menu (#712) is a THIRD place this vault's
// read-only truth can be stated — its one writing row, Add to Album, has to
// import the same constant rather than re-typing a fourth phrasing of it.
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

  it("is what PhotoLightboxToolbar, PhotoLightbox and the overflow menu import — never re-typed", () => {
    expect(TOOLBAR_SRC).toMatch(
      /import\s*\{[^}]*READ_ONLY_VAULT_REASON[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
    expect(LIGHTBOX_SRC).toMatch(
      /import\s*\{[^}]*READ_ONLY_VAULT_REASON[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
    // The menu's one writing row (Add to Album) states the same truth when
    // the grant refuses it — see `viewer-menu.ts`'s own header for why it
    // rides in the row's label rather than a second visible line the kit's
    // `MenuActionRow` has no slot for.
    expect(MENU_SRC).toMatch(
      /import\s*\{[^}]*READ_ONLY_VAULT_REASON[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
  });

  it("leaves no trace of the two old, DIFFERENT stub strings", () => {
    // The toolbar's old stub — three call sites, one string, none of the
    // "so meaning cannot be written into it" context.
    expect(TOOLBAR_SRC).not.toMatch(
      /["']This vault is read-only["'](?!\s*for)/u
    );
    // The lightbox's old, longer-but-still-different stub — same fact, a
    // different sentence, so a member reading both would never know they
    // were the same truth.
    expect(LIGHTBOX_SRC).not.toMatch(
      /["']This vault is read-only for you, so meaning cannot be written into it\.["']/u
    );
  });
});

describe("the viewer bottom bar states the reason inline, never only in a hint (§6, §18)", () => {
  it("renders READ_ONLY_VAULT_REASON as visible Text children, not only as accessibilityHint", () => {
    // `accessibilityHint={on ? undefined : why}` is still there for a screen
    // reader landing directly on the disabled control — but the fix adds a
    // SEPARATE, always-rendered-when-read-only `<Text>` whose CHILDREN are
    // the reason, which is what a sighted member actually reads. Matching
    // the JSX children form (`>{READ_ONLY_VAULT_REASON}<`) rules out a
    // regression back to the hint-only pattern, where the identifier only
    // ever appears inside the `reason` lookup table, never between tags.
    expect(TOOLBAR_SRC).toMatch(
      /<Text[^>]*>\s*\{READ_ONLY_VAULT_REASON\}\s*<\/Text>/u
    );
  });

  it("still offers accessibilityHint too — belt and suspenders, not a replacement", () => {
    // The toolbar hands the reason down as `hint`; the chrome target is what
    // spends it on `accessibilityHint`, and only while the control is refused.
    expect(TOOLBAR_SRC).toMatch(/\bhint=\{why\}/u);
    expect(CHROME_SRC).toMatch(
      /accessibilityHint=\{disabled \? hint : undefined\}/u
    );
  });

  it("keeps naming all five actions — the phone rearranges the viewer, it does not water it down", () => {
    expect(VIEWER_BOTTOM_ACTIONS).toHaveLength(5);
  });

  it("names every target even though the chip/capsule row draws no words", () => {
    // Dropping the DRAWN labels is only allowed because the accessible name
    // still comes from the action vocabulary. A Commons resident save gets its
    // exact product name; every other target retains `action.label`.
    expect(TOOLBAR_SRC).toMatch(
      /const label\s*=\s*id === ["']copy["'] && onSaveToMyVault\s*\?\s*["']Save to my vault["']\s*:\s*action\.label/u
    );
    expect(TOOLBAR_SRC).toMatch(/label=\{label\}/u);
    expect(CHROME_SRC).toMatch(/accessibilityLabel=\{label\}/u);
  });

  it("greys a refused target with the STAGE's soft ink, never the page's disabled ink", () => {
    // `--text-disabled` is mixed against paper; on the stage it reads as an
    // absent control rather than a refused one, and a control that cannot be
    // seen cannot be asked why.
    expect(CHROME_SRC).toMatch(/disabled\s*\?\s*colors\.onStageSoft/u);
    expect(CHROME_SRC).not.toMatch(/colors\.textDisabled/u);
  });
});

describe("a disabled viewer control's handler does not fire (§6, §18)", () => {
  it("guards onPress with the same `on` flag the target's `disabled` reads, not the handler alone", () => {
    // Defense in depth, matching the web selection bar's
    // `buildSelectionActions` no-op scrub: `disabled={!on}` is what a tap
    // respects; this guard is what stops `onPress` itself — called directly,
    // bypassing the prop — from reaching a write a read-only grant refused.
    expect(TOOLBAR_SRC).toMatch(/disabled=\{!on\}/u);
    expect(TOOLBAR_SRC).toMatch(
      /onPress=\{\(\) => \{\s*if \(!on\) return;\s*run\[id\]\(\);\s*\}\}/u
    );
  });
});
