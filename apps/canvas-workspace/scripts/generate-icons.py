#!/usr/bin/env python3
"""Generate PNG and ICO icons from the SVG logo for Pulse Canvas."""

import os
import cairosvg
from PIL import Image
from io import BytesIO

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(BASE_DIR, "build")
RESOURCES_DIR = os.path.join(BASE_DIR, "resources")
SVG_PATH = os.path.join(BUILD_DIR, "icon.svg")

# Electron-builder expects these in build/
# Common sizes for app icons
SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]

def svg_to_png(svg_path: str, output_path: str, size: int):
    """Convert SVG to PNG at a specific size."""
    png_data = cairosvg.svg2png(
        url=svg_path,
        output_width=size,
        output_height=size,
    )
    with open(output_path, "wb") as f:
        f.write(png_data)
    print(f"  Created: {os.path.basename(output_path)} ({size}x{size})")


def create_ico(svg_path: str, output_path: str):
    """Create ICO file with multiple sizes."""
    ico_sizes = [16, 32, 48, 64, 128, 256]
    images = []
    for size in ico_sizes:
        png_data = cairosvg.svg2png(
            url=svg_path,
            output_width=size,
            output_height=size,
        )
        img = Image.open(BytesIO(png_data))
        images.append(img)

    # Save as ICO with all sizes
    images[0].save(
        output_path,
        format="ICO",
        sizes=[(img.width, img.height) for img in images],
        append_images=images[1:],
    )
    print(f"  Created: {os.path.basename(output_path)} (multi-size ICO)")


def main():
    os.makedirs(BUILD_DIR, exist_ok=True)
    os.makedirs(RESOURCES_DIR, exist_ok=True)

    print("Generating Pulse Canvas icons from SVG...")
    print()

    # 1. Generate PNGs in build/ (for electron-builder)
    print("[build/] Electron-builder icons:")
    for size in SIZES:
        output = os.path.join(BUILD_DIR, f"icon-{size}x{size}.png")
        svg_to_png(SVG_PATH, output, size)

    # Main icon.png (512x512, electron-builder default)
    svg_to_png(SVG_PATH, os.path.join(BUILD_DIR, "icon.png"), 512)

    # 2. Generate ICO (Windows)
    print()
    print("[build/] Windows ICO:")
    create_ico(SVG_PATH, os.path.join(BUILD_DIR, "icon.ico"))

    # 3. Copy key files to resources/ for runtime use
    print()
    print("[resources/] Runtime resources:")
    svg_to_png(SVG_PATH, os.path.join(RESOURCES_DIR, "icon.png"), 512)
    svg_to_png(SVG_PATH, os.path.join(RESOURCES_DIR, "icon@2x.png"), 1024)

    # Tray icon (smaller, for system tray)
    for size in [16, 32]:
        svg_to_png(SVG_PATH, os.path.join(RESOURCES_DIR, f"tray-{size}x{size}.png"), size)

    print()
    print("Done! All icons generated successfully.")


if __name__ == "__main__":
    main()
