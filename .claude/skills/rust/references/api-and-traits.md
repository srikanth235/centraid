# API, types and trait design

Open this when adding a public type, a trait, a builder, a module or a crate boundary. Pack rules: the `api-`, `type-`, `trait-`, `conv-`, `own-` and `name-` files in [rules-index.md](rules-index.md); long-form reasoning in [best-practices.md](best-practices.md) and [guides/rust-api-guidelines.md](guides/rust-api-guidelines.md). This file records the shapes the crates actually use.

## Shapes in use

| Need | Shape, and where |
| --- | --- |
| A seam a test or a second implementation must fill | A small **port trait** with a real implementation and an in-memory one, proved by one shared conformance suite: `State` in `crates/gateway/src/rules/state.rs`, `memory.rs`, `conformance.rs` (`Target`). Others: `Clock`/`Ids` (`crates/vault/src/clock.rs`), `Model`/`ModelLoader` (`crates/assist`), `Fetch` (`crates/media`), `Screen`/`ScreenCtx` (`crates/core`, `crates/screens`) |
| An injected fact (time, ids, randomness) | A trait with a system implementation and a fixed one; give `Arc<T>` a blanket impl so a test keeps a handle to the clock it gave away (`impl<T: Clock + ?Sized> Clock for Arc<T>`) |
| A closed set the compiler must check | An `enum`, matched exhaustively; a **policy table** keyed by the discriminant when the same match recurs ([coding-standards](../../../../docs/coding-standards.md#policy-tables-over-discriminator-branches)) |
| A value that must be valid | A newtype with a fallible constructor (`TryFrom`, `FromStr`); the rest of the code takes the type, not the string |
| A group of rules that must not reach a runtime, file or clock | A separate module with its own dependency list, scanned by a test (`crates/gateway/src/rules`, `tests/pure_rules.rs`); features split `rules` / `client` / `server` |
| Dispatch | Generics (`impl Trait`) in a hot or sealed path; `dyn Trait` for a stored, swappable collaborator (a `Box<dyn Clock>` in `Vault::create_with`). Do not box to avoid writing a generic |

## Always

- Make the invalid state unrepresentable before documenting it: an enum over a bool pair, `Option` over a sentinel.
- Accept the most general borrow, return an owned value unless a caller needs the borrow.
- Keep the public surface small: `pub(crate)` by default, re-export what a crate promises from `lib.rs`, and let other crates go through it, not into its modules.
- Derive `Debug` (hand-write it to redact a key), `Clone`, `PartialEq`, `Eq`, `Default` where they are meaningful; `#[must_use]` on pure functions and result-like types (the house style).
- Put a behaviour a second implementation must keep in the conformance suite, not in a doc comment.
- Name for the domain: no `utils.rs`, `helpers.rs` or `*_manager`; no `get_` on a getter; `as_`/`to_`/`into_` by cost.
- Mark the module with a `//!` header that carries the mental model; name an invariant with a capitalised heading ([coding-standards](../../../../docs/coding-standards.md#comments-face-forward)).

## Never

- A trait with a single implementor and no test double (speculative generality); a generic parameter used once.
- A `Deref` impl to fake inheritance; operator overloading for a non-arithmetic meaning.
- A `Rc`, `Arc`, `Box` or `RefCell` in a public signature when `&T`, `&mut T` or `T` serves.
- A parallel `foo_v2` beside `foo`, or a re-export kept "for migration".
- A cross-crate reach into another crate's private layout; `screens-per-app-layout` forbids an app's screens naming another app's module.
