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

        # Same shape as `typecheck`, but runs `tsc -p plugins` against the
        # `plugins/` project — the erasable-syntax-only, directly-loaded
        # plugins (see plugins/tsconfig.json). `noEmit` lives in the config
        # because `tsc -p` cannot be combined with `--noEmit`.
        checks.typecheck-plugins = pkgs.buildNpmPackage {
          pname = "boop";
          version = "0.1.0";
          src = ./.;
          inherit nodejs;

          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          dontNpmBuild = true;

          buildPhase = ''
            runHook preBuild
            npx tsc -p plugins
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            runHook postInstall
          '';
        };

        # Same shape as `typecheck-plugins`, but runs `tsc -p plugins/webui`
        # against the browser-side webui sources — the DOM-lib,
        # no-`@types/node` project under `plugins/webui/` (see
        # plugins/webui/tsconfig.json). Browser code is separate from the
        # server entry so it can use `document` (DOM lib) without the
        # node-only `plugins/tsconfig.json` rejecting it.
        checks.typecheck-webui = pkgs.buildNpmPackage {
          pname = "boop";
          version = "0.1.0";
          src = ./.;
          inherit nodejs;

          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          dontNpmBuild = true;

          buildPhase = ''
            runHook preBuild
            npx tsc -p plugins/webui
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
