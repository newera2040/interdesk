#!/usr/bin/env python3
"""Generate the Home Screen icon set for InterDesk.

Run once from the interdesk directory (or anywhere; paths are script-relative):

    python3 tools/make_icons.py

Outputs into interdesk/icons/. The PNGs are committed, keeping the app
zero-build: this script exists so the icons are reproducible, not because
anything runs it at deploy time.

Design: the editorial "ID" monogram — serif, warm off-white on warm near-black
ink — matching the inline SVG favicon in index.html. Rendered at 1024 and
LANCZOS-downsampled so the 180/192 sizes stay crisp; iOS composites
transparency onto black, so the background is opaque ink.
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")

INK = (21, 23, 27)        # --paper #15171b
GLYPH = (232, 230, 225)   # --ink #e8e6e1
MASTER = 1024

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/NewYork.ttf",
]


def load_font(px):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
    sys.exit("No serif font found; add a .ttf path to FONT_CANDIDATES")


def master(glyph_ratio):
    """Ink square with a serif ID whose height spans glyph_ratio of the canvas."""
    img = Image.new("RGB", (MASTER, MASTER), INK)
    draw = ImageDraw.Draw(img)
    font = load_font(int(MASTER * glyph_ratio))
    left, top, right, bottom = draw.textbbox((0, 0), "ID", font=font)
    gw, gh = right - left, bottom - top
    x = (MASTER - gw) / 2 - left
    y = (MASTER - gh) / 2 - top + MASTER * 0.02
    draw.text((x, y), "ID", font=font, fill=GLYPH)
    # a single thin rule above the glyph — the masthead's heavy section rule
    rule_y = int(y) - int(MASTER * 0.07)
    if rule_y > 40:
        draw.rectangle([MASTER * 0.30, rule_y, MASTER * 0.70, rule_y + 12], fill=GLYPH)
    return img


def save(img, size, name, out_dir):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(out_dir, name), "PNG")
    print(f"  {name} ({size}x{size})")


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    print("Writing icons/")

    std = master(0.5)
    save(std, 512, "icon-512.png", out_dir)
    save(std, 192, "icon-192.png", out_dir)
    save(std, 180, "apple-touch-icon.png", out_dir)

    # Maskable: platforms may crop to a circle with a 40%-radius safe zone,
    # so the glyph shrinks to stay inside it.
    save(master(0.36), 512, "icon-512-maskable.png", out_dir)


if __name__ == "__main__":
    main()
