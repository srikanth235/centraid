# photos-viewer

**Goal:** prove the lightbox is a navigable stage rather than a static image.

**Steps:** enter the seeded Library, open the newest named photograph, swipe to the next named photograph and back, open overflow, assert capability rows, open the info sheet and assert the location renders as a phrase (never a coordinate) with the explicit copy action, and return to Library.

**No percentage-coordinate gestures** ([#890](https://github.com/srikanth235/centraid/issues/890) W2). Two lived here and are gone:

- Paging was `swipe: { start: "80%,30%", end: "20%,30%" }` — correct until a layout moves, at which point a layout edit and a paging regression are indistinguishable. It is now a swipe **from `photos-viewer-pager`**, the horizontal pager itself, which is the anchor `apps/mobile/src/kit/test-ids.ts` names for exactly this retirement.
- Dismissing the overflow menu was `tapOn: { point: "10%,50%" }`, a stable left-stage point outside the anchored card. The backdrop sits deliberately outside the modal's accessibility subtree, which is why it had no selector at all; `shell-menu-backdrop` is that selector now (`kit/components/AnchoredMenu.tsx` says so at the handle), and the dismissal is confirmed by `shell-menu-card` going away.

**What stays copy, and why.** The photograph is still opened **by its own name**, not by `photos-tile-0`: two of this flow's claims depend on _which_ photograph it is — the disabled `Previous photograph` needs the first of the timeline, and the info sheet's phrasing needs the one whose place the vault has no name for. A positional handle would open whatever leads the grid and turn both into assertions about the seed. The overflow menu's seven rows, and `A place with no name yet`, likewise stay asserted as copy: each is a promise the screen publishes, not a way of finding it.

**Verdict:** PASS only if the stage chrome, both page directions, overflow capabilities, the phrased info sheet, and dismissal all remain reachable. Publishes `artifacts/e2e/ui-impact/issue-816-place-phrase-info.png`.
