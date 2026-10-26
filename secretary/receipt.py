"""Receipt images for claims: upright, trimmed to the paper, small enough to keep.

A photo of a receipt is usually a white slip on something darker or coloured.
`prepare` turns the photo upright (EXIF), finds the slip (the largest bright and
colourless region, after an Otsu threshold on a small copy; on a grey background,
the largest bright one) and crops to it with a little margin, leaving out thin
strays joined to it. Shadows across the paper and pale floors still fool it at
times: the bot checks every result and crops by hand when needed. On a pale
background, or for a scan, it crops to the printed content instead. A PDF
receipt is rendered to an image first (its pages stacked, up to three), so every
receipt in a claim pack is one picture on one page.

Guards: if the crop would keep under 12% of the image, or would barely change
it, the image is kept whole. The bot looks at the result (`claims.py add` writes
a preview) and can redo it with --crop or --no-trim.

  receipt.py IN [OUT.jpg] [--crop x0,y0,x1,y1] [--no-trim]   try it on one file; prints what it did
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

MAX_SIDE = 1800
MAX_BYTES = 2_800_000
MARGIN = 0.015


def _otsu(gray: np.ndarray) -> int:
    hist = np.bincount(gray.ravel(), minlength=256).astype(float)
    total = gray.size
    cum = np.cumsum(hist)
    mean = np.cumsum(hist * np.arange(256))
    best, t_best = -1.0, 128
    for t in range(1, 255):
        w0, w1 = cum[t], total - cum[t]
        if w0 == 0 or w1 == 0:
            continue
        m0, m1 = mean[t] / w0, (mean[-1] - mean[t]) / w1
        between = w0 * w1 * (m0 - m1) ** 2
        if between > best:
            best, t_best = between, t
    return t_best


def _shift_all(m: np.ndarray, fn) -> np.ndarray:
    """Combine a mask with its 8 neighbours (3x3), edges padded as background."""
    p = np.pad(m, 1, constant_values=False)
    out = p[1:-1, 1:-1].copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy or dx:
                out = fn(out, p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx])
    return out


def _open(m: np.ndarray, n: int) -> np.ndarray:
    """Morphological opening (erode n times, then dilate n times): drops specks and thin bridges."""
    for _ in range(n):
        m = _shift_all(m, np.logical_and)
    for _ in range(n):
        m = _shift_all(m, np.logical_or)
    return m


def _largest_region(m: np.ndarray) -> np.ndarray | None:
    """The largest 4-connected True region of a mask, as its own mask. numpy only."""
    from collections import deque
    h, w = m.shape
    seen = np.zeros_like(m, dtype=bool)
    best, best_px = 0, None
    ys, xs = np.nonzero(m)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if seen[y, x]:
            continue
        seen[y, x] = True
        q = deque([(y, x)])
        px = []
        while q:
            cy, cx = q.popleft()
            px.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(px) > best:
            best, best_px = len(px), px
    if not best_px:
        return None
    out = np.zeros_like(m, dtype=bool)
    yy, xx = zip(*best_px)
    out[list(yy), list(xx)] = True
    return out


def _dense_box(region: np.ndarray, frac: float = 0.5) -> tuple[int, int, int, int]:
    """The region's box, leaving out strays joined to the paper (a white bag, a
    pale strip of floor): the longest run of rows, and of columns, where the
    region is at least `frac` as wide as it usually is. Width is first to last
    pixel, so lines of print across the paper don't count as gaps."""
    def extent(m: np.ndarray) -> np.ndarray:
        any_ = m.any(1)
        first = np.argmax(m, 1)
        last = m.shape[1] - 1 - np.argmax(m[:, ::-1], 1)
        return np.where(any_, last - first + 1, 0)

    def span(counts: np.ndarray) -> tuple[int, int]:
        full = np.percentile(counts[counts > 0], 90)
        best, run, start = None, 0, 0
        for i, ok in enumerate((counts >= frac * full).tolist() + [False]):
            if ok:
                if run == 0:
                    start = i
                run += 1
            elif run:
                if best is None or run > best[1] - best[0]:
                    best = (start, start + run)
                run = 0
        return best or (0, len(counts))
    y0, y1 = span(extent(region))
    x0, x1 = span(extent(region.T))
    return x0, y0, x1, y1


def _solidity(region: np.ndarray, box: tuple[int, int, int, int]) -> float:
    """How much of the box the region fills, row by row from first to last pixel:
    near 1 for a sheet of paper, lower for a ragged patch of background."""
    x0, y0, x1, y1 = box
    sub = region[y0:y1, x0:x1]
    if not sub.size:
        return 0.0
    any_ = sub.any(1)
    first = np.argmax(sub, 1)
    last = sub.shape[1] - 1 - np.argmax(sub[:, ::-1], 1)
    return float(np.where(any_, last - first + 1, 0).sum() / sub.size)


def _whiteness(rgb: np.ndarray) -> np.ndarray:
    """Bright and colourless scores high: paper. Beige tiles, wood, skin and plants
    are bright too but coloured, so they score low."""
    a = rgb.astype(np.int16)
    mx, mn = a.max(2), a.min(2)
    return np.clip(mn - 2 * (mx - mn), 0, 255).astype(np.uint8)


def _slip(score: np.ndarray) -> tuple[tuple[float, float, float, float], float] | None:
    """The paper's box as fractions, and how solidly the region fills it, from a
    score map where paper is high."""
    bright = score > _otsu(score)
    if bright.mean() >= 0.85:
        return None
    region = _largest_region(_open(bright, 2))
    if region is None:
        return None
    h, w = score.shape
    box = _dense_box(region)
    x0, y0, x1, y1 = box
    return (x0 / w, y0 / h, x1 / w, y1 / h), _solidity(region, box)


def find_box(img: Image.Image) -> tuple[tuple[float, float, float, float], str]:
    """The receipt's box as fractions (x0, y0, x1, y1) of the image, and how it was found."""
    small = img.convert("RGB")
    scale = 500 / max(small.size)
    if scale < 1:
        small = small.resize((max(1, round(small.width * scale)), max(1, round(small.height * scale))))
    rgb = np.asarray(small, dtype=np.uint8)
    g = np.asarray(small.convert("L"), dtype=np.uint8)
    h, w = g.shape
    t = _otsu(g)
    # Receipts are white paper; tables, floors, hands and plants are coloured even
    # when they are pale. So first the largest bright and colourless region; on a
    # grey background, where that takes in nearly everything, the largest bright one.
    for score, how in ((_whiteness(rgb), "slip"), (g, "slip (by brightness)")):
        r = _slip(score)
        if r and 0.08 <= (r[0][2] - r[0][0]) * (r[0][3] - r[0][1]) <= 0.85 and r[1] >= 0.75:
            return r[0], how
    # a pale background or a scan: the printed content
    dark = g < min(t, 200) - 20
    if dark.sum() < 20:
        return (0.0, 0.0, 1.0, 1.0), "whole"
    ys, xs = np.nonzero(dark)
    return (xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h), "content"


def _from_pdf(raw: bytes) -> Image.Image:
    import pymupdf
    doc = pymupdf.open(stream=raw, filetype="pdf")
    pages = []
    for page in list(doc)[:3]:
        pix = page.get_pixmap(dpi=170)
        pages.append(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
    if not pages:
        raise ValueError("empty PDF")
    w = max(p.width for p in pages)
    out = Image.new("RGB", (w, sum(p.height for p in pages)), "white")
    y = 0
    for p in pages:
        out.paste(p, (0, y))
        y += p.height
    return out


def _encode(img: Image.Image) -> bytes:
    img = img.convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE))
    for q in (85, 75, 65, 55):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True)
        if buf.tell() <= MAX_BYTES:
            return buf.getvalue()
        img.thumbnail((int(img.width * 0.8), int(img.height * 0.8)))
    return buf.getvalue()


def prepare(raw: bytes, mime: str, crop: tuple[float, float, float, float] | None = None, trim: bool = True) -> tuple[bytes, dict]:
    """A receipt file's bytes -> (JPEG bytes, what was done)."""
    if mime == "application/pdf" or raw[:5] == b"%PDF-":
        img, src = _from_pdf(raw), "pdf"
    else:
        img, src = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB"), "photo"
    info = {"from": src, "size": list(img.size), "cropped": False, "how": "kept whole"}
    if crop:
        box, how = crop, "by hand"
    elif trim:
        box, how = find_box(img)
    else:
        box, how = (0.0, 0.0, 1.0, 1.0), "kept whole"
    x0, y0, x1, y1 = (max(0.0, box[0] - MARGIN), max(0.0, box[1] - MARGIN), min(1.0, box[2] + MARGIN), min(1.0, box[3] + MARGIN))
    area = (x1 - x0) * (y1 - y0)
    if crop or (0.12 <= area <= 0.95):
        img = img.crop((round(x0 * img.width), round(y0 * img.height), round(x1 * img.width), round(y1 * img.height)))
        info.update(cropped=True, how=how, box=[round(float(v), 3) for v in (x0, y0, x1, y1)], kept=round(float(area), 2))
    elif area < 0.12:
        info["how"] = "kept whole (the receipt looked too small to trust the crop)"
    return _encode(img), info


def parse_crop(s: str | None) -> tuple[float, float, float, float] | None:
    if not s:
        return None
    v = tuple(float(x) for x in s.split(","))
    if len(v) != 4 or not (0 <= v[0] < v[2] <= 1 and 0 <= v[1] < v[3] <= 1):
        raise SystemExit("--crop is x0,y0,x1,y1 as fractions of the image, e.g. 0.1,0.05,0.8,0.97")
    return v


if __name__ == "__main__":
    import argparse
    import mimetypes
    ap = argparse.ArgumentParser(description="Try receipt trimming on one file.")
    ap.add_argument("src")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--crop")
    ap.add_argument("--no-trim", action="store_true")
    a = ap.parse_args()
    src = Path(a.src)
    out = Path(a.out) if a.out else src.with_suffix(".receipt.jpg")
    data, info = prepare(src.read_bytes(), mimetypes.guess_type(src.name)[0] or "", parse_crop(a.crop), not a.no_trim)
    out.write_bytes(data)
    print(out, info)
