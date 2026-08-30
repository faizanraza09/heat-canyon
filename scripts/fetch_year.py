#!/usr/bin/env python3
"""Fetch one year of hourly meteorology for the study area — free, no key.

Open-Meteo's ERA5 archive is the only source in this project that can deliver a
whole year of hourly radiation, wind, humidity and air temperature for a point
without a credential or a credit budget. It is already the reference this
project validates its own solar reconstruction against (see
``scripts/validate.py``), so using it for the temporal axis keeps one source of
truth rather than introducing a second.

Two things this script gets right that the earlier one-day fetch did not:

* **Wind is requested in m/s.** Open-Meteo returns km/h by default and the
  one-day cache in ``data/manhattan/_openmeteo_radiation_2026-07-02.json``
  carries km/h under a field the pipeline read straight into ``Met.wind_10m``,
  which expects m/s. That inflated the canyon wind by 3.6x and, through
  ``h_c = 2 + 3.8u``, damped every facade's surface-to-air excess. Fixed at the
  request rather than in the reader, so the cache cannot be misread again.
* **The window is a whole year ending on the modelled heat wave**, so the year
  contains the day the rest of the project already solves and the two can be
  cross-checked against each other rather than merely coexisting.

Run:  python scripts/fetch_year.py [--start 2025-08-01] [--end 2026-07-31]
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from heatcanyon import aoi as aoi_mod  # noqa: E402
from heatcanyon.year import CACHE_DIR, HOURLY_VARS, WINDOW, cache_path  # noqa: E402

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"


def fetch(lat: float, lon: float, start: str, end: str, *, refresh: bool = False) -> dict:
    path = cache_path(start, end)
    if path.exists() and not refresh:
        print(f"cached: {path}")
        return json.loads(path.read_text())

    q = urllib.parse.urlencode({
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "start_date": start,
        "end_date": end,
        "hourly": ",".join(HOURLY_VARS),
        "timezone": "America/New_York",
        "wind_speed_unit": "ms",
    })
    url = f"{ARCHIVE}?{q}"
    print(f"GET {url[:120]}…")
    with urllib.request.urlopen(url, timeout=180) as r:
        payload = json.loads(r.read().decode("utf-8"))
    if payload.get("error"):
        raise SystemExit(f"Open-Meteo refused the request: {payload.get('reason')}")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")))
    n = len(payload["hourly"]["time"])
    print(f"wrote {path}  ({n:,} hours, {path.stat().st_size/1e6:.1f} MB)")
    return payload


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--aoi", default="midtown")
    ap.add_argument("--start", default=WINDOW[0])
    ap.add_argument("--end", default=WINDOW[1])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()

    area = aoi_mod.get(a.aoi)
    lon, lat = area.center
    payload = fetch(lat, lon, a.start, a.end, refresh=a.refresh)

    h = payload["hourly"]
    t = h["temperature_2m"]
    nulls = sum(1 for v in t if v is None)
    print(f"grid cell: {payload['latitude']:.3f}, {payload['longitude']:.3f} "
          f"(elev {payload['elevation']} m)  tz {payload['timezone']}")
    print(f"units: {payload['hourly_units']}")
    print(f"hours: {len(t):,}   nulls: {nulls}")
    warm = [v for v in t if v is not None]
    print(f"air temperature: {min(warm):.1f} to {max(warm):.1f} degC, "
          f"mean {sum(warm)/len(warm):.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
