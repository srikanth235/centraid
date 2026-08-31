# locker-gate

**Goal:** prove that Locker is sealed by construction on a freshly paired phone — Home never publishes a count for it, the cover opens onto the unlock gate rather than any content, the gate's own control refuses at rest, and an OS process restart leaves the gate exactly where it was.

**Setup:** Locker ships **no** demo scenario (`packages/blueprints/apps/locker/` has no `seed.js`, which is why `ctx.ensureDemo("locker")` would fail by design), and that is the point: this journey is about the seal, not about content. It seeds **Docs** instead, for one structural reason only — Home draws the launcher grid only once some tile has content (`apps/mobile/src/screens/home/springboard-policy.ts`'s `springboardState`), and on a wholly empty vault Home renders the day-one treatment with no tiles at all. The flow then pairs via `ctx.configureGateway()`.

**Steps:** from Home, observe the Locker tile's accessible name, open Locker, observe the app bar's ambient sentence and the first-run gate with its refusing control, restart the app process, return to Locker, and observe the same gate.

**Expectations:**

1. **Home withholds the count.** `Open Locker, locked` is the tile's accessible name: `LauncherGrid.tsx:152-156` speaks `countLabel` alone when `count` is `undefined`, and `useSpringboardTiles.ts:405-411` leaves Locker's count undefined **by design** — "no read, by design … a sealed Locker never votes the vault empty." A tile reading `Open Locker, 0 locked` would mean Home had started reading the one app it must not.
2. **The cover states its own boundary.** `Nothing is browsable until there is a passphrase` is the setup route's ambient sentence (`packages/blueprints/apps/locker/view-copy.ts` `ROUTE_STATUS.setup`), drawn by `apps/mobile/src/apps/locker/LockerScreen.tsx` into the app bar and published nowhere else. The v17 rebuild replaced the pre-v17 `Secrets stay online-only` subtitle with the design's per-route status line; the same fact — this app's own boundary, stated in words rather than implied by a glyph — is what both sentences carry.
3. **The gate is the first thing, and it refuses at rest.** `Choose a passphrase` and the twelve-character sentence (`view-copy.ts` `SETUP_BODY`, drawn by `LockerWall.tsx`) are the not-yet-configured state; `Create it` (`view-copy.ts` `CREATE_PASSPHRASE`) is rendered **disabled** because the empty field is under `PASSPHRASE_MINIMUM`. A gate that arrives enabled has a floor that is decoration.
4. **The seal survives the process.** After `stopApp` + relaunch the same gate is drawn — nothing about a Locker session crossed the process boundary.

**Selectors** ([#890](https://github.com/srikanth235/centraid/issues/890) W2): `home-tile-locker`, `locker-gate` and `locker-gate-submit` are how the flow finds the tile, the wall and its one control; the withheld-count label, the boundary sentence, the passphrase floor and the disabled state stay asserted as copy and as state beside those handles. The handle proves something was drawn, the sentence is what it promises — dropping either half would leave a gate that is present but says nothing, or a sentence with no control under it.

**Verdict:** PASS only if all four hold. The failure this exists to catch is Locker arriving on any surface other than its gate — a cached list, a zero count on Home, or an enabled control on an empty field.

**Deliberately not asserted:** typing into the passphrase field. It is `secureTextEntry`, so the value can never be read back, and its `accessibilityLabel` is on a React Native `TextInput`, which does not reach the iOS accessibility tree (README "Known caveats") — the field cannot be selected by name at all. Proving the 12-character floor _transitions_ (short input still refused, long input accepted) needs a relative-anchor tap validated against a live hierarchy; it is recorded as an open gap rather than guessed from the source.
