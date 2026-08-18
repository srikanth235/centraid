# photos-viewer

**Goal:** prove the lightbox is a navigable stage rather than a static image.

**Steps:** enter the seeded Library, open the newest named photograph, swipe to the next named photograph and back, open overflow, assert capability rows, open the info sheet and assert the location renders as a phrase (never a coordinate) with the explicit copy action, and return to Library.

**Verdict:** PASS only if the stage chrome, both page directions, overflow capabilities, the phrased info sheet, and dismissal all remain reachable. Publishes `artifacts/e2e/ui-impact/issue-816-place-phrase-info.png`.
