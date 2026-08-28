"""Generate DecisionGuru brand icons with PIL (no SVG rasterizer in this env).
Run: cd backend && uv run python ../scripts/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public"
OUT.mkdir(parents=True, exist_ok=True)

TILE = (17, 23, 37, 255)       # #111725
AZURE = (78, 161, 255, 255)    # #4EA1FF
GOLD = (229, 183, 105, 255)    # #E5B769


def draw(size: int, maskable: bool = False) -> Image.Image:
    S = size * 4  # supersample for clean edges
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 0 if maskable else int(S * 0.06)
    radius = 0 if maskable else int(S * 0.22)
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=TILE)

    m = S * 0.20
    # gold counterfactual baseline (dashed feel via short segments)
    y = S - m
    x = m
    while x < S - m:
        d.line([(x, y), (min(x + S * 0.06, S - m), y)], fill=GOLD, width=max(1, int(S * 0.02)))
        x += S * 0.11
    # ascending value line (azure), zig up to the gold peak node
    pts = [(m, S - m), (S * 0.42, S * 0.56), (S * 0.60, S * 0.66), (S - m, m)]
    d.line(pts, fill=AZURE, width=max(2, int(S * 0.055)), joint="curve")
    # gold peak node
    r = S * 0.055
    px, py = S - m, m
    d.ellipse([px - r, py - r, px + r, py + r], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    draw(180).save(OUT / "apple-touch-icon.png")
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    draw(512, maskable=True).save(OUT / "icon-512-maskable.png")
    ico = draw(256)
    ico.save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
