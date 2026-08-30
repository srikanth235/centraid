// Component-existence debt ledger (#883 B1).
//
// The kit owns the primitives: a Button that is already a target-sized,
// token-styled, focus-visible control, and a modal that already traps focus and
// returns it. A raw `<button>` with no class, a raw `<dialog>`, or a bare
// `<Pressable>` with no style is a SECOND primitive — it looks like the kit's
// until the day the kit changes and it does not.
//
// This file is the burn-down ledger of what each surface still carries.
// `scripts/lint-engine-conformance.mjs` asserts the real counts EQUAL these
// numbers, exactly as `token-purity-allowlist.ts` does for CSS literals: a new
// instance turns the gate red, and so does an uncounted cleanup, so the ledger
// can never drift from the tree. It may only SHRINK — do not add a file and do
// not raise a count. The end state is three empty objects.
//
// Counting rules (they live with the check, restated here so a number can be
// audited without reading the scanner):
//
//   * Comments are blanked first, so a `<dialog>` named in prose is not debt.
//   * `*.test.*` / `*.spec.*` are excluded — a fixture is not a surface.
//   * A `<button>` counts only when its FULL opening tag — read across lines,
//     brace- and quote-aware — carries neither `className=` nor `class=`. A
//     styled raw button is a different (smaller) debt and is not tracked here.
//   * A `<Pressable>` counts only when its full opening tag carries no `style`.
//   * A file that IS a kit modal is not debt and is not listed: the lane
//     counts SECOND primitives, and the first one has to live somewhere. They
//     are named in the scanner (`KIT_MODAL_OWNERS`), not budgeted here, so an
//     unnamed one still turns the gate red.
//
// #883 B9 emptied the blueprint half of the first two lanes: every
// `packages/blueprints` dialog is `_shared/KitModal.tsx`, and every class-less
// button there is now `_shared/Segmented.tsx`'s kit option.
//
// Wave 5 emptied the dialog lane outright: the shell's seventeen `<dialog>`s
// are `packages/client/src/react/ui/ShellModal.tsx`, which is the same
// component over the same `apps/_shared/modal-kit.ts` law — a second WRAPPER,
// not a second primitive, because the client program cannot compile a
// blueprint `.tsx` (the reason is stated at `KIT_MODAL_OWNERS`).
//
// Wave 5 emptied the Pressable lane the same way: every style-less
// `<Pressable>` on the phone is `apps/mobile/src/kit/components/Tappable.tsx`,
// which carries the role, the hit slop that buys the touch floor, the
// momentary press step and the disabled wiring. `Tappable` needs no entry of
// its own: it passes a `style` to the `<Pressable>` it wraps, which is exactly
// what this lane counts the absence of, so the wrapper is outside the lane by
// the same rule that puts every caller inside it.
//
// Wave 6 emptied the button lane, the last of the three. Every shell segmented
// strip and tab band is `screens/settings-controls.tsx`'s `Segmented`, whose
// option carries `styles/seg.module.css`'s `.segOption` — the shell's half of
// the `kit-seg-option` the blueprints already adopted — and every other
// class-less shell button is `react/ui/Button.tsx`, the crash wall's one way
// out included. The lane's last row, the Assistant companion's inline
// attachment menu, could take neither: a `role="menu"` popover's children must
// carry `role="menuitem"` and the kit Button renders a plain `<button>` with no
// role slot (mobile's `Tappable` carries one). It is the other end state this
// lane accepts — ONE owner that carries the class — so the rule that already
// styled it by descendant selector now names it: `.attachmentMenuItem`.

/** `<dialog>` elements, keyed by repo-relative path. Kit equivalent: a kit
 *  modal. EMPTY since #883 wave 5 — the end state this lane was built for. */
export const RAW_DIALOG_LEDGER = Object.freeze({});

/** Class-less `<button>` elements. Kit equivalent: kit Button.
 *  EMPTY since #883 wave 6 — the end state this lane was built for. */
export const UNSTYLED_BUTTON_LEDGER = Object.freeze({});

/** Style-less `<Pressable>` elements. Kit equivalent: the kit's `Tappable`.
 *  EMPTY since #883 wave 5 — the end state this lane was built for. */
export const UNSTYLED_PRESSABLE_LEDGER = Object.freeze({});
