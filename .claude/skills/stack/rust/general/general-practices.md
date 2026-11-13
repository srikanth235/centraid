# Rust design and implementation practices

Detailed general Rust guidance distilled from the source guides. Centraid workflow and constraints in [`../SKILL.md`](../centraid.md) take precedence where they differ.

## 1. Mindset

- **Write Rust-shaped code.** Don't port C++, Java, C#, or Python constructs one-to-one. Model errors with `Result`, resources with ownership and `Drop`, polymorphism with traits and enums, and nullability with `Option`. Inheritance-flavored tricks (`Deref` to a "base" struct, `Manager`/`Factory` types, `throw_if_null` helpers) are smells.
- **Make invalid states unrepresentable.** Push invariants into types: enums instead of bool flags and "must be X if Y" comments, newtypes for units and IDs, fallible constructors that validate once. Then the compiler enforces what a comment only requests.
- **Application code is not library code.** Library code (anything with external users) follows the API-design rules below strictly. Application code should favor simplicity and directness: concrete types, `String` or `&str` rather than `impl Into<String>` parameters, `anyhow`-style errors, `Vec` return values, no speculative generality.
- **Let the tools do the work.** rustfmt owns formatting, clippy owns idiom checks, the compiler owns memory safety. Spend your attention on design.

## 2. Before you hand back code

Use `cargo xtask gate --profile local` or `pr` as the canonical check; run targeted commands only when useful for diagnosis. Fix findings rather than silencing them.

- Fix a lint rather than silencing it. When a lint is genuinely wrong for one item, use `#[expect(clippy::name, reason = "...")]` on the narrowest item. `expect` warns when the lint stops firing, so stale suppressions get cleaned up. Use `#[allow]` only in generated code or macro output.
- Never put `#![deny(warnings)]` in source: new toolchains add warnings and break the build. Enforce warnings-as-errors in CI instead, with `cargo clippy -- -D warnings`.
- Configure lints once in `Cargo.toml` (`[lints]` or `[workspace.lints]`), not with scattered crate attributes.

## 3. Ownership and borrowing

**Prefer unique ownership.** Reach for `Rc`/`Arc` only when shared ownership is part of the design, and for `RefCell`/`Mutex` only when interior mutability is. They are not failures, but they move checking from compile time to run time, so use them on purpose.

**Don't clone to make the borrow checker stop complaining.** A clone that exists only to end a borrow produces a silent copy whose later changes are lost. Try these first, in roughly this order:

1. Extend a temporary with a named `let`, or shorten a borrow with a block.
2. Split a long expression into typed intermediates so the failing step is visible.
3. Move a field out of `&mut self` with `std::mem::take` (needs `Default`), `std::mem::replace`, or `Option::take` instead of cloning it.
4. Split a large struct into smaller ones so disjoint fields can be borrowed separately. The compiler tracks disjoint field borrows inside one function, but not across method calls.
5. Clone small, immutable data deliberately, and say so in a comment if it's not obvious.
6. Use indices into an owning `Vec`, or `Rc<RefCell<_>>` with `Weak` back-pointers, as a last resort. Avoid self-referential structs.

```rust
// Move out of a &mut enum without cloning.
fn a_to_b(e: &mut MyEnum) {
    if let MyEnum::A { name, x: 0 } = e {
        *e = MyEnum::B { name: std::mem::take(name) };
    }
}
```

**Accept the most general borrowed type.** `&str` not `&String`, `&[T]` not `&Vec<T>`, `&T` not `&Box<T>`, `Option<&T>` not `&Option<T>`. Deref coercion then lets callers pass owned values, borrows, or literals. Where you only read a path, string, or byte buffer, `impl AsRef<Path>` / `impl AsRef<str>` / `impl AsRef<[u8]>` is fine on parameters (never on struct fields; store `PathBuf` and `String`). Library code that only iterates should take `impl IntoIterator<Item = T>`; application code may simply take `&[T]`.

**Take ownership only when you need it, and then take it by value.** If a function stores or consumes its argument, take `T`, not `&T` plus an internal `.clone()`. If it only reads, take `&T`; if it mutates in place, `&mut T`. Return multiple values as a tuple or struct, not through `&mut` out-parameters (reusing a caller-owned buffer, as `Read::read` does, is the exception).

**Prefer owned data in structs.** A struct holding `&'a T` forces a lifetime onto every container. Owning a `String` or `Vec<u8>` is usually simpler and rarely the bottleneck. When a type does carry a lifetime, give it a descriptive name (`'src`, `'conn`); `'_` and `'a` are fine on simple functions.

**Freeze after setup.** Build with `let mut`, then rebind `let data = data;` so later code cannot mutate it by accident.

**Keep `Rc`, `Arc`, `Box`, and `RefCell` out of public signatures.** Take `&T`, `&mut T`, or `T` and let callers decide how to own things. A service that must be shared implements a cheap `Clone` by wrapping its state in `Arc<Inner>` internally.

### Compiler and clippy errors

Fix the first error first: later ones are often its echo. Clippy runs `cargo clippy --workspace --all-targets -- -D warnings` in the gate, so every warning is an error; fix the code, never add `#[allow]` to go green.

| Error | Fix |
| --- | --- |
| `E0382` use of moved value | Borrow it (`&x`), move the last use later, or restructure so one owner consumes it; clone only if two owners are really needed |
| `E0502` / `E0499` cannot borrow as mutable more than once | Shorten the first borrow (end it before the second), split the struct into disjoint fields, or collect indices first and mutate after |
| `E0505` move out while borrowed | End the borrow first, or move the data into the closure or thread that needs it |
| `E0106` missing lifetime specifier | Return an owned value, or name one lifetime tying the output to the input it borrows from |
| `E0597` / `E0515` does not live long enough, returns reference to local | Return the owned value, or take the buffer from the caller |
| "future is not `Send`" | A non-`Send` value (`Rc`, `RefCell` guard, `MutexGuard`) is held across an `.await`; drop it in a block before the await, or use `Arc` and an async-aware lock |
| `E0277` trait bound not satisfied | Read the "required by" note; add the bound to the generic, derive the trait, or convert the type |
| `E0308` mismatched types | Convert at the boundary (`.into()`, `?` with a `From` impl, `as_deref()`), not with a cast |
| `E0599` no method found | Import the trait that provides it, or the type lacks a derive or a feature flag |
| `clippy::unnecessary_unwrap`, `clippy::manual_unwrap_or` | Use `if let`, `?` or `unwrap_or`; product code has no `unwrap()` by house rule (clippy does not enforce it, review does) |
| `clippy::needless_borrow`, `redundant_clone`, `clone_on_copy` | Delete the `&` or `.clone()` it points at |
| `clippy::too_many_arguments`, `type_complexity` | Group arguments in a struct; name the type with an alias |
| `unused_must_use` / unused `Result` | Handle it with `?`; `let _ =` only for a deliberate best-effort call, with a comment |
| "usage of an `unsafe` block" under `#![forbid(unsafe_code)]` | Only the FFI crates may use `unsafe`; do not lift the forbid, move the code or use a safe API |

## 4. Types and API design

### Naming

| Item | Case | Notes |
| --- | --- | --- |
| Types, traits, enum variants | `UpperCamelCase` | Acronyms are one word: `Uuid`, `HttpClient` |
| Functions, methods, modules, locals | `snake_case` |  |
| Constants, statics | `SCREAMING_SNAKE_CASE` |  |
| Type parameters | short, from the main bound | `T`, `R: Read`, `W: Write` |
| Lifetimes | short lowercase | descriptive when on a type |

- No `get_` prefix on getters: `fn len(&self)`, `fn name(&self) -> &str`, `fn name_mut(&mut self)`. Use bare `get` only when there is one obvious thing to get (`Cell::get`). Related: `set_foo(T)`, `take_foo()`, `with_foo(|f| ..)` for closure access, and unsafe `_unchecked` siblings for checked accessors.
- Conversion prefixes signal cost and ownership: `as_` (free, borrow to borrow), `to_` (expensive, borrow to owned or borrow to borrow), `into_` (consumes `self`). Put `mut` in type order: `as_mut_slice`, not `as_slice_mut`.
- Constructors: `new` (primary), `with_capacity` / `new_with_foo` (variants), `try_new` (fallible), `from_foo` (conversion; pair important ones with a `From` impl). I/O resources use domain verbs: `File::open`, `TcpStream::connect`.
- `iter` / `iter_mut` / `into_iter` return types named `Iter` / `IterMut` / `IntoIter`; `keys()` returns `Keys`.
- Error types read verb-object-error: `ParseBoolError`, not `BoolParseError`.
- Avoid weasel suffixes `Service`, `Manager`, `Factory`, `Helper`, `Util`. Name the thing it is (`Bookings`, `Dispatcher`, `FooBuilder`). Don't repeat the module name in the type (`foo::Id`, not `foo::FooId`). Avoid abbreviations an outsider wouldn't know.
- If you implement `len()`, implement `is_empty()`.
- Feature names are bare: `std`, `serde`, `alloc`, never `use-std` or `no-std`.

### Model the domain with types

- **Newtypes** for semantic distinctions: `struct Miles(f64)` and `struct Kilometers(f64)` cannot be mixed, where a type alias can. Add `#[repr(transparent)]` when layout matters, and derive or forward the traits you need (`derive_more` cuts the boilerplate). A newtype that encodes an invariant (`Month`) validates in a fallible constructor (`TryFrom`, `FromStr`, `try_new`) and never offers an infallible `From` from the raw type.
- **No `bool` parameters in public or shared signatures.** `report(true)` is unreadable at the call site and cannot grow a third mode. Use a two-variant enum (`Verbosity::Summary`, `Verbosity::Full`) or two methods (`report()`, `report_verbose()`): `Widget::new(Size::Small, Shape::Round)`, not `Widget::new(true, false)`. The only exception is a private helper whose call sites sit a few lines away. When refactoring, an existing `bool` parameter is one of the smells to remove, not a detail to preserve.
- **Named fields over tuples**, except single-field newtypes and very local code.
- **`Option` for absence, never sentinels** such as `-1` or `""`. **Data-carrying enums** instead of "field X is only meaningful when Y is set".
- **Use the strongest std type:** `PathBuf` / `&Path` for paths, `Duration` for spans, `NonZeroU32` internally only (keep plain integers at API boundaries).
- **Independent flags** use the `bitflags` crate; an enum models exactly one choice.

### Derive and implement the standard traits eagerly

Downstream crates cannot add std traits to your types (orphan rule), so you must. Derive whenever every field supports it: `Debug` (on every public type; hand-write it to redact secrets), `Clone` (except unique resources and key material), `Copy` (only small bitwise-copyable types, because the compiler copies silently), `PartialEq` / `Eq`, `PartialOrd` / `Ord` (never ship `PartialOrd` without `Ord` when a total order exists), `Hash` (consistent with `Eq`), `Default`. Implement `Display` for anything meant to be read: error types, string-like wrappers. Add `#[must_use]` to pure functions and to types, such as errors and lazy values, whose discarding is a bug.

Implement `From` / `TryFrom`, never `Into` / `TryInto` directly (blanket impls give you those). Prefer `from` / `into` over `as`, which silently allows lossy casts. Implement `FromStr` rather than an ad-hoc `from_str` method, `FromIterator` and `Extend` on collections, and `IntoIterator` for both owned and borrowed forms. Implement `Deref` only on smart pointers and owning collections (`Vec<T>` to `[T]`), never to fake inheritance. Overload operators only for their mathematical meaning.

Don't put derivable trait bounds on struct definitions: `#[derive(Clone)] struct Good<T>`, not `struct Bad<T: Clone + Debug>`. Bounds belong on the `impl` blocks that need them.

If you hand-write `Ord`, hand-write `PartialEq`, `PartialOrd`, and `Hash` to agree with it (compare the same fields, ignore the same fields). A derived `PartialEq` next to a custom `Ord` breaks the std contract and misbehaves in `BTreeMap` and `sort`/`dedup`. Say in the docs which fields equality ignores.

### Constructors, builders, defaults

- Provide `new()` even when `Default` exists, and make them agree (one delegates to the other). Derive or implement `Default` so callers can write `..Default::default()`; bag-of-options structs with public fields should always have it.
- Up to two optional parameters: inherent constructors (`new`, `with_a`, `with_b`). Beyond that, or when construction validates or has side effects, add a builder: `Foo::builder()` returns `FooBuilder`, setters are named after fields (`timeout(d)`, not `set_timeout`) and infallible, and `build() -> Result<Foo, Error>` does all validation including cross-field checks. Prefer non-consuming setters (`&mut self -> &mut Self`) unless `build` must move a value out.
- A constructor with four or more loose arguments should group them into semantic types: `Deposit::new(account, amount)` rather than four `&str` / `u64` parameters.

### Visibility and evolution

- Private by default. Fields stay private unless the struct is passive C-style data. Widen to `pub(crate)` or `pub(super)` before `pub`. Making an item more public later is non-breaking; the reverse is breaking, and every `pub` item is a promise.
- Mark public enums and public-field structs that cross crate boundaries `#[non_exhaustive]` unless the set is a stable ontology. When matching one, list the variants you handle and add a wildcard arm.
- Seal traits you don't want implemented downstream, and say so in the docs:

  ```rust
  pub trait TheTrait: private::Sealed { /* ... */ }
  mod private {
      pub trait Sealed {}
      impl Sealed for usize {}
  }
  ```

- Library code returns iterators, not a `Vec` collected only to return, behind `impl Iterator<Item = T>` (internal APIs) or a newtype (public APIs you must keep stable).
- Expose each public item at exactly one path. Don't `pub use` a foreign crate's items unless you are an umbrella crate. Avoid leaking third-party types into your public API; feature-gate `serde` impls behind a feature named `serde`. If a dependency's type must appear, re-export it so callers can name the matching version.
- Mark a function `const` only if it will stay `const`. Don't expose `ErrorKind` enums or other internals that lock in failure modes you consider private.

### Traits and generics

- Define a trait only for generic programming (`T: Trait`, `impl Trait`, `dyn Trait`) or as an extension trait (`FooExt`). Don't use traits merely to organize code. Put essential functionality in inherent methods and have trait impls forward to them, so callers need no import.
- Prefer, in order: concrete types; generics (`T: Trait`, `impl Trait`); `dyn Trait`, ideally wrapped in your own struct (`struct DynStore(Arc<dyn Store>)`). Generics give static dispatch and inlining; trait objects give heterogeneous collections and smaller binaries. Don't nest generics on service-level types (`Service<Backend>` is fine; `Service<Backend<Store>>` is not).
- Decide early whether a trait must be object-safe. Generic methods or `Self` outside the receiver break it; exclude such methods with `where Self: Sized`.
- Keep required trait methods minimal and provide defaults for everything derivable from them, as `Iterator` does from `next`.
- If a function has a clear receiver, make it a method. A computation with no receiver is a free function, not `Database::check(params)`. Associated functions are for construction.
- Closures: use the most general bound that works (`FnOnce` if called once, `FnMut` if it mutates, else `Fn`) and prefer `Fn*` bounds to bare `fn` pointers. Closure parameters go last; don't take more than one.
- Keep parameter order consistent across a crate: call-specific first, ubiquitous context (loggers, allocators) last.
- Reach for a macro only when functions, generics, and traits cannot do the job. Prefer `macro_rules!` to proc macros, make macro input look like the output it generates, and never let a macro change a type's kind or a function's signature.

### Refactoring someone else's code

- Fix every smell the request is about, not just the cheap ones: clones that only satisfy the borrow checker, `&String` / `&Vec<T>` parameters, `unwrap` on fallible paths, `Rc<RefCell<_>>` in signatures, `get_` getters, `bool` parameters, `+` string concatenation, `#![deny(warnings)]`, error types without `Error`, nondeterministic `HashMap` iteration in output.
- Keep public behavior identical unless changing it is the point: the same operations, the same success and failure semantics, the same output bytes. Turning a panic into an `Err` is the change callers want. Dropping an error variant, removing a derive, or changing what a constructor takes is not; if a signature must change, show the before and after in the change list and say why.
- Preserve quirks you don't understand and flag them, rather than silently "fixing" them.
- When the module has no tests, pin the current behavior with a few before you touch it.

## 5. Errors and panics

Pick the mechanism by contract:

| Situation | Use |
| --- | --- |
| Absence is normal (`first()`, `checked_add`) | `Option<T>` |
| The caller may need to know what went wrong | `Result<T, E>` |
| A bug or violated invariant inside your code | `panic!` / `assert!` / `expect("why")` |

**Panics are not exceptions.** A panic means "stop now". Never use one to report bad input, never rely on `catch_unwind` for control flow (it does nothing under `panic = "abort"` and can leave state inconsistent), and never catch a panic and continue inside a library. Where a panicking convenience is justified, pair it with a fallible API (`v[i]` / `v.get(i)`, `new` / `try_new`) and document it under `# Panics`.

**Every intentional panic carries a message with the relevant values:** `assert!(buf.len() >= HEADER, "buffer too small: {} bytes", buf.len())`, `expect("config is loaded before workers start")`. Prefer `expect("reason")` to `unwrap()`. Don't restate the condition as the message.

**Pattern-match instead of check-then-unwrap:** `if let Some(v) = opt { .. }` or `let Some(v) = opt else { return .. };`, never `if opt.is_some() { opt.unwrap() }`.

**Lock poisoning is fatal:** `.lock().expect("lock poisoned")`. Don't recover with `into_inner`.

**Library error types** (any `E` in a public `Result`):

- Implement `std::error::Error` (which requires `Debug` + `Display`), be `Send + Sync + 'static`, and implement `source()` for wrapped causes. Never use `()`, `String`, or `Box<dyn Error>` as a library's public error type.
- `Display` messages are lowercase, concise, and have no trailing punctuation: `"invalid header length"`.
- Implement `From<Upstream>` so `?` converts. Use `map_err` only for foreign errors or to add context.
- Two sound shapes: an enum with one variant per cause (`thiserror` generates this well), or a struct per situation with a private `kind` plus `is_xxx()` and accessor methods. Either way, don't make one crate-wide enum that lists every failure mode in the crate, and don't expose details callers cannot act on.
- If a fallible function consumes an argument, return it inside the error so the caller can retry without cloning (`FromUtf8Error::into_bytes`).
- Never expose `anyhow::Error` in a library's public API.

**Application error handling:** `anyhow` or `eyre` with `.context("opening config")` is the right tool. Use one app-level error type, not several. `main` may return `Result<(), anyhow::Error>`.

**Destructors never fail, panic, or block.** Provide `close(self) -> Result<()>` for fallible teardown and let `Drop` do best-effort cleanup.

**Document failure modes:** `# Errors` for any `Result`, `# Panics` for any reachable panic, `# Safety` for every `unsafe fn`.

## 6. Everyday idioms

- **Iterators over hand loops** when the pipeline is short and reads top-down: `values.iter().filter(..).map(..).collect()`, `.any()`, `.sum()`, `.fold()`. Collect fallible steps into `Result<Vec<_>, E>` and apply `?`. Keep an explicit `for` loop when the body is large, does several jobs, or needs awkward early returns. Bind a long chain to a named variable rather than putting it in a `for` header, and prefer `for x in it` to `.for_each(|x| ..)`.
- **`Option` / `Result` combinators** (`map`, `and_then`, `ok_or_else`, `unwrap_or_else`, `as_ref`, `as_deref`) when they're clearer than `match`, and `match` when they're not.
- **`format!` / `write!`** with inline args (`format!("{name}: {count}")`) for concatenation and substitution, not chained `+` or `str::replace`. `write!` into an existing buffer in hot paths.
- **Explicit types where inference obscures intent:** on `.into()`, `.parse()`, `.collect()`, and complex iterator results. Prefer `let x: Vec<u32> = ..` to a turbofish.
- **Drop guards for cleanup** that must run on early return or unwind. Bind them to a name (`let _guard = ..`), because `let _ = ..` drops immediately.
- **Closures that capture mixed ownership:** rebind in a block, then `move`:

  ```rust
  let job = {
      let cfg = cfg.clone();
      move || run(cfg, data)
  };
  ```

- **Import style:** one `use` per module path (`use foo::bar::{Bar, Baz};`); types and traits imported and used unqualified (`Regex`); free functions qualified by their module (`mem::take`, `fs::read`). Import a trait inside the function that needs it unless the whole file uses it. No globs except `use super::*` in tests, `use Enum::*` in a function that matches on it, and a framework's prelude.
- **Magic numbers** become named `const`s with a doc comment saying where the value comes from and what changing it affects.
- **Logging:** structured events through `tracing` or `log`, not `println!` / `dbg!`, except for a CLI's own stdout output.

## 7. Concurrency and async

- Public types, and the futures they return, should be `Send` (and usually `Sync`). Pin it with a compile-time check so a refactor can't silently regress it:

  ```rust
  const _: () = {
      const fn assert_send<T: Send>() {}
      assert_send::<MyClient>();
  };
  ```

  Holding an `Rc` or a `RefCell` borrow across an `.await` makes a future `!Send`.

- Prefer message passing (channels) to shared state. When sharing is necessary: keep data with linked invariants under one lock, keep lock scopes to a few lines, never call user closures while holding a lock, and never return a `MutexGuard` from a public method.
- Write `async fn` rather than `fn -> impl Future`, except in traits or when setup must run outside the async block for a hot path.
- Long CPU-bound work inside async must yield (`tokio::task::yield_now().await` every tens of microseconds) or move to `spawn_blocking`.
- Library code doesn't spawn raw threads or assume a runtime; take an executor, a spawn function, or `impl AsyncRead` / `impl Read` from the caller.

## 8. Unsafe and FFI

- Write `unsafe` only for one of three reasons: a novel abstraction safe code can't express, a benchmarked performance need, or FFI and platform calls. Reach for std and well-reviewed crates first; they already contain the audited `unsafe`.
- Every `unsafe` block or impl gets a `// SAFETY:` comment stating why the invariants hold. Every `unsafe fn` gets a `# Safety` doc section listing what the caller must uphold. Enable `unsafe_op_in_unsafe_fn`.
- Keep `unsafe` in the smallest module that can uphold its invariant and wrap it in a safe API; the module boundary is the soundness boundary. A safe function that can cause undefined behavior through any sequence of safe calls is unsound, and unsound code is never acceptable.
- Mark a function `unsafe` only when misuse can cause undefined behavior, not because it is dangerous (`delete_database()` is a safe function).
- No `transmute` to cast enums or dodge lifetimes, and no `unsafe impl Send` to silence the compiler.
- Test unsafe code under Miri and with adversarial inputs.
- FFI: `#[repr(C)]` on shared structs, sized integer types, `CString` / `CStr` for strings, allocate and free on the same side, wrap C-owned pointers in an RAII type whose `Drop` frees them, check for null and return `Result`, and stop panics at the boundary with `catch_unwind`. Generate bindings with `bindgen` in a `foo-sys` crate and keep business logic in a safe core crate.

## 9. Crates, modules, dependencies

- **Prefer small, single-purpose crates** in a flat `crates/` workspace; never nest a crate inside another crate's `src/`. Split when a crate grows a second purpose or a subdirectory. Share versions and lints through `[workspace.dependencies]` and `[workspace.lints]`.
- **Modules:** name a leaf module after its primary item (`Foo` lives in `foo.rs`). Non-leaf modules contain only `mod` declarations and re-exports. Put the essential items at the crate root and group the rest by use case (`account`, `network`), not by kind (`traits`, `errors`). Don't define a prelude.
- **Re-export individually** (`pub use foo::{A, B};`), never with a glob.
- **Dependencies:** every one costs compile time, binary size, and supply-chain exposure, including `build.rs` and proc macros. Use ranges (`"1"`, `"1.4"`), never `"*"` or a needless `"="`. Commit `Cargo.lock` for binaries. Audit with `cargo tree --duplicates`, `cargo deny`, `cargo udeps`, and `cargo audit`.
- **Features are additive and bare-named:** `std`, `serde`, `alloc`, `test-util`. Never `no-std`, `use-serde`, or a feature that removes or changes a public item. Don't feature-gate struct fields or trait methods. Put mocks and fakes behind `test-util`.
- **Semver:** breaking changes include removing or renaming public items, adding a variant to an enum that isn't `#[non_exhaustive]`, adding a field to a publicly constructible struct, adding a trait bound, or making a trait non-object-safe. Deprecate in a minor release before removing in a major one. Use the latest stable edition for new crates and set an MSRV deliberately.
- Don't run code before `main()` (no `ctor`-style crates). Don't use unstable features on a stable toolchain.

## 10. Documentation and comments

- `///` on every public item; `//!` at the top of every public module and the crate root. The first sentence is a single line of about fifteen words, because it becomes the summary in listings.
- Sections, in this order, as applicable: `# Examples`, `# Errors`, `# Panics`, `# Safety`. Examples use `?` with the `fn main` hidden behind `# ` lines, never `unwrap()`, because users copy them verbatim. Describe parameters in prose, not a table.
- Document what the signature can't say: preconditions, side effects, ownership transfer, complexity, and why. Don't restate the type or the name; `/// Removes an element.` on `remove_element` is noise.
- Link items with ``[`Type`]``. Hide impls users never trigger (`From<PrivateError> for PublicError`) with `#[doc(hidden)]`.
- `//` comments explain why, not what: `// SAFETY:`, `// TODO(issue-123):`, non-obvious magic values, workarounds with a link. No design journals, "why we chose X" essays, or rule-compliance tables in code docs. Document the end state.

## 11. Tests

- Unit tests in `#[cfg(test)] mod tests { use super::*; .. }` for private internals. Integration tests in `tests/` for anything reachable through the public API, and prefer that location when either would do. Doc examples are tests too.
- Test observable behavior and properties (monotonic, round-trips, idempotent), not restated constants or mirrored branches.
- Write a failing test before fixing a bug. Cover each feature combination and each platform-specific path.
- Anything doing I/O, time, randomness, or network must be mockable: `new_mocked() -> (Self, MockCtrl)` behind `test-util`, not a `Default` that performs I/O.
- Fuzz parsers of untrusted input with `cargo fuzz`. Benchmark with `criterion` or `divan` and `std::hint::black_box`. Run Miri over `unsafe`.
- Assertions get context so failures read well: `assert_eq!(got, want, "input {input:?}")`.

## 12. Performance

Design for usability first, optimize after measuring. For performance changes, start and end with a number.

```text
reproduce -> measure (optimized build) -> find the line -> fix -> measure again -> commit with the numbers
```

1. **Reproduce** with one command: a test or an `--ignored` rig. Write it down.
2. **Measure an optimized build.** A debug build is several times slower and points at the wrong code (the year-3 rigs are run `--release` for exactly that reason). This workspace's `dev` profile optimizes dependencies at `opt-level = 2` but not your crates; `cargo test --release` or `cargo build --release` is the number to trust. `[profile.release]` keeps `panic = "unwind"` because the FFI boundary catches panics, and `dist` adds thin LTO.
3. **Find the line** with the tool for the symptom:

   | Symptom | Tool |
   | --- | --- |
   | A test or request is slow | `RUST_LOG=debug cargo test --release -p <crate> --test <name> -- --nocapture`, with `tracing` spans (`#[tracing::instrument]`, `tracing` is a workspace dependency) around the suspects |
   | CPU hot spot, any function | `perf record -g` then `perf report` on the test binary, if installed (Linux); `cargo flamegraph` if installed; on macOS `xcrun xctrace record --template 'Time Profiler'` |
   | A SQL read is slow | `EXPLAIN QUERY PLAN` (see the sqlite skill); `crates/core/tests/query_plans.rs` plans every page query |
   | Allocation churn | count allocations with a counting `#[global_allocator]` in a test, or `heaptrack` if installed |
   | Slow incremental build | `cargo build --timings` |
   | Two implementations, which is faster | a `criterion` or `divan` bench with `std::hint::black_box`; no crate here has `benches/` yet, so adding one is a new dependency to justify |

   Profiler traces, flamegraph SVGs and core dumps can contain the process environment, including tokens inherited from the agent's shell. Delete them after reading; never commit them.

4. **Fix**, smallest change first: `Vec::with_capacity` or `collect()` over push loops; reuse caller-owned buffers in hot APIs (`fn read_into(&mut self, buf: &mut Vec<u8>)`); `Box<[T]>`, `Box<str>`, `Arc<str>` for long-lived immutable sequences; a faster hasher (`foldhash`, `FxHash`) only for trusted keys; batch work instead of per-item locking. Derive `Copy` for small plain types, never large ones.
5. **Measure again** with the same command. Put before and after in the commit message: "search p95 41 ms, was 180 ms".

This repo has no gate step or test that asserts on a duration (owner ruling 2026-11-04: they flaked on loaded machines and blocked unrelated changes). Measure by hand, and keep what the gate does check deterministic:

- `tests/journeys.json`: the journey ledger of measured ceilings per surface, volume and hardware. A ceiling is tightened freely; widening one needs an `approvedDeviation` note.
- Year-3 rigs, `#[ignore]`d from normal runs: `crates/apps/<app>/tests/year3.rs`, e.g. `cargo test -p centraid-apps-notes --test year3 -- --ignored --nocapture` (calendar, reminders, docs, health, money, notes, people, photos). Run them in `--release` for numbers you quote.
- Nothing whose cost grows with the vault runs on a request path: page by keyset cursor with `LIMIT`.

## 13. Final checklist

Before returning Rust code, confirm:

- The applicable `cargo xtask gate --profile local` or `pr` is clean.
- No `unwrap()` outside tests and `main`; every `expect`, `assert`, and `panic` has a message with the relevant values.
- Public functions take `&str`, `&[T]`, `impl AsRef<_>`, or `impl IntoIterator`, not `&String` or `&Vec<T>`.
- Every public type derives `Debug` and the applicable common traits; error types implement `Error + Display + Send + Sync + 'static`.
- No `bool` parameters in public signatures; no hand-written `Ord` without matching `PartialEq` and `Hash`.
- No `.clone()` whose only job is to satisfy the borrow checker.
- No globs (bar a framework's prelude), no preludes of your own, no leaked third-party types.
- Every `unsafe` block has a `// SAFETY:` comment; every `unsafe fn` has `# Safety` docs.
- Public items have docs with a one-line summary and `# Errors` / `# Panics` where relevant.
- Application code stayed simple; library code followed the API rules.
