# `crates/design` — one lowering of `packages/design`, in Rust

`packages/design` is the token source with two lowerings from one token set: `toCss()` for the web and desktop, `toNativeTheme(scheme)` for native. Wave 3 emitted the native one as data — `design/native-theme.json`, `mobile/.../Tokens.kt`, `mobile/iosApp/Design/Theme.swift` — from one emitter with a drift gate. This crate is the Rust half of that same lowering, and it exists because a parity comparison was blocked on it.

## Why it exists

`contracts/apps/tally/queries.json` carries, on every ledger row, a party's `color` from `partyHueValue(partyHueKey(id))`, its `initials` from `identityInitials` and a figure's tone from `figureTone`. Wave 2 committed those 29 cases and could not compare them: dropping the fields would have meant editing a generated fixture, and retyping the functions would have meant two hue wheels that look right and disagree.

## What keeps it honest

| Risk | What stops it |
| --- | --- |
| A retyped hue wheel drifting from the TypeScript one | `contracts/tools/export-design-corpus.ts` runs the REAL functions over a fixed corpus into `design/identity-corpus.json`; `tests/corpus.rs` asserts **every row** (192 hue rows, 30 names, 30 figures) |
| A hand-maintained colour table | the theme is READ from `design/native-theme.json`. The only colour literal in the crate is `BRAND`, and the corpus asserts that too |
| A role quietly dropped from the native theme | the emitter carries `colorRoleContract` as data, and `assert_native_color_role_contract` re-asserts it in Rust over the committed bytes — the artifact a Rust surface actually reads |
| A route with no sentence | `copy/<app>.json` carries the copy table's route ids AND the screen's, read independently; `copy::route_gaps` names either gap, because a route id in one and not the other is a silent empty string |

## The corpus is hostile on purpose

Non-ASCII names, an empty name, a whitespace-only name, a name that is one emoji, single-character ids, long ids, and every shape of stored `avatar_color` that `partyHueKey` distinguishes — including the two that answer `None`, which is a stored literal the wheel cannot name and is **not** silently defaulted.

## The one bug reproduced rather than fixed

`identityInitials` slices with `String.prototype.slice(0, 1)`, which cuts a **UTF-16 code unit**. A name whose first character is outside the BMP ("🙂 Smith") yields half a surrogate pair: a string Rust's `String` cannot hold and no font can draw. So `identity_initials_units` is the primitive and returns code units; `identity_initials` is the lossy convenience over it, and the corpus compares units. A port that "fixed" this would go red here, and the receipt carries the finding — the fix is a design decision about grapheme clusters, not a port's to take.

## What is not here

No formatting. `fmtMoney`, the relative-time strings and the sentence composers stay on the TypeScript side and move with their own lanes; this crate answers with values — a hue, a set of initials, a tone, a token table — and the surface makes the string.
