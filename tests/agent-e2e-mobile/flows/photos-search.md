# photos-search

**Goal:** prove a seeded album name reaches both its grouped result and photographs.

**Steps:** choose Search, type `Tahoe scouting`, observe non-empty Results and the grouped album hit, open it, then open its seeded cover in the viewer.

**Verdict:** PASS only when the search count is non-zero, the album row is actionable, and a reached photograph opens in the lightbox.

**Selectors** ([#890](https://github.com/srikanth235/centraid/issues/890) W2): the cover, the Search band destination and the query field are taken by handle (`photos-collections`, `photos-band-search`, `photos-search-field`) rather than by the words `Search` and `Search photographs`, both of which half the app draws. The query, the result count and the album row stay copy: those are the vault's own answer.
