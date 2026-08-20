{
  description = "boop - persistent event-driven single-user AI agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        nodejs = pkgs.nodejs_26;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            nodejs
            pkgs.typescript-language-server
          ];
        };

        # `nix flake check` runs `tsc --noEmit` against the sources using
        # dependencies resolved from package-lock.json via importNpmLock.
        # No hash is specified here: importNpmLock relies on the integrity
        # hashes already present in package-lock.json.
        checks.typecheck = pkgs.buildNpmPackage {
          pname = "boop";
          version = "0.1.0";
          src = ./.;
          inherit nodejs;

          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          dontNpmBuild = true;

          buildPhase = ''
            runHook preBuild
            npx tsc --noEmit
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            runHook postInstall
          '';
        };
      }
    );
}
