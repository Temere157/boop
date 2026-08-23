# boop task recipes.

# List available recipes (default).
default:
    @just --list

# Regenerate the derived webui PWA icons from the committed maskable base PNG.
# Helper only: all icons are committed, so run this just when plugins/webui/src/icon-512-maskable.png changes.
# Requires `magick`, provided by the nix devShell (`nix develop`).
# The `any`-purpose icons get a squircle alpha cut; the maskable and Apple touch icons stay full-bleed squares and are cropped by the platform.
webui-icons:
    magick plugins/webui/src/icon-512-maskable.png -resize 192x192 \
        \( -size 192x192 xc:black -fill white \
           -draw "path 'M 192,96 C 192,24 168,0 96,0 C 24,0 0,24 0,96 C 0,168 24,192 96,192 C 168,192 192,168 192,96 Z'" \) \
        -alpha off -compose CopyOpacity -composite \
        plugins/webui/src/icon-192.png
    magick plugins/webui/src/icon-512-maskable.png \
        \( -size 512x512 xc:black -fill white \
           -draw "path 'M 512,256 C 512,64 448,0 256,0 C 64,0 0,64 0,256 C 0,448 64,512 256,512 C 448,512 512,448 512,256 Z'" \) \
        -alpha off -compose CopyOpacity -composite \
        plugins/webui/src/icon-512.png
    magick plugins/webui/src/icon-512-maskable.png -resize 180x180 plugins/webui/src/apple-touch-icon.png
