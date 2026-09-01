#!/usr/bin/env python3
"""Generate WaaS MCP bundle icons (YC-orange briefcase mark)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "icons"
YC_ORANGE = (242, 101, 34)
WHITE = (255, 255, 255)
DARK_BG = (24, 24, 27)


def draw_mark(size: int, bg: tuple[int, int, int] | None, fg: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = max(2, size // 16)
    radius = max(4, size // 6)

    if bg is not None:
        draw.rounded_rectangle((pad, pad, size - pad, size - pad), radius=radius, fill=bg + (255,))

    body_pad = size * 0.22
    body_top = size * 0.36
    body_bottom = size * 0.78
    draw.rounded_rectangle(
        (body_pad, body_top, size - body_pad, body_bottom),
        radius=max(2, size // 24),
        fill=fg + (255,),
    )

    handle_w = size * 0.28
    handle_h = size * 0.14
    handle_left = (size - handle_w) / 2
    handle_top = body_top - handle_h * 0.75
    draw.rounded_rectangle(
        (handle_left, handle_top, handle_left + handle_w, body_top),
        radius=max(2, size // 32),
        fill=fg + (255,),
    )

    latch_w = size * 0.12
    latch_h = size * 0.08
    latch_left = (size - latch_w) / 2
    latch_top = (body_top + body_bottom - latch_h) / 2
    draw.rounded_rectangle(
        (latch_left, latch_top, latch_left + latch_w, latch_top + latch_h),
        radius=max(1, size // 64),
        fill=bg + (255,) if bg else (30, 30, 30, 255),
    )

    return img


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)

    master = draw_mark(512, YC_ORANGE, WHITE)
    master.save(ROOT / "icon.png")

    draw_mark(16, YC_ORANGE, WHITE).save(ASSETS / "icon-16-light.png")
    draw_mark(16, None, YC_ORANGE).save(ASSETS / "icon-16-dark.png")
    draw_mark(48, YC_ORANGE, WHITE).save(ASSETS / "icon-48-light.png")
    draw_mark(48, DARK_BG, WHITE).save(ASSETS / "icon-48-dark.png")

    print("Wrote icon.png and assets/icons/*")


if __name__ == "__main__":
    main()
