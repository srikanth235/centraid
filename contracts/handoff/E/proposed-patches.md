# Proposed patches for files lane E does not own

The receipt carries one line per finding; this file carries the patch each one needs, so the owning lane has an edit rather than a description ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E; R-1020-35: a correctness bug the port surfaces is fixed at its source).

---

## 1. `Vault::open` restarts its id sequence, so the first write after ANY reopen collides

**The most serious of these. A gateway that restarts fails its next write.**

`crates/vault/src/file.rs:59` and `:97` both default to `SeededIds::new("v1")`, and `SeededIds` is a seed plus an `AtomicU64` counter starting at zero (`crates/vault/src/clock.rs:205-225`). The counter is per-instance, so **every `Vault::open` mints the same id sequence from the beginning** and the first write of a second session asks for an id the first session already used.

**Reproduced, from Kotlin, through the real C ABI.** `spike-fixture` founds a vault and writes 200 parties in one session; `AbiRoundTripSpec` reopens that file and sends one `core.add_party` through the real command plane:

```
Refused(code=63, detail=entity id is already held by another kind: core_party (#916))
```

`code=63` is `ERROR_CODE_INTERNAL`. The Kotlin test admits both outcomes on purpose, so it neither hides the bug nor has to be edited when it is fixed.

Two defects in one refusal:

1. **The id default is deterministic.** `SeededIds` exists for `crates/sim` and the golden fixtures, and it is the right default for neither a gateway nor a seat. Both real callers already INJECT ids through `CoreConfig.ids`, so nothing needs the default to be seeded.
2. **The owner-facing sentence is a raw predicate.** It reaches a member through `CommandOutcome.reason`, and `command.proto`'s own comment says the opposite: _"An OWNER-FACING SENTENCE… The raw predicate reaches the audit trail and never a member."_

Patch (`crates/vault/src/file.rs`, lane D3's file):

```rust
-        Self::create_with(path, Box::new(SystemClock), Box::new(SeededIds::new("v1")))
+        // RANDOM BY DEFAULT. `SeededIds` is for the deterministic simulation
+        // and the golden fixtures, both of which INJECT it through
+        // `CoreConfig.ids`; as a default it restarts its counter on every open,
+        // so the first write of a second session collides with the first write
+        // of the first (#1020 wave 3 lane E, reproduced through the C ABI).
+        Self::create_with(path, Box::new(SystemClock), Box::new(RandomIds::new()))
```

…and the same on `:97`, with a `RandomIds` that mints uuid-v7 from system entropy. `SeededIds` stays untouched for its two real callers.

**The red-first test that would have caught it:** open a vault, write, close, reopen, write again, assert the second write executes. No test in `crates/vault` does it — every test founds a fresh file.

---

## 2. `Hello` carries no `ArtifactIdentity`, so a released shell cannot check the core it loaded

`crates/centraid/src/identity.rs`'s own header says what should happen:

> when `crates/core-ffi` is on the umbrella this module moves to `crates/core` unchanged and `open`'s handshake response carries an `ArtifactIdentity` with these three field names, which is the contract lane E's KMP side asserts against.

`crates/core-ffi` **is** on the umbrella and the move has not happened. `centraid.core.v1.Hello` carries `schema_version`, `min_supported`, `product_version` and `capabilities`, and no digest.

Handled honestly on the shell side rather than papered over: `CentraidCore.identityOf` reports `digest = "dev"`, which routes `requireDigest` into its NOT-CHECKED branch with a warning naming both sides — the same branch `require_digest` takes, and never a silent pass. But a RELEASED shell can never get a match, which is the case the mechanism exists for.

Patch (`crates/api-proto/proto/centraid/core/v1/handshake.proto`, lane C's file; a fresh field number, which `buf breaking`'s `FILE` category admits because an older peer ignores it):

```proto
 message Hello {
   uint32 schema_version = 1;
   uint32 min_supported = 2;
   string product_version = 3;
   repeated string capabilities = 4;
+  // WHAT THIS BUILD IS (#1020 Artifacts, D-1020-G2). A prebuilt core the shell
+  // did not compile cannot be checked by construction, and a stale core is the
+  // worst failure shape in the design: it starts, it answers, and it answers
+  // from a schema the shell stopped speaking.
+  ArtifactIdentity identity = 5;
 }
+
+message ArtifactIdentity {
+  string git_sha = 1;
+  // `cargo xtask artifact-key`'s output. THE field a machine compares.
+  string digest = 2;
+  // The vault `user_version` this build writes.
+  int64 schema_version = 3;
+}
```

plus moving `identity.rs` to `crates/core` unchanged and filling the field in `Handle::hello`. `mobile/core`'s `identityOf` then reads it and nothing else on the Kotlin side changes: `requireDigest` is already a clause-for-clause port with its own tests.

---

## 3. `crates/core-ffi` has no fault-injection point, so no shell can test its own poison handling

`tests/contract.rs:495` says it in its own words — _"A real panic inside a `call` would need a fault injection point the ABI does not have"_ — and drives `Handle::poison` directly, a Rust-side call no shell can make.

Clause 9's poison is the half **a shell depends on**: `PANICKED` must arrive as a typed failure, the handle must stay poisoned, and the first diagnostic id must be the one kept. `mobile/core` proves all three against a fake ABI and says so where the fake is defined. What it cannot prove is that the real library produces what the fake produces.

Patch (`crates/core-ffi`, lane D2's crate) — **no sixth symbol**, so clause 10 is untouched:

```rust
+/// A fault-injection door, behind a feature that is never on in a release.
+///
+/// It rides the EXISTING `Admin` request rather than a new symbol: clause 10
+/// says five symbols and means it, and a shell that needed a sixth to test the
+/// fifth would have a sixth in production.
+#[cfg(feature = "debug-fault")]
+K::Admin(admin) if admin.debug_panic => {
+    panic!("debug-fault: a deliberate panic for a shell's clause-9 test");
+}
```

with `debug_panic` as a new `bool` on the admin payload and `debug-fault` absent from every release profile. `abi-five-symbols` keeps counting five, because nothing is exported.

---

## 4. `packages/design`'s `NativeColors` contains three values that are not colours

`packages/design/src/native.ts:1-9` promises every value in the native lowering is _"concrete and ready to render"_, with _"no `var()`, `calc()`, `color-mix()`, `oklch()`, stylesheet parser or runtime override layer in the mobile path"_. Two kinds of value break that for a non-CSS consumer:

- `rgba(20,20,20,.08)` — a CSS colour FUNCTION, in `accentSoft`, `bgSel`, `lineSel`, `netWash`, `scrim`. The emitter parses these; a colour in another notation only half breaks the promise.
- `0 24px 48px -16px rgba(20,20,20,.16)` — a CSS **`box-shadow`**, in `shadowLg`, `shadowSm` and `shadowAmbient`. Not a colour at all, and `assertNativeColorRoleContract` passes over it because the contract checks which KEYS exist, not what they hold.

Lane E handled it rather than hiding it: the emitter splits the three into a separate `effects: Map<String, String>`, and `NativeThemeSpec` asserts they are named, excluded from the colour roles, and still CSS. **It did not invent a shadow API**, because a native elevation grammar is a design decision this lane does not get to make.

The fix belongs in `packages/design` (the pinned oracle, so a finding rather than an edit): `NativeTheme` should carry an `elevation` record of concrete native values — an offset, a radius, a spread and a colour, four numbers a Compose `Modifier.shadow` and a SwiftUI `.shadow` can both take — and `NativeColors` should hold only colours, which is what its name says.

---

## 5. `Cargo.lock` was stale for `centraid-core-ffi` — RESOLVED on `529435a1`

**No longer needs action.** The lock regenerated somewhere between `2fc8d284` and `529435a1` and now carries the entry; `cargo check --workspace` on the rebased tree leaves it clean. Kept here because lane E's commits visibly revert the file on every commit, and a reader should know why that stopped being necessary rather than wondering whether it was ever right.

`cargo build -p centraid-core-ffi` adds `centraid-vault` to that package's dependency list in the lockfile. `centraid-vault` has been in `crates/core-ffi/Cargo.toml`'s `[dependencies]` since wave 2 lane D2; only the committed lock is behind. `Cargo.lock` is lane G's (_"never hand-edit; rebase, re-run `cargo check --workspace`"_), so lane E reverted the change on every commit rather than carrying it. **G should run `cargo check --workspace` and commit the result**; until then every `cargo build` here dirties the tree.

---

## 6. `cargo xtask`'s repo root is baked in at COMPILE time, so a shared `CARGO_TARGET_DIR` makes the gate scan the wrong tree

**Found by accident, and it is the most surprising thing in this list.**

`crates/xtask/src/main.rs:142`:

```rust
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    ...
}
```

`env!` is evaluated when the binary is compiled, not when it runs. The wave 3 briefs tell three lanes to share one `CARGO_TARGET_DIR` (disk is tight), so the `xtask` binary in that directory is whichever worktree compiled it last — and every path-based rule then scans **that** worktree.

Observed, in this order, from `/home/user/centraid-laneE`:

```
$ cargo run -q -p xtask -- rules
  ok  commonmain-no-platform-import — 12 file(s) scanned, clean
# ... another lane builds xtask into the shared target dir ...
$ cargo run -q -p xtask -- rules
  PENDING commonmain-no-platform-import — mobile/shared lands in wave 3 lane E
$ touch crates/xtask/src/main.rs && cargo run -q -p xtask -- rules
  ok  commonmain-no-platform-import — 12 file(s) scanned, clean
```

The same command, the same tree, three different answers. **A gate that scans the wrong tree reports clean**, which is the worst direction for this to fail in: `sql-confinement`, `no-listening-socket` and `abi-five-symbols` are all path-based, and all three would have reported clean over a tree nobody asked about.

Patch (`crates/xtask/src/main.rs`, lane G's file):

```rust
 fn repo_root() -> PathBuf {
-    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
-    match manifest.parent().and_then(std::path::Path::parent) {
-        Some(root) => root.to_path_buf(),
-        None => manifest,
-    }
+    // FROM THE CURRENT DIRECTORY, NOT FROM THE BUILD'S. `env!` is evaluated
+    // when this binary is compiled, and the wave 3 lanes share one
+    // CARGO_TARGET_DIR — so a binary compiled from another worktree made every
+    // path-based rule scan THAT worktree and report clean (#1020 wave 3 lane E).
+    let mut dir = std::env::current_dir().expect("a current directory");
+    loop {
+        if dir.join("CONSTITUTION.md").is_file() && dir.join("Cargo.toml").is_file() {
+            return dir;
+        }
+        if !dir.pop() {
+            panic!(
+                "cargo xtask must run inside the repository: no ancestor of the \
+                 current directory carries CONSTITUTION.md and Cargo.toml"
+            );
+        }
+    }
 }
```

A `panic!` rather than a fallback, for the reason the bug demonstrates: a wrong root is worse than no root.
