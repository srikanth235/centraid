// The viewer's read-only reason (v4 handoff §6, §18; issue #711 item M).
//
// Two defects closed here:
//
//   1. `PhotoLightboxToolbar` used to state the reason ONLY via
//      `accessibilityHint` — invisible to a sighted member, which is exactly
//      the tooltip pattern the handoff forbids ("a refusal reason must be
//      stated inline, never as a tooltip"). It now also renders a visible
//      `<Text>` line under the bar, in `--net` mono.
//   2. `PhotoLightboxToolbar` and `PhotoLightbox` used to carry two DIFFERENT
//      strings for the same fact ("This vault is read-only" vs "This vault
//      is read-only for you, so meaning cannot be written into it."). Both
//      now import the one `READ_ONLY_VAULT_REASON` from viewer-model.ts.
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

describe("READ_ONLY_VAULT_REASON — one sentence for one truth", () => {
  it("names the vault AND what cannot be written into it — not a stub", () => {
    expect(READ_ONLY_VAULT_REASON).toBe(
      "This vault is read-only for you, so meaning cannot be written into it."
    );
  });

  it("is what both PhotoLightboxToolbar and PhotoLightbox import — never re-typed", () => {
    expect(TOOLBAR_SRC).toMatch(
      /import\s*\{[^}]*READ_ONLY_VAULT_REASON[^}]*\}\s*from\s*"\.\/viewer-model"/u
    );
    expect(LIGHTBOX_SRC).toMatch(
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
    expect(TOOLBAR_SRC).toMatch(/accessibilityHint=\{on \? undefined : why\}/u);
  });

  it("keeps naming all five actions — the phone rearranges the viewer, it does not water it down", () => {
    expect(VIEWER_BOTTOM_ACTIONS).toHaveLength(5);
  });
});

describe("a disabled viewer control's handler does not fire (§6, §18)", () => {
  it("guards onPress with the same `on` flag Pressable's `disabled` reads, not the handler alone", () => {
    // Defense in depth, matching the web selection bar's
    // `buildSelectionActions` no-op scrub: `disabled={!on}` is what a tap
    // respects; this guard is what stops `onPress` itself — called directly,
    // bypassing the prop — from reaching a write a read-only grant refused.
    expect(TOOLBAR_SRC).toMatch(
      /onPress=\{\(\) => \{\s*if \(!on\) return;\s*run\[action\.id\]\(\);\s*\}\}/u
    );
  });
});
