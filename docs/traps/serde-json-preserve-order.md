# Trap: `serde_json`'s printed text is not a canonical form

## What goes wrong

`serde_json::Value::to_string` prints a JSON object's keys in **insertion order** when the `preserve_order` feature is on and in **name order** when it is off. Neither spelling is wrong; what is wrong is depending on either one.

The feature is not the depending crate's to choose. Cargo unifies features across a build, so one crate anywhere in the graph turning `preserve_order` on turns it on for every crate in that build. In this workspace `agent-client-protocol` does, four crates away through `centraid-assist`.

The consequence, observed under [#1020](https://github.com/srikanth235/centraid/issues/1020) wave 4 (finding PE-F8): a parity suite that sorted a set of rows by each row's printed JSON **passed under `cargo test -p centraid-apps-people` and failed under `cargo test --workspace`**, because the two commands resolved different feature sets for the same source. A green single-crate run is not evidence for the workspace run, and the failure looks like a data bug rather than a build one.

## Correct form

Sort, key, compare and hash a `Value` by a **canonical normal form** you compute, never by `to_string`:

- recurse the value, emitting object keys sorted by name;
- render numbers through one stated spelling (this workspace borrows v0's, `centraid_ontology::jsvalue::js_number_to_string`, so a Rust `1.0` prints `1` as JavaScript does);
- build the key from that.

`crates/apps/kit`'s `canonical_json` is the workspace's one implementation and the generator's `stableJson` is its TypeScript twin; a fixture and a port compare through the same shape. Where a suite must sort, it asserts the property as well as the answer — `the_set_sort_key_does_not_depend_on_the_order_keys_arrive_in` is the guard People's parity suite carries.

## How agents get it wrong

1. **`value.to_string()` as a `BTreeMap` key or a sort key.** The most common shape, and the one that passes locally.
2. **Hashing the printed text** for a digest, a cache key or a fixture id.
3. **Comparing two values by their text** instead of by `==` on the values.
4. **Turning `preserve_order` on "to make it deterministic".** It makes it deterministic per build graph, which is the problem, not the fix. Never turn it off either to route around a failure — the dependency that wants it is entitled to it.
5. **Trusting a single-crate green.** Any claim about JSON ordering has to be re-run under `cargo test --workspace`.

## Checklist

- [ ] No `to_string()` / `format!("{value}")` feeding a sort, a map key, a hash or an equality check
- [ ] Canonical form computed by one shared function, not per call site
- [ ] The property asserted, not only the answer
- [ ] Re-run under `cargo test --workspace`, not only `-p <crate>`

## Related

- [../coding-standards.md](../coding-standards.md)
- [manifest-regeneration.md](manifest-regeneration.md)
