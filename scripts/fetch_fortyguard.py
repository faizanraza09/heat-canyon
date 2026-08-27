#!/usr/bin/env python
"""Fetch (once) every FortyGuard layer the engine needs, into the disk cache.

Run with --live to actually spend credits; without it the script only reports
what is already cached and what a live run would cost. Every response lands in
``data/manhattan/`` and is never re-fetched.

The study event is the July 2026 New York heat wave. 2026-07-02 was the hottest
day of the summer (40.7 C at the Midtown reference point per the ERA5 archive);
2026-06-29 -> 2026-07-05 is the hottest seven-day window, which is the window
the exceedance and persistence layers are computed over.
"""

from __future__ import annotations

import argparse
import sys

sys.path.insert(0, ".")

from heatcanyon import aoi, fg

# ---------------------------------------------------------------- study event
PEAK_DATE = "2026-07-02"          # hottest day of summer 2026 in Manhattan
PEAK_HOUR_UTC = "19:00"           # 15:00 EDT — the classic afternoon peak
WAVE_START = "2026-06-29"         # hottest 7-day window
WAVE_END = "2026-07-05"
THRESHOLD_C = 35.0                # 95 F — NWS heat-advisory territory
GRANULARITY = 60                  # finest the API offers

# Reference point for the 24 h environmental series: Bryant Park, the centre of
# the Midtown AOI and a location with a real public-health readership.
REF_POINTS = {
    "bryant_park": (40.7536, -73.9832),
    "grand_central": (40.7527, -73.9772),
    "hudson_yards": (40.7540, -73.9940),
}

# Street-view probes: three canyon cross-sections whose sky fraction we can
# compare against the SVF our geometry engine computes from building heights.
# Each is sampled looking up-street and cross-street.
CANYON_PROBES = {
    # (lat, lon, heading_deg, what makes it interesting)
    "w42_bryant": (40.7550, -73.9840, 90.0, "wide crosstown canyon, park on one side"),
    "e42_grand_central": (40.7519, -73.9770, 270.0, "deep symmetric canyon under towers"),
    "5ave_47": (40.7570, -73.9780, 0.0, "avenue canyon, tall on both sides"),
}


def plan(area: aoi.AOI) -> list[dict]:
    """The complete, ordered fetch list. One dict per billed call."""
    return [
        {
            "kind": "heatmap",
            "why": "Air temperature at the peak hour — the anchor field the whole engine extrapolates from.",
            "kw": dict(
                area=area, start_date=PEAK_DATE, filter_type=1,
                start_time=PEAK_HOUR_UTC, granularity=GRANULARITY,
                analytic_type="tcm", label=f"{area.key}_tcm_peakhour",
            ),
        },
        {
            "kind": "heatmap",
            "why": "Full-day min/mean/max per tile — gives the diurnal amplitude that sets the canyon stability regime.",
            "kw": dict(
                area=area, start_date=PEAK_DATE, filter_type=3,
                granularity=GRANULARITY, analytic_type="tcm",
                label=f"{area.key}_tcm_fullday",
            ),
        },
        {
            "kind": "heatmap",
            "why": "Hours above 35 C across the heat wave — the exposure-dose layer. This is the impact metric, not the snapshot.",
            "kw": dict(
                area=area, start_date=WAVE_START, end_date=WAVE_END, filter_type=4,
                granularity=GRANULARITY, analytic_type="exceedance",
                threshold=THRESHOLD_C, direction="above",
                label=f"{area.key}_exceedance_35C",
            ),
        },
        {
            "kind": "heatmap",
            "why": "Longest unbroken run above 35 C — no overnight relief is what actually kills people.",
            "kw": dict(
                area=area, start_date=WAVE_START, end_date=WAVE_END, filter_type=4,
                granularity=GRANULARITY, analytic_type="persistence",
                threshold=THRESHOLD_C, direction="above",
                label=f"{area.key}_persistence_35C",
            ),
        },
        {
            "kind": "heatmap",
            "why": "Hour-of-peak per tile — reveals the thermal phase lag between open plazas and deep canyons.",
            "kw": dict(
                area=area, start_date=PEAK_DATE, filter_type=3,
                granularity=GRANULARITY, analytic_type="time_of_measure",
                label=f"{area.key}_timeofpeak",
            ),
        },
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live", action="store_true", help="spend credits on cache misses")
    ap.add_argument("--aoi", default="midtown", choices=sorted(aoi.CATALOG))
    ap.add_argument("--skip", nargs="*", default=[], help="labels to skip")
    ap.add_argument("--only", nargs="*", default=[], help="only these labels")
    ap.add_argument("--env", action="store_true", help="also fetch env_params series")
    ap.add_argument("--streetview", action="store_true", help="also fetch street-view probes")
    ap.add_argument("--satellite", action="store_true", help="also fetch satellite segmentation")
    args = ap.parse_args()

    area = aoi.get(args.aoi)
    print(area.describe())
    print()

    g = fg.CachedFortyGuard(allow_live=args.live)
    if args.live:
        rem = g.credits_remaining()
        print(f"Credits remaining: {rem:,}" if rem else "Credits remaining: unknown")
        print()

    tasks = plan(area)
    if args.only:
        tasks = [t for t in tasks if t["kw"]["label"] in args.only]
    if args.skip:
        tasks = [t for t in tasks if t["kw"]["label"] not in args.skip]

    fetched: dict[str, object] = {}
    for t in tasks:
        label = t["kw"]["label"]
        print(f"* {label}")
        print(f"  {t['why']}")
        try:
            f = g.heatmap(**t["kw"])
            fetched[label] = f
            _summarise(f)
        except RuntimeError as exc:
            print(f"  SKIPPED: {exc}")
        except Exception as exc:
            print(f"  FAILED: {type(exc).__name__}: {exc}")
        print()

    # ------------------------------------------------------- env_params series
    if args.env:
        anchor = _anchor_temperature(fetched)
        for name, (lat, lon) in REF_POINTS.items():
            print(f"* env_params {name}")
            print("  24 h humidity / apparent-temperature / solar-irradiance series."
                  " Solar irradiance is what drives the facade energy balance.")
            try:
                f = g.env_params(
                    latitude=lat, longitude=lon, temperature=anchor,
                    start_date=PEAK_DATE, filter_type=3,
                    label=f"{area.key}_env_{name}_{PEAK_DATE}",
                )
                keys = list(f.result.keys()) if isinstance(f.result, dict) else type(f.result)
                print(f"  keys: {keys}")
            except Exception as exc:
                print(f"  {type(exc).__name__}: {exc}")
            print()

    # ------------------------------------------------------------ street view
    if args.streetview:
        for name, (lat, lon, heading, why) in CANYON_PROBES.items():
            print(f"* streetview {name} — {why}")
            print("  Segmented sky fraction here is an independent check on the SVF"
                  " our geometry engine computes from building heights.")
            try:
                f = g.street_view(
                    latitude=lat, longitude=lon, horizontal_angle=heading,
                    label=f"{area.key}_sv_{name}",
                )
                keys = list(f.result.keys()) if isinstance(f.result, dict) else type(f.result)
                print(f"  keys: {keys}")
            except Exception as exc:
                print(f"  {type(exc).__name__}: {exc}")
            print()

    # -------------------------------------------------------------- satellite
    if args.satellite:
        for name, (lat, lon) in list(REF_POINTS.items())[:1]:
            print(f"* satellite {name}")
            print("  Land-cover fractions set the ground albedo and tree cover the"
                  " surface energy balance needs.")
            try:
                f = g.satellite(
                    latitude=lat, longitude=lon, start_date=PEAK_DATE,
                    filter_type=3, granularity=GRANULARITY,
                    label=f"{area.key}_sat_{name}",
                )
                keys = list(f.result.keys()) if isinstance(f.result, dict) else type(f.result)
                print(f"  keys: {keys}")
            except Exception as exc:
                print(f"  {type(exc).__name__}: {exc}")
            print()

    print("-" * 72)
    print(fg.spend_report())
    if args.live:
        rem = g.credits_remaining()
        print(f"\nCredits remaining: {rem:,}" if rem else "")
    return 0


def _summarise(f) -> None:
    r = f.result
    feats = r.get("map_data", {}).get("features", []) if isinstance(r, dict) else []
    sd = r.get("stats_data", {}) if isinstance(r, dict) else {}
    if not feats:
        print(f"  (no features; stats_data={sd})")
        return
    props = feats[0]["properties"]
    field = "average_temperature" if "average_temperature" in props else "value"
    vals = sorted(x["properties"].get(field) for x in feats
                  if x["properties"].get(field) is not None)
    units = sd.get("units", "degC")
    print(f"  {len(feats):,} tiles | {field} ({units}): "
          f"min {vals[0]:.2f}  med {vals[len(vals)//2]:.2f}  max {vals[-1]:.2f}  "
          f"spread {vals[-1]-vals[0]:.2f}")


def _anchor_temperature(fetched: dict) -> float:
    """The peak-hour AOI mean, used as the env_params temperature anchor."""
    f = fetched.get(f"midtown_tcm_peakhour") or next(iter(fetched.values()), None)
    if f is None:
        return 35.0
    feats = f.result.get("map_data", {}).get("features", [])
    vals = [x["properties"].get("average_temperature") for x in feats]
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else 35.0


if __name__ == "__main__":
    raise SystemExit(main())
