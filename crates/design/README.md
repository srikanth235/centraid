# `crates/design` — identity decisions in Rust

This crate computes identity hue keys, initials and figure tones once for the Rust core. Screen states carry the answer to the native shells; SwiftUI and Compose only look the key up in the generated palette. An imported colour is mapped to the same list palette rather than introducing a second set of colours.

Shared visual values live in [design/tokens.toml](../../design/tokens.toml), and screen compositions in the [mockups](../../design/mockups/README.md). Run `cargo xtask design` to generate native resources and `cargo xtask design --check` to detect drift. The generator is Rust in `crates/xtask/src/design`; design computation has no TypeScript counterpart or parity corpus.

Tests belong beside the Rust behaviour: stable identity for an id, Unicode initials, stored-colour handling, imported colours and figure signs. Money and date strings are finished by the Rust screen layer before they reach a view. A shell does not repeat an identity hash, infer a figure tone or choose a new hue.
