# photos-permissions

**Claim:** a REFUSED OS media grant degrades into an honest takeover with a working recovery path, and never removes the way back Home. If this passes when it should not, a release ships in which denying a permission strands the member on a dead screen with no way out of Photos.

**Goal:** prove a refused device grant takes over an empty library with an honest recovery path and never removes the way Home.

**Steps:** purge the Photos demo corpus, pair against the empty vault, relaunch with every device permission denied, enter Photos through its product deep link (an empty Home intentionally has no content tile), enter Library, assert the refusal takeover, recovery control, and disabled Select action, then take the Home capsule out of the takeover and require Home itself to arrive. The next suite journey seeds the corpus through the same paired profile.

**Verdict:** PASS only if the empty-vault refusal is explicit, actionable, and escapable through Home.

**Selectors** ([#890](https://github.com/srikanth235/centraid/issues/890) W2): the cover, the Library band destination, the refusal takeover and the disabled Select are taken by handle (`photos-collections`, `photos-band-library`, `photos-access-panel`, `photos-select`). Every sentence stays asserted as copy, because on this screen the copy **is** the claim: `Photos cannot reach your camera roll` is what the OS's refusal is turned into for a member. The recovery control is asserted by its label (`Allow access|Open Settings`) rather than by one of its two handles, since which of `photos-access-ask` / `photos-access-settings` a refused state earns is the OS's answer, not the app's.

**Known gap:** the frame's way-home capsule (`kit/band/band-capsule.ts`) carries no `testID`, so that tap stays on copy. It is safe as copy precisely because the assertion after it is not — arriving at Home is what is proven.
