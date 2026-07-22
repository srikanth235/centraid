# STUB — not a real gateway package (issue #504 packaging Phase D).
# Documents the install path only. No FOD/bun2nix derivation yet; do not
# `nix run` expecting a daemon. Day-to-day remains Bun/turbo.
# Host service modules must call/replicate `centraid-gateway service install`
# (single writer — docs/config-ownership.md), not invent a second unit path.

{
  description = "Centraid gateway packaging notes (stub — not an installable derivation)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs: {
        # Placeholder text only. Real FOD/bun2nix is follow-on once native-module
        # pins (sharp / wasm-vips / node:sqlite / iroh) are packaging-stable.
        centraid-gateway-docs = pkgs.writeTextFile {
          name = "centraid-gateway-packaging-notes";
          text = ''
            Centraid gateway packaging (#504) — STUB flake
            - Runtime closure: scripts/gateway-package/trace.mjs
            - Host smoke: scripts/gateway-package/smoke.mjs
            - Container smoke: smoke.mjs --base-url … (CI builds ./Dockerfile)
            - Docker: ./Dockerfile (bind-mount host path or named volume at /data)
            - OS unit writer: centraid-gateway service install (only)
            - Native modules: sharp / wasm-vips / node:sqlite / iroh — see trace JSON
            This flake does NOT build or run the gateway yet.
          '';
        };
        default = self.packages.${pkgs.system}.centraid-gateway-docs;
      });

      # NixOS module deferred until flake install set is FOD-complete; templates
      # from `centraid-gateway service install --dry-run` are the H5 path today.
    };
}
