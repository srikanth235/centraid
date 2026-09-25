# THE DEV SHELL for the v1 tree (#1020). `nix develop` puts every toolchain the
# repository builds with on PATH, at the version this file and
# `rust-toolchain.toml` name.
#
# WHAT THIS PINS: rustc/cargo/rustfmt/clippy (read out of ./rust-toolchain.toml,
# so the channel is stated once and this file holds no second copy of it),
# cargo-nextest, cargo-deny, cargo-audit, cbindgen, buf, protobuf, sqlite, mold,
# sccache, the JDK/Kotlin/Gradle triple for the KMP shared module, Bun, Node and
# git.
#
# WHAT THIS DOES NOT PIN, and is not a gap to be quietly filled:
#   * The Android SDK and NDK. nixpkgs' `androidenv` needs accepted licences and
#     a composition per API level; wave 3 lane E owns it, and until then the
#     Android side is the host's SDK plus Gradle's own toolchain resolution.
#   * Xcode. Nix cannot install it. `/.xcode-version` is the version file, read
#     by the macOS runner and by `xcode-select`, and lane E confirms the version
#     against the first real iOS build.
#   * The gateway as a package. This is a `devShells` flake, NOT an installable
#     derivation — the #504 packaging stub it replaces said the same and the
#     reason is unchanged: a FOD/bun2nix build waits on the native-module pins
#     (sharp / wasm-vips / node:sqlite / iroh) being packaging-stable, and
#     `scripts/gateway-package/` plus `deploy/docker/gateway-v0.Dockerfile`
#     remain the paths that do
#     build and smoke the v0 gateway. The OS unit writer stays single-writer: a
#     host service module must call `centraid-gateway service install` rather
#     than invent a second unit path (docs/config-ownership.md).
#
# THIS FILE HAS NOT BEEN EVALUATED. `nix` is not installed on the container wave
# 1 was built on, so `nix flake check` has not run and the wave 1 receipt says
# so rather than implying otherwise. The first evaluation on a machine that has
# nix is what confirms it.

{
  description = "Centraid v1 development shell — every toolchain but Xcode and the Android SDK (#1020)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        }));
    in
    {
      devShells = forAllSystems (pkgs:
        let
          # One line, one source of truth: the channel, the profile and the
          # components come from ./rust-toolchain.toml, which the gate
          # workflows' toolchain step also reads. A second literal version here
          # is exactly how the two would drift.
          rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        in
        {
          default = pkgs.mkShell {
            name = "centraid-v1";

            packages = [
              rust

              # The Rust tooling `cargo xtask gate` shells out to. cargo-nextest
              # is optional to the runner (it falls back to `cargo test` and
              # says which one ran); cargo-deny is required in CI.
              pkgs.cargo-nextest
              pkgs.cargo-deny
              pkgs.cargo-audit
              # The five-symbol C ABI's header generator (wave 2 lane D).
              pkgs.cbindgen

              # The two protobuf packages and their breaking-change checks.
              pkgs.buf
              pkgs.protobuf

              # Plain SQLite: no SQLCipher, per the ruling. `rusqlite` is built
              # with the `bundled` feature, so this is for the `sqlite3` shell
              # and for reading a vault by hand.
              pkgs.sqlite

              # "Compile time is the new Hermes" — the two structural answers
              # that are only a binary on PATH.
              pkgs.mold
              pkgs.sccache

              # The KMP shared module (wave 3 lane E).
              pkgs.jdk21
              pkgs.kotlin
              pkgs.gradle

              # The v0 tree, which stays the pinned oracle until wave 6, and the
              # `ts-static` and `v0-oracle` gate steps that drive it.
              pkgs.bun
              pkgs.nodejs_22

              pkgs.git
              pkgs.curl
              pkgs.jq
            ]
            # Maestro is the mobile flow runner (#890). It is not in nixpkgs on
            # every system, so it is added where it exists and installed by hand
            # elsewhere; wave 3 lane E is where that stops being a footnote.
            ++ pkgs.lib.optional (pkgs.lib.hasAttr "maestro" pkgs) pkgs.maestro
            # Darwin-only extras. `xcbuild` is the command-line half only — the
            # real Xcode is pinned by /.xcode-version, not by nix.
            ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
              pkgs.xcbuild
              pkgs.cocoapods
            ];

            shellHook = ''
              echo "centraid v1 dev shell — $(rustc --version)"
              echo "  cargo xtask gate --profile local   # the edit-run loop"
              echo "  Xcode is NOT pinned here: see /.xcode-version"
              echo "  the Android SDK is NOT pinned here: wave 3 lane E owns it"
            '';
          };
        });
    };
}
