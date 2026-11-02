# serde and JSON

Open this when adding a `Serialize`/`Deserialize` type or parsing JSON. Pack rules: the `serde-` files in [rules-index.md](rules-index.md). The protobuf wire is separate: [protobuf-prost.md](protobuf-prost.md).

## How the tree does it

| Fact | Where |
| --- | --- |
| `serde_json` is built with **`float_roundtrip`**, not optional: the default float parser can land one ULP away, and a stored REAL then comes back different. Do not remove the feature | root `Cargo.toml`, `crates/vault/tests/properties.rs` |
| A `serde_json::Value`'s printed text is not canonical: `preserve_order` unifies across a build, so one crate's feature decides another crate's key order. Never hash or sign the text of a `Value`; use the canonicalizer | [traps/serde-json-preserve-order.md](../../../../docs/traps/serde-json-preserve-order.md), `crates/vault/src/canonical.rs`, `crates/ontology/src/jsvalue.rs` (ECMAScript number spelling) |
| Wire structs use `#[serde(deny_unknown_fields)]` where a stray key is a bug (`crates/vault/src/backup/snapshot.rs`, `crates/assist-llama/src/wire.rs`) and `rename_all` to match the external spelling (`crates/gateway/src/rules/{wire,code}.rs`) |  |
| `#[serde(default)]` is used for optional fields (about 14 sites); one kept only for an older peer is tagged `COMPAT(name): ...` | [docs/protocol.md](../../../../docs/protocol.md#c2--compatname-tagging) |
| The gateway's rules module is described by serde types and a conformance suite, with no I/O | `crates/gateway/src/rules` |

## Always

- Parse into a typed struct at the boundary ([api-parse-dont-validate](rules/api-parse-dont-validate.md)); do not carry a `Value` inward.
- `deny_unknown_fields` on an input whose senders you control; leave it off on a type that must tolerate a newer peer, and say which in a comment.
- `rename_all` once on the container; `rename` only for an exception.
- Round-trip test any type that is stored or crosses a version boundary, with a property test where the domain is wide ([testing.md](testing.md)).
- Use `try_from` to validate while deserializing a constrained value ([serde-try-from-validate](rules/serde-try-from-validate.md)).

## Never

- `#[serde(untagged)]` for a wire type whose variants overlap; tag the enum ([serde-enum-representation](rules/serde-enum-representation.md)).
- Float equality on a deserialized value as identity; compare the canonical text or the exact bits.
- Untagged back-compat defaults that nothing will ever remove.
