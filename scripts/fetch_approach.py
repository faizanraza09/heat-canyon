#!/usr/bin/env python3
"""Bake the imagery pyramid the opening film descends through.

The film used to stop about 190 km up and cross-fade into the city, because
that is where the 10 km-per-pixel land mask runs out of anything to show. A
cross-fade at that height reads as a cut: the camera arrives, stalls, and the
picture is replaced. What it should read as is one continuous fall.

To fall the whole way you need something to look at the whole way, so this
script bakes a small pyramid of satellite mosaics centred on the study area —
1900 km across down to 7 km across, each one taking over as the last runs out
of resolution — plus a basemap for the application's own ground plane, so the
frame the film hands over is the frame the application is already drawing.

Imagery: Esri World Imagery (Esri, Maxar, Earthstar Geographics). Public,
key-free, and credited on screen in the film's last chapter.

    python scripts/fetch_approach.py            # writes web/data/approach/

Each mosaic is resampled onto a plain lon/lat grid rather than left in Web
Mercator. That costs one bilinear pass and buys two things: the globe patches
are parameterised in exactly the coordinates SphereGeometry already uses, and
the application's flat planes line up with its own equirectangular local frame
without a projection step at runtime.
"""

from __future__ import annotations

import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "data" / "approach"
META = ROOT / "web" / "data" / "meta.json"

ESRI = ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery"
        "/MapServer/tile/{z}/{y}/{x}")

# USGS NAIP: one-metre aerial photography, public domain, flown as a single
# state-wide mosaic per season. Its `exportImage` endpoint returns an arbitrary
# bounding box already in plate carree, which is the grid these mosaics want, so
# for the levels it covers there is no reprojection step at all.
NAIP = ("https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus"
        "/ImageServer/exportImage")

CREDIT = "USGS NAIP · Esri, Maxar, Earthstar Geographics"

TILE = 256

# `span_m` is the full width of the mosaic on the ground and `px` its square
# output size; `zoom` picks a source a little finer than the output, never
# coarser. `app` marks the levels the application also lays on its own ground.
#
# Six levels, each about a third the width of the one above it. Fewer, wider
# steps were tried first and the reason they do not work is worth writing down:
# a level can only be brought up once it is wide enough to cover the frame, and
# a 1024-pixel level that covers the frame exactly is already coarser than the
# screen. So the softness at the *end* of a level's life is the ratio to the
# next one — at a ratio of seven, the shot four hundred kilometres up was a
# blur. The fix is two-part and lives half here and half in film.js: keep the
# ratio near three, and fade each level in at roughly twice the height at which
# it covers the frame, so the sharp region arrives in the middle of the picture
# with a soft border and grows outward. That is also, as it happens, what
# progressive imagery looks like from a real descent.
#
# Two sources, and the split is not arbitrary. Esri's World Imagery is a global
# composite of many captures, and over New York the seam between two of them
# runs straight down the Hudson: at every zoom level it puts a hard, stair-
# stepped step in the water three kilometres from the study area, which is
# squarely in the middle of the shot the whole descent exists to arrive at. NAIP
# is one flight over one state and has no such join — but it is land only, and
# it stops at the coast. So the three wide levels, which are mostly ocean and
# mostly nowhere near the study area, come from Esri, and the three that the eye
# actually lands on come from NAIP, with the sea between NAIP's flight lines
# interpolated rather than borrowed (see `flood_holes`).
LEVELS = [
    {"key": "l0", "span_m": 1_800_000, "src": "esri", "zoom": 6,  "px": 1024},
    {"key": "l1", "span_m":   600_000, "src": "esri", "zoom": 8,  "px": 1024},
    {"key": "l2", "span_m":   200_000, "src": "esri", "zoom": 10, "px": 1024},
    # 2048, not 1024, and this is not about sharpness.
    #
    # NAIP's exportImage picks its source pyramid level from the output
    # resolution asked for, and at 64 km across 1024 pixels — 62 m a pixel — it
    # drops to a level whose sea is assembled from flight lines that do not
    # agree with each other. The land is fine; the water comes back as hard
    # rectangular blocks of slightly different tone, dozens of kilometres
    # across, in the harbour, the Sound and the ocean. On screen, a hundred and
    # thirty kilometres up, that is the whole middle of the frame paved in
    # visible tiles, and it is the single ugliest moment in the descent.
    #
    # Asking for 31 m a pixel keeps it on the level above, where the same sea is
    # uniform. So the doubling buys a clean mosaic rather than a sharper one,
    # and the extra megabyte is the price of the shot not looking like a
    # contact sheet. (Esri is no escape here: its own capture seam runs straight
    # down the Hudson at every zoom, and at this width that seam is frame
    # centre.)
    {"key": "l3", "span_m":    64_000, "src": "naip", "px": 2048},
    # l4 is also the application's backdrop plane, which scene.js sizes at
    # 18.6 km square for this descent, so the two are the same rectangle.
    {"key": "l4", "span_m":    18_600, "src": "naip", "px": 2048, "app": True},
    {"key": "l5", "span_m":     7_000, "src": "naip", "px": 2048, "app": True},
]


def merc(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Web Mercator tile coordinates (fractional) for a lon/lat."""
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(max(-85.05, min(85.05, lat))))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def fetch_mosaic(z: int, x0: int, x1: int, y0: int, y1: int) -> np.ndarray:
    """Download a rectangle of tiles and stitch it into one RGB array."""
    n = 2 ** z
    w, h = (x1 - x0 + 1), (y1 - y0 + 1)
    out = np.zeros((h * TILE, w * TILE, 3), dtype=np.uint8)
    sess = requests.Session()
    sess.headers["User-Agent"] = "heatcanyon/1.0 (opening film imagery bake)"

    def one(job):
        ty, tx = job
        url = ESRI.format(z=z, y=ty, x=tx % n)
        for attempt in range(4):
            try:
                r = sess.get(url, timeout=30)
                if r.status_code == 200:
                    im = Image.open(io.BytesIO(r.content)).convert("RGB")
                    return job, np.asarray(im)
            except Exception:
                pass
        print(f"  ! missing tile z{z} {tx},{ty}", file=sys.stderr)
        return job, None

    jobs = [(ty, tx) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
    done = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        for (ty, tx), arr in pool.map(one, jobs):
            done += 1
            if arr is not None:
                r0 = (ty - y0) * TILE
                c0 = (tx - x0) * TILE
                out[r0:r0 + TILE, c0:c0 + TILE] = arr
            if done % 24 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)} tiles", end="\r", flush=True)
    print()
    return out


def bilinear(src: np.ndarray, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """Sample `src` at fractional pixel coordinates, clamped at the edges."""
    h, w = src.shape[:2]
    x0 = np.clip(np.floor(px).astype(np.int64), 0, w - 1)
    y0 = np.clip(np.floor(py).astype(np.int64), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = (px - x0)[..., None]
    fy = (py - y0)[..., None]
    a = src[y0, x0].astype(np.float32)
    b = src[y0, x1].astype(np.float32)
    c = src[y1, x0].astype(np.float32)
    d = src[y1, x1].astype(np.float32)
    top = a + (b - a) * fx
    bot = c + (d - c) * fx
    return np.clip(top + (bot - top) * fy, 0, 255).astype(np.uint8)


def fetch_naip(west: float, south: float, east: float, north: float,
               size: int) -> Image.Image:
    """One NAIP export, already on a plate carree grid of exactly this box."""
    params = {
        "bbox": f"{west},{south},{east},{north}",
        "bboxSR": "4326", "imageSR": "4326",
        "size": f"{size},{size}",
        "format": "jpg", "f": "image",
    }
    # The service 502s under load often enough that a bare request is not a
    # reliable build step; it recovers within a few seconds every time.
    last = None
    for attempt in range(6):
        try:
            r = requests.get(NAIP, params=params, timeout=240)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                return Image.open(io.BytesIO(r.content)).convert("RGB")
            last = f"{r.status_code} {r.text[:120]}"
        except Exception as e:                       # noqa: BLE001 - report and retry
            last = repr(e)
        print(f"  retrying NAIP ({last})")
        time.sleep(3 + attempt * 4)
    raise RuntimeError(f"NAIP export failed: {last}")


def esri_grid(west: float, east: float, south: float, north: float,
              size: int, z: int, lon0: float, lat0: float) -> np.ndarray:
    """An Esri mosaic resampled onto the same plain lon/lat grid."""
    xs, ys = zip(*(merc(lo, la, z) for lo in (west, east) for la in (south, north)))
    x0, x1 = int(math.floor(min(xs))) - 1, int(math.floor(max(xs))) + 1
    y0, y1 = int(math.floor(min(ys))) - 1, int(math.floor(max(ys))) + 1
    y0, y1 = max(0, y0), min(2 ** z - 1, y1)
    mosaic = fetch_mosaic(z, x0, x1, y0, y1)

    u = (np.arange(size, dtype=np.float64) + 0.5) / size
    lons = west + (east - west) * u
    lats = north - (north - south) * u
    mx = np.array([merc(lo, lat0, z)[0] for lo in lons]) * TILE - x0 * TILE
    my = np.array([merc(lon0, la, z)[1] for la in lats]) * TILE - y0 * TILE
    return bilinear(mosaic,
                    np.repeat(mx[None, :], size, axis=0),
                    np.repeat(my[:, None], size, axis=1))


def flood_holes(img: np.ndarray, hole: np.ndarray) -> np.ndarray:
    """Close NAIP's voids by interpolating the water around them.

    NAIP is flown over land and stops at the coast, so any box wide enough to
    reach open water comes back with square black voids in it — a tenth of the
    64 km level is ocean it never photographed.

    This used to be filled from Esri, colour-matched to the water immediately
    around each void, and that was the wrong idea however carefully it was
    graded. Two imagery programmes disagree about the colour of water by more
    than any linear match can close: the sea is not a flat colour, it is a
    gradient of depth, sediment and sun glint that differs between the two
    captures, so the patch lands as a rectangle of *slightly the wrong sea* with
    four hard edges. On screen, sixty kilometres up, the bottom third of the
    frame was a patchwork of tan and green rectangles in the Atlantic — the same
    complaint as the flight lines it was meant to fix, one source further down.

    So nothing is pasted in. The holes are filled by pushing the surrounding
    water inward: a normalised Gaussian — the blur of the known pixels divided
    by the blur of the mask — evaluated at whatever radius is wide enough to
    reach across, coarsest last, so a pixel takes the finest estimate that has
    any real data behind it. What comes out is a smooth gradient continuous with
    the sea at every edge, and at 31 metres a pixel that is what open ocean
    looks like anyway. It is stated plainly because it should be: between the
    flight lines the sea in this mosaic is interpolated, not photographed. It
    carries no measurement and nothing in the study is derived from it.

    Diffusing from the *nearest* water was tried in between and streaks: along a
    straight coast the nearest water is the darker inshore kind, so the sea came
    out with dark fingers reaching south off Long Island. The difference is that
    a normalised blur is an average over a whole neighbourhood rather than a
    march inward from the boundary.
    """
    # The service returns JPEG, so the edge of a void rings out to twenty-odd
    # rather than to zero, and a threshold of eight leaves a dark fringe of
    # ringing that then reads as real water. The threshold is generous and the
    # mask is dilated a little to swallow it.
    size = img.shape[0]
    hole = gaussian_filter(hole.astype(np.float32), max(1.5, size / 512),
                           mode="nearest") > 0.25
    if hole.mean() < 0.0008:
        return img

    print(f"  interpolating {hole.mean()*100:.1f}% nodata from the surrounding water")
    src = img.astype(np.float32)
    known = (~hole).astype(np.float32)
    masked = src * known[..., None]

    out = src.copy()
    todo = hole.copy()
    for sigma in (6, 12, 24, 48, 96, 192, 384, 768):
        if not todo.any():
            break
        den = gaussian_filter(known, sigma, mode="nearest")
        # Below about two per cent coverage the ratio is dividing noise by
        # noise; those pixels wait for a wider radius rather than taking it.
        ok = todo & (den > 0.02)
        if not ok.any():
            continue
        for c in range(3):
            num = gaussian_filter(masked[..., c], sigma, mode="nearest")
            out[..., c][ok] = (num / np.maximum(den, 1e-6))[ok]
        todo &= ~ok

    # Feather the seam. The interpolation is continuous with the sea by
    # construction, but the mask edge is not: it was dilated past the ringing,
    # so a few pixels of real water inside it are being replaced by an estimate
    # of themselves. Crossing over gradually hides the join.
    w = gaussian_filter(hole.astype(np.float32), max(2.0, size / 400),
                        mode="nearest")[..., None]
    out = src * (1 - w) + out * w
    return np.clip(out, 0, 255).astype(np.uint8)


def build(level: dict, lon0: float, lat0: float,
          m_lon: float, m_lat: float) -> dict:
    span = level["span_m"]
    size = level["px"]
    z = level.get("zoom")
    dlon = (span / 2.0) / m_lon
    dlat = (span / 2.0) / m_lat
    west, east = lon0 - dlon, lon0 + dlon
    south, north = lat0 - dlat, lat0 + dlat

    if level["src"] == "naip":
        print(f"{level['key']}: {span/1000:.1f} km across, NAIP, {size}px")
        arr = np.asarray(fetch_naip(west, south, east, north, size))
        img = Image.fromarray(flood_holes(arr, arr.max(axis=2) < 26))
    else:
        print(f"{level['key']}: {span/1000:.0f} km across, esri z{z}, {size}px")
        img = Image.fromarray(esri_grid(west, east, south, north, size, z, lon0, lat0))

    name = f"{level['key']}.jpg"
    # The coarse levels are a few hundred kilobytes at any quality, and they are
    # the ones that need it: they are magnified two- or three-fold at the end of
    # their life, over dark water, by a grade that lifts the shadows — which
    # turns ordinary 8x8 JPEG blocking into a field of visible slabs across the
    # Sound. The two fine levels are a megabyte each and are shown at close to
    # 1:1, so they can afford ordinary quality and cannot afford double the size.
    img.save(OUT / name, quality=94 if size <= 1024 else 84,
             optimize=True, progressive=True)
    kb = (OUT / name).stat().st_size / 1024
    print(f"  -> {name}  {kb:.0f} kB")

    return {
        "key": level["key"], "file": name, "px": size,
        "span_m": span, "source": level["src"], "app": bool(level.get("app")),
        "west": west, "east": east, "south": south, "north": north,
        "res_m_px": span / size,
    }


def chain_gains(levels: list[dict]) -> None:
    """Match each level's brightness to the next finer one, and record the gain.

    The pyramid crosses two sources and six scales, and a cross-fade between two
    levels of different average brightness is a flash in the middle of a
    descent. Equalising their overall means would be wrong — the widest level is
    mostly ocean and the narrowest is all city, so they *should* differ — so the
    comparison is made only over the ground the two share: each level is cropped
    to the next one's footprint, and its gain is whatever makes that crop as
    bright as the next level already is. Chained from the sharpest outward, that
    puts the whole pyramid on the exposure of the frame the film lands on.
    """
    levels[-1]["gain"] = 1.0
    for i in range(len(levels) - 2, -1, -1):
        outer, inner = levels[i], levels[i + 1]
        a = np.asarray(Image.open(OUT / outer["file"]).convert("L"), dtype=np.float64)
        b = np.asarray(Image.open(OUT / inner["file"]).convert("L"), dtype=np.float64)
        n = a.shape[0]
        # The inner level's footprint inside the outer one, in outer pixels.
        half = (inner["span_m"] / outer["span_m"]) * n / 2.0
        c0, c1 = int(round(n / 2 - half)), int(round(n / 2 + half))
        crop = a[c0:c1, c0:c1]
        if crop.size < 16 or crop.mean() < 1e-6:
            outer["gain"] = inner["gain"]
            continue
        outer["gain"] = round(inner["gain"] * b.mean() / crop.mean(), 4)
        print(f"  {outer['key']} gain {outer['gain']:.3f} "
              f"(crop {crop.mean():.1f} vs {inner['key']} {b.mean():.1f})")


def main() -> int:
    meta = json.loads(META.read_text())
    p = meta["projection"]
    lon0, lat0 = p["lon0"], p["lat0"]
    m_lon, m_lat = p["m_per_deg_lon"], p["m_per_deg_lat"]
    OUT.mkdir(parents=True, exist_ok=True)

    levels = [build(lv, lon0, lat0, m_lon, m_lat) for lv in LEVELS]
    print("matching exposure across the pyramid:")
    chain_gains(levels)
    (OUT / "meta.json").write_text(json.dumps({
        "credit": CREDIT,
        "sources": {"naip": "USGS NAIP (public domain)",
                "esri": "Esri World Imagery"},
        "lon0": lon0, "lat0": lat0,
        "m_per_deg_lon": m_lon, "m_per_deg_lat": m_lat,
        "levels": levels,
    }, indent=1))
    total = sum((OUT / lv["file"]).stat().st_size for lv in levels) / 1024 / 1024
    print(f"\nwrote {len(levels)} mosaics, {total:.1f} MB, to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
