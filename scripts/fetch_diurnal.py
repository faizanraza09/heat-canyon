#!/usr/bin/env python
"""Fetch the diurnal set of single-hour temperature snapshots.

Timezone note, established empirically (see docs/METHODOLOGY.md): the heatmap
endpoint's ``start_time`` is interpreted in the API's own local standard time,
GMT-5, which it uses year-round. New York is on EDT (GMT-4) in July, so an
``start_time`` of "14:00" is 15:00 EDT — 3 p.m. wall clock. Every label below
carries both so nothing downstream can confuse them.
"""

from __future__ import annotations

import argparse
import sys

sys.path.insert(0, ".")

from heatcanyon import aoi, fg

PEAK_DATE = "2026-07-02"
GRANULARITY = 60

#: (start_time in API local standard GMT-5, wall-clock EDT, what this hour shows)
HOURS = [
    ("02:00", "03:00 EDT", "deep night — canyon heat release, the inversion regime"),
    ("05:00", "06:00 EDT", "pre-dawn minimum — the coolest the street ever gets"),
    ("08:00", "09:00 EDT", "morning ramp — east facades taking the first load"),
    ("11:00", "12:00 EDT", "late morning — canyon floor entering full sun"),
    ("14:00", "15:00 EDT", "3 p.m. — the anchor hour. Near peak air temperature."),
    ("17:00", "18:00 EDT", "late afternoon — west facades at maximum solar load"),
    ("20:00", "21:00 EDT", "evening — surfaces still releasing stored heat"),
    ("23:00", "00:00 EDT", "midnight — no overnight relief on a heat-wave night"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--aoi", default="midtown", choices=sorted(aoi.CATALOG))
    args = ap.parse_args()

    area = aoi.get(args.aoi)
    g = fg.CachedFortyGuard(allow_live=args.live)
    if args.live:
        print(f"Credits remaining: {g.credits_remaining():,}\n")

    for start_time, edt, why in HOURS:
        hh = start_time[:2]
        label = f"{area.key}_tcm_h{hh}"
        print(f"* {label}  ({start_time} GMT-5 = {edt})")
        print(f"  {why}")
        try:
            f = g.heatmap(
                area=area, start_date=PEAK_DATE, filter_type=1, start_time=start_time,
                granularity=GRANULARITY, analytic_type="tcm", label=label,
            )
            feats = f.result["map_data"]["features"]
            vals = sorted(x["properties"]["average_temperature"] for x in feats)
            print(f"  {len(feats):,} tiles | min {vals[0]:.2f}  med {vals[len(vals)//2]:.2f}"
                  f"  max {vals[-1]:.2f}  spread {vals[-1]-vals[0]:.2f} C")
        except Exception as exc:
            print(f"  {type(exc).__name__}: {exc}")
        print()

    print("-" * 72)
    print(fg.spend_report())
    if args.live:
        print(f"\nCredits remaining: {g.credits_remaining():,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
