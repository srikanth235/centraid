# `crates/design`: design values and computed identity, owned by Rust

Two jobs. Both are pure data and arithmetic, and neither touches TypeScript ([#1173](https://github.com/srikanth235/centraid/issues/1173)).

## 1. `tokens`: the model of `design/tokens.toml`

`design/tokens.toml` is the one source of design values: the redesign's app, state, shell and list colours, surfaces, text, type scale and radius, plus the legacy native lowering the shells draw today (the 55 colour roles in both schemes, the app catalogue and its marks, the type table, geometry and font faces). `design/icons.toml` holds the 140 icon silhouettes as path data. `crates/design/src/tokens.rs` is the parser and the validation:

| Check | Why |
| --- | --- |
| every one of the 55 native roles is in both schemes, and the schemes name the same set | the shells look roles up by string; a dropped role is a silent fallback |
| every colour is `#RRGGBB` (a role may also be `rgba(…)` or a CSS shadow) | a typo must not reach a `Color(0x…)` literal |
| every app, state and the shell has `light`, `dark_fill` and `dark_text` | dark is designed, not inverted |
| app, state and shell colours reach 4.5:1 as text on the light page; dark text values reach 4.5:1 on the dark card; white glyphs reach 4.5:1 on each dark fill | accessibility: text 4.5:1 |
| list colours reach 3:1 on the light page and on the dark card | lists are drawn as dots, bars and big titles |

A value that fails a floor is a failing test, and the value is reported, not adjusted. `cargo xtask design` reads this model and writes the iOS asset catalogue and Swift tables, the Android resources and Kotlin tables, the kit's words, the fonts and the two sites' token sheet; `cargo xtask design --check` is the gate's `design` step.

## 2. Computed identity

A party's hue key from its id, its initials, and a figure's tone. The core computes them once and sends the shells a key; the shells only look it up. They were ported from the retired `packages/design` ([#1020](https://github.com/srikanth235/centraid/issues/1020)), and the unit tests pin that package's answers as literal rows over a deliberately hostile corpus: non-ASCII names, an empty name, a whitespace-only name, a name that is one emoji, single-character ids, long ids, and every shape of stored `avatar_color`, including the two that answer `None` (a stored literal the wheel cannot name, which is **not** silently defaulted).

### The one bug reproduced rather than fixed

`identityInitials` slices with `String.prototype.slice(0, 1)`, which cuts a **UTF-16 code unit**. A name whose first character is outside the BMP ("🙂 Smith") yields half a surrogate pair: a string Rust's `String` cannot hold and no font can draw. So `identity_initials_units` is the primitive and returns code units; `identity_initials` is the lossy convenience over it, and the tests compare units. A port that "fixed" this would go red here, and the finding is recorded on [#1020](https://github.com/srikanth235/centraid/issues/1020): the fix is a design decision about grapheme clusters, not a port's to take.

## What is not here

No formatting. `fmtMoney`, the relative-time strings and the sentence composers are not design values; this crate answers with values (a hue, a set of initials, a tone, a token table) and the surface makes the string.
