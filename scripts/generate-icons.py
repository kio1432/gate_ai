#!/usr/bin/env python3
"""Генерация иконок: обрезка прозрачности + максимальное заполнение квадрата."""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "extension" / "icons"
SIZES = (16, 48, 128)
# Минимальный отступ от края (доля стороны), чтобы Chrome не обрезал
PADDING_RATIO = 0.02


def remove_white_bg(img: Image.Image) -> Image.Image:
    """Удалить белый фон с исходника (flood-fill от краёв)."""
    from collections import deque

    im = img.convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_bg(p: tuple[int, int, int, int]) -> bool:
        return p[0] > 225 and p[1] > 225 and p[2] > 225

    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        for y in (0, h - 1):
            if is_bg(px[x, y]):
                q.append((x, y))
                visited[y][x] = True
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(px[x, y]) and not visited[y][x]:
                q.append((x, y))
                visited[y][x] = True

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx] and is_bg(px[nx, ny]):
                visited[ny][nx] = True
                q.append((nx, ny))

    return im


def trim_alpha(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def fit_icon(content: Image.Image, size: int) -> Image.Image:
    pad = max(1, round(size * PADDING_RATIO))
    inner = size - 2 * pad
    cw, ch = content.size
    scale = min(inner / cw, inner / ch)
    nw = max(1, round(cw * scale))
    nh = max(1, round(ch * scale))
    resized = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    raw = ICONS / "ai_ext.png"
    source = ICONS / "icon128.png"
    if raw.exists():
        src = Image.open(raw).convert("RGBA")
        trimmed = trim_alpha(remove_white_bg(src))
    elif source.exists():
        src = Image.open(source).convert("RGBA")
        trimmed = trim_alpha(src)
    else:
        raise SystemExit(f"No source: {raw} or {source}")

    # Апскейл обрезанного контента для более чёткого даунскейла
    upscale = 512
    scale = upscale / max(trimmed.size)
    master = trimmed.resize(
        (max(1, round(trimmed.width * scale)), max(1, round(trimmed.height * scale))),
        Image.LANCZOS,
    )

    for size in SIZES:
        out = fit_icon(master, size)
        out.save(ICONS / f"icon{size}.png", optimize=True)
        bbox = out.getbbox()
        fill = 0
        if bbox:
            fill = round(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / size * 100)
        print(f"icon{size}.png — fill ~{fill}%")

    print("Done:", ICONS)


if __name__ == "__main__":
    main()
