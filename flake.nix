# Gateway-only reproducible package path (issue #504 packaging Phase D).
# Not a full monorepo devShell — day-to-day remains Bun/turbo.
# Host service modules should call/replicate `centraid-gateway service install`
# output (single writer — docs/config-ownership.md), not invent a second unit path.

{
  description = "Centraid gateway packaging (gateway-only)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs: {
        # Placeholder derivation documenting the install set. Real FOD/bun2nix
        # translation is follow-on once Phase A native-module pins are stable.
        centraid-gateway-docs = pkgs.writeTextFile {
          name = "centraid-gateway-packaging-notes";
          text = ''
            Centraid gateway packaging (#504)
            - Runtime closure: scripts/gateway-package/trace.mjs
            - Smoke: scripts/gateway-package/smoke.mjs
            - Docker: ./Dockerfile
            - OS unit writer: centraid-gateway service install (only)
            - Native modules: sharp / wasm-vips / node:sqlite / iroh — see trace JSON
          '';
        };
        default = self.packages.${pkgs.system}.centraid-gateway-docs;
      });

      # NixOS module deferred until flake install set is FOD-complete; templates
      # from `centraid-gateway service install --dry-run` are the H5 path today.
    };
}
