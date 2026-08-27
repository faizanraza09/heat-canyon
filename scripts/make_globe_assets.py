#!/usr/bin/env python
"""Build the assets the opening film needs: a world land mask, a city list, and
the real global temperature record.

The film is the first thing anyone sees, so nothing in it is invented. The
continents are Natural Earth's public-domain 1:50m land polygons, the cities are
Natural Earth's populated places with their published populations, and the
warming curve is NASA GISTEMP v4 — the actual land-ocean global mean anomaly
series, not a stylised curve. Every claim the narration makes about the planet
is computed from that file here, at build time, so the script cannot drift out
of step with the data behind it.

Downloads are cached under data/globe/ so the build is repeatable offline.

    .venv/bin/python scripts/make_globe_assets.py
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "globe"
OUT = ROOT / "web" / "data"

NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
SOURCES = {
    "land": (f"{NE}/ne_50m_land.geojson", "Natural Earth 1:50m land (public domain)"),
    "places": (
        f"{NE}/ne_110m_populated_places_simple.geojson",
        "Natural Earth 1:110m populated places (public domain)",
    ),
    "gistemp": (
        "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv",
        "NASA GISS Surface Temperature Analysis v4, land-ocean global mean",
    ),
}

#: Equirectangular mask size. The source geometry is 1:50m, so more pixels than
#: this buy nothing real; fewer make the coastline crawl when the camera closes in.
MASK_W, MASK_H = 4096, 2048
#: Supersampling factor for the rasteriser. Drawing at 3x and boxing down is what
#: turns a hard 1-bit fill into a coastline with a soft edge, which is the
#: difference between continents that look drawn and continents that look lit.
SS = 3


def fetch(key: str, *, refresh: bool = False) -> bytes:
    url, _ = SOURCES[key]
    path = CACHE / f"{key}{Path(url).suffix or '.txt'}"
    if path.exists() and not refresh:
        return path.read_bytes()
    CACHE.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {key} <- {url}")
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    path.write_bytes(r.content)
    return r.content


# ------------------------------------------------------------------ land mask


def _rings(geom: dict):
    """Yield every ring in a Polygon or MultiPolygon as (index, lon/lat pairs).

    Index 0 is the exterior ring of its polygon; the rest are holes.
    """
    t = geom["type"]
    if t == "Polygon":
        for i, ring in enumerate(geom["coordinates"]):
            yield i, ring
    elif t == "MultiPolygon":
        for poly in geom["coordinates"]:
            for i, ring in enumerate(poly):
                yield i, ring


def _unwrap(ring):
    """Make a ring's longitudes continuous across the antimeridian.

    A ring that crosses 180 deg arrives as a longitude jumping from +179 to -179.
    Drawn literally into an equirectangular raster that is a horizontal streak
    all the way back across the map, which is what Antarctica and Chukotka looked
    like before this: the coastline sawing between the two edges of the image.
    Accumulating the shortest step between consecutive points instead keeps the
    ring geometrically continuous, so it can be painted past the edge and wrapped
    deliberately by the caller.
    """
    out = []
    prev = None
    for lon, lat in ring:
        if prev is not None:
            lon = prev + ((lon - prev + 180.0) % 360.0) - 180.0
        out.append((lon, lat))
        prev = lon
    return out


def build_land_mask(refresh: bool = False) -> Path:
    gj = json.loads(fetch("land", refresh=refresh))
    W, H = MASK_W * SS, MASK_H * SS
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)

    n = 0
    for feat in gj["features"]:
        for i, ring in _rings(feat["geometry"]):
            # Ring 0 of each polygon is the exterior, the rest are holes — lakes
            # and inland seas. Painting the holes back to ocean is what keeps the
            # Caspian and the Great Lakes from reading as land.
            fill = 255 if i == 0 else 0
            ring = _unwrap(ring)
            if len(ring) < 3:
                continue
            # Paint each ring three times, shifted a full turn either way. An
            # unwrapped ring can now run off the side of the image; the copies put
            # the part that left one edge back at the other, and PIL clips the
            # rest. Antarctica, which wraps the whole planet, needs this.
            for shift in (-360.0, 0.0, 360.0):
                pts = [(((lon + shift) + 180.0) / 360.0 * W, (90.0 - lat) / 180.0 * H)
                       for lon, lat in ring]
                xs = [x for x, _ in pts]
                if max(xs) < 0 or min(xs) > W:
                    continue
                draw.polygon(pts, fill=fill)
            n += 1

    small = img.resize((MASK_W, MASK_H), Image.LANCZOS)
    path = OUT / "world_land.png"
    small.save(path, optimize=True)
    frac = np.asarray(small, dtype=np.float32).mean() / 255.0
    print(f"  land mask {MASK_W}x{MASK_H} from {n} rings, {frac * 100:.1f}% land, "
          f"{path.stat().st_size / 1024:.0f} kB")
    return path


# ---------------------------------------------------------------- world cities


def build_cities(limit: int = 160, refresh: bool = False) -> dict:
    gj = json.loads(fetch("places", refresh=refresh))
    rows = []
    for f in gj["features"]:
        p = f["properties"]
        pop = int(p.get("pop_max") or 0)
        if pop <= 0:
            continue
        rows.append({
            "name": p.get("nameascii") or p.get("name"),
            "lat": round(float(p["latitude"]), 4),
            "lon": round(float(p["longitude"]), 4),
            "pop": pop,
        })
    rows.sort(key=lambda r: -r["pop"])
    rows = rows[:limit]
    print(f"  cities {len(rows)}, largest {rows[0]['name']} {rows[0]['pop'] / 1e6:.1f} M")
    return {
        "source": SOURCES["places"][1],
        "url": SOURCES["places"][0],
        "n": len(rows),
        "items": rows,
    }


# ------------------------------------------------------- global temperature


def build_gistemp(refresh: bool = False) -> dict:
    text = fetch("gistemp", refresh=refresh).decode("utf-8", "replace")
    # The file opens with a title line before the header row.
    body = text.split("\n", 1)[1]
    reader = csv.DictReader(io.StringIO(body))

    years, annual, partial_year = [], [], None
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    for row in reader:
        try:
            year = int(row["Year"])
        except (TypeError, ValueError):
            continue
        jd = row.get("J-D", "").strip()
        if jd and jd != "***":
            years.append(year)
            annual.append(float(jd))
        else:
            # A year still in progress: average whatever months have reported, and
            # label it as partial rather than quietly plotting it as a full year.
            vals = [float(row[m]) for m in months
                    if row.get(m, "").strip() not in ("", "***")]
            if vals:
                partial_year = {
                    "year": year,
                    "value": round(sum(vals) / len(vals), 3),
                    "months": len(vals),
                }

    order = sorted(range(len(years)), key=lambda i: -annual[i])
    warmest = [years[i] for i in order]

    # The narration's one claim about the record — that the warmest years are all
    # recent — is derived here rather than asserted in the script, so it cannot
    # outlive the data. `warmest10_since` is the earliest of the ten warmest
    # years, i.e. "every one of the ten warmest years has come since <that>".
    latest = years[-1]
    warmest10_since = min(warmest[:10])

    out = {
        "source": SOURCES["gistemp"][1],
        "url": SOURCES["gistemp"][0],
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "baseline": "1951-1980 mean",
        "units": "K",
        "first_year": years[0],
        "last_year": latest,
        "years": years,
        "anomaly": annual,
        "partial": partial_year,
        "warmest": warmest[:10],
        "warmest10_since": warmest10_since,
        "latest_value": annual[-1],
        "baseline_first_decade": round(sum(annual[:10]) / 10, 3),
    }
    print(f"  gistemp {years[0]}-{latest}, latest {annual[-1]:+.2f} K, "
          f"ten warmest all since {warmest10_since}, partial {partial_year}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="re-download, ignoring the cache")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    print("globe assets ->", OUT)
    build_land_mask(args.refresh)

    cities = build_cities(refresh=args.refresh)
    (OUT / "world_cities.json").write_text(json.dumps(cities, separators=(",", ":")))

    temp = build_gistemp(refresh=args.refresh)
    (OUT / "global_temp.json").write_text(json.dumps(temp, separators=(",", ":")))

    for name in ("world_land.png", "world_cities.json", "global_temp.json"):
        print(f"  wrote {name} ({(OUT / name).stat().st_size / 1024:.0f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
