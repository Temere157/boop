# boop task recipes.

# List available recipes (default).
default:
    @just --list

# Generate the webui PWA icons (PNG) from the source SVG.
# Run once after checkout, or whenever plugins/webui/src/icon.svg changes, before serving the webui.
# Requires `resvg`, provided by the nix devShell (`nix develop`).
webui-icons:
    resvg -w 192 -h 192 plugins/webui/src/icon.svg plugins/webui/src/icon-192.png
    resvg -w 512 -h 512 plugins/webui/src/icon.svg plugins/webui/src/icon-512.png
    resvg -w 512 -h 512 plugins/webui/src/icon.svg plugins/webui/src/icon-512-maskable.png
    resvg -w 180 -h 180 plugins/webui/src/icon.svg plugins/webui/src/apple-touch-icon.png
