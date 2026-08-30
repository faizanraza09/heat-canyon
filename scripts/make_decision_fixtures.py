"""Contract-shaped fixtures for the decision layer, ahead of the real pipeline.

WHY THIS EXISTS, AND WHEN IT SHOULD BE DELETED

`docs/DECISIONS.md` specifies three new data products — `floors.json`,
`prescriptions.json` and `portfolio.json` — that `pipeline._finish` will write
once `loads.py`, `prescribe.py`, `economics.py` and `portfolio.py` are wired
into it. The interface for those products is being built at the same time as
the products themselves, and an interface built against an imagined shape is an
interface that will need rebuilding.

So this script writes the real shapes, at the real scale, over the real
buildings — same BINs, same addresses, same floor counts, same solved facade
temperatures — using a deliberately crude stand-in for the arithmetic the real
modules will do. The renderer can therefore be written, run and looked at
before the physics behind it lands, and when the pipeline starts writing these
files for real nothing in the interface has to change.

**Every number this produces is a placeholder.** The shapes are the contract;
the values are not. Each file carries `"fixture": true` at its root, the
interface shows a standing, undismissable warning while that flag is set, and
`scripts/validate.py` FAILS if a fixture file is present in `web/data`.

WHY IT IS STILL HERE

`pipeline._finish` now writes all three for real, so the reason this was written
is gone. It is kept as a development convenience and nothing more: a full build
is about ten minutes, most of which is the 8,760-hour annual accumulation, and
somebody iterating on the floor schedule's typography should not have to spend
ten minutes to see a schedule. Run this, work on the renderer, then run the real
build before committing anything.

The safety property is the validation check, not this docstring. There is no
configuration in which fixture data can reach a release build without
`validate` failing and naming the files.

Run:  python -m scripts.make_decision_fixtures
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

import heatcanyon.agent.dataset as D
from heatcanyon import physics as P

OUT = Path("web/data")

#: Stand-in for `envelope.ASSEMBLIES`. Keyed the same way, so swapping the real
#: table in is a change of import rather than a change of shape.
ASSEMBLY = {
    "pre_war_masonry":     dict(label="Pre-war solid masonry", u=(1.6, 2.0), wwr=(0.15, 0.25), shgc=(0.65, 0.80)),
    "mid_century_masonry": dict(label="Mid-century masonry",   u=(1.3, 1.7), wwr=(0.20, 0.32), shgc=(0.65, 0.80)),
    "post_war_concrete":   dict(label="Post-war concrete",     u=(1.0, 1.4), wwr=(0.25, 0.40), shgc=(0.60, 0.75)),
    "early_curtain_wall":  dict(label="Early curtain wall",    u=(2.6, 3.4), wwr=(0.55, 0.70), shgc=(0.60, 0.80)),
    "modern_curtain_wall": dict(label="Modern curtain wall",   u=(1.8, 2.4), wwr=(0.60, 0.75), shgc=(0.30, 0.45)),
}


def assembly_key(year: int | None, h: float) -> str:
    """Mirror of `physics.facade_material`'s era split, one level finer."""
    y = year or 1920
    if y >= 1990 and h > 60:
        return "modern_curtain_wall"
    if y >= 1960 and h > 40:
        return "early_curtain_wall"
    if y >= 1945:
        return "post_war_concrete"
    if h > 80:
        return "mid_century_masonry"
    return "pre_war_masonry"


def occupancy(use: int | None, units: int) -> dict:
    if units > 0 or (use in (1, 2, 3, 4)):
        return dict(key="residential", label="Residential", setpoint_c=24.0,
                    overnight=True, persons=2.1)
    if use == 5:
        return dict(key="office", label="Office", setpoint_c=23.0,
                    overnight=False, persons=0.0)
    return dict(key="other", label="Other", setpoint_c=24.0,
                overnight=False, persons=0.0)


def compass(az: float) -> str:
    names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return names[int(((az % 360.0) + 22.5) // 45.0) % 8]


def rng(lo: float, hi: float, nd: int = 1) -> list[float]:
    return [round(lo, nd), round(hi, nd)]


def build() -> None:
    d = D.load()
    ranked = json.loads((OUT / "ranked.json").read_text())
    items = ranked["items"]
    nb = d.n_band

    ev = d.period("event")
    hours = [h["edt"] for h in ev.hours]
    # Attribution stand-in. The real thing comes from `physics.surface_terms`;
    # here the solar share is taken from the annual absorbed dose and the
    # trapping share from enclosure, which reproduces the right ORDERING across
    # a facade without pretending to be the decomposition.
    absorbed = d.plane("absorbed_kwh")
    sun_h = d.plane("sun_hours")
    wss = d.plane("winter_sun_share")
    kh35 = d.plane("degree_hours_35")
    svf_b = np.frombuffer((OUT / "svf_bands.bin").read_bytes(), dtype=np.uint8)
    svf_b = (svf_b.astype(np.float32) / 255.0).reshape(d.n_panel, nb)

    a_lo, a_hi = np.percentile(absorbed, [5, 95])

    floors_out: dict[str, dict] = {}
    presc_out: dict[str, list] = {}
    candidates: list[dict] = []

    for it in items:
        bn = str(it["bin"])
        bi = d.bin_to_index.get(bn)
        if bi is None:
            continue
        pidx = d.panels_of_building.get(bi)
        if pidx is None or not len(pidx):
            continue

        n_fl = max(1, int(it["floors"] or 1))
        h_b = float(it["h"])
        ak = assembly_key(it.get("year"), h_b)
        asm = ASSEMBLY[ak]
        occ = occupancy(it.get("use"), int(it.get("units") or 0))
        u_mid = sum(asm["u"]) / 2
        wwr_mid = sum(asm["wwr"]) / 2

        # Envelope area belonging to ONE storey: the building's own perimeter run
        # times its storey height. Deriving it from the band height instead would
        # count a band's whole 2-3 storeys against every floor inside it, which
        # is how the first pass produced 100 kW floors.
        storey_h = h_b / n_fl
        area = d.panel_length[pidx] * storey_h               # (p,) per storey
        surf = ev.surface[:, pidx, :]                        # (H,p,B)
        # Enclosure falls away with height in a canyon, so the trapping term
        # should too. Normalise the solar driver WITHIN the building rather than
        # against the whole city, or a hot building saturates and every floor
        # comes back "solar" — which is exactly what the first pass did.
        ab_b = absorbed[pidx, :].mean(axis=0)                 # (B,)
        ab_lo, ab_hi = float(ab_b.min()), float(ab_b.max())

        rows = []
        peak_w_tot = [0.0, 0.0]
        annual_kwh_tot = [0.0, 0.0]
        person_hours = 0.0
        worst = (0.0, 1)

        for f in range(1, n_fl + 1):
            band = min(nb - 1, int(f * nb / n_fl))
            storeys = max(1, round(n_fl / nb))
            t_band = surf[:, :, band]                        # (H,p)
            hpk = int(np.argmax(t_band.max(axis=1)))
            t_peak = float(t_band[hpk].max())

            sol = float(np.clip((ab_b[band] - ab_lo) / max(ab_hi - ab_lo, 1e-6), 0, 1))
            svf_here = float(svf_b[pidx, band].mean())
            enclosed = 1.0 - min(svf_here / 0.45, 1.0)
            dt_tot = max(0.0, t_peak - float(ev.hours[hpk]["t_anchor_c"]))
            # Two competing drivers that swap over as the band clears the wall
            # opposite: shortwave rises with the sun the band can see, longwave
            # from the facing wall falls away as the sky opens up.
            dt_solar = dt_tot * (0.15 + 0.70 * sol) * (0.45 + 0.55 * (1 - enclosed))
            dt_trap = dt_tot * (0.20 + 0.75 * enclosed)
            dt_sky = -0.8 - 7.0 * svf_here
            dom = "solar" if dt_solar >= dt_trap else "trap"
            if dt_tot < 1.5:
                dom = "ambient"
            rec = "good" if svf_here >= 0.35 else ("limited" if svf_here >= 0.15 else "none")

            faces: dict[str, dict] = {}
            for k, p in enumerate(pidx):
                c = compass(float(d.panel_azimuth[p]))
                e = faces.setdefault(c, dict(az=0.0, m2=0.0, t=-99.0, hr=hpk,
                                             sunh=0.0, wss=0.0, n=0))
                e["az"] = float(d.panel_azimuth[p]); e["n"] += 1
                e["m2"] += float(area[k])
                tk = float(surf[:, k, band].max())
                if tk > e["t"]:
                    e["t"] = tk
                    e["hr"] = hours[int(np.argmax(surf[:, k, band]))]
                e["sunh"] += float(sun_h[p, band]); e["wss"] += float(wss[p, band])

            env_m2 = sum(e["m2"] for e in faces.values())
            fl_lo = fl_hi = 0.0
            face_rows = []
            for c, e in sorted(faces.items(), key=lambda kv: -kv[1]["m2"]):
                op = e["m2"] * (1 - wwr_mid)
                gl = e["m2"] * wwr_mid
                dT = max(0.0, e["t"] - occ["setpoint_c"])
                lo = (asm["u"][0] * op + 2.4 * gl) * dT
                hi = (asm["u"][1] * op + 3.2 * gl) * dT
                fl_lo += lo; fl_hi += hi
                face_rows.append(dict(
                    az=round(e["az"], 1), c=c, m2=round(e["m2"], 1),
                    t=round(e["t"], 1), hr=e["hr"],
                    w=rng(lo, hi, 0),
                    solar=round(dt_solar, 1), trap=round(dt_trap, 1),
                    sunh=round(e["sunh"] / e["n"]), wss=round(e["wss"] / e["n"], 2)))

            ann_lo = fl_lo * 0.9      # crude duty-cycle stand-in, kWh/yr
            ann_hi = fl_hi * 1.6
            t_in_lo = occ["setpoint_c"] + dt_tot * 0.16
            t_in_hi = occ["setpoint_c"] + dt_tot * 0.34
            hrs = float(kh35[pidx, band].mean()) * 0.35
            ph = (int(it.get("units") or 0) / max(n_fl, 1)) * occ["persons"] * hrs
            person_hours += ph
            sev = int(np.clip(round((t_in_hi - 27.0) * 1.4 + hrs / 140.0), 0, 4))

            peak_w_tot[0] += fl_lo; peak_w_tot[1] += fl_hi
            annual_kwh_tot[0] += ann_lo; annual_kwh_tot[1] += ann_hi
            if fl_hi > worst[0]:
                worst = (fl_hi, f)

            rows.append(dict(
                f=f, band=band, z_lo=round(h_b * (f - 1) / n_fl, 1),
                z_hi=round(h_b * f / n_fl, 1), storeys=storeys,
                envelope_m2=round(env_m2, 1),
                peak_w=rng(fl_lo, fl_hi, 0), annual_kwh=rng(ann_lo, ann_hi, 0),
                t_surf=round(t_peak, 1), t_in=rng(t_in_lo, t_in_hi, 1),
                solar=round(dt_solar, 1), trap=round(dt_trap, 1),
                sky=round(dt_sky, 1), dom=dom, rec=rec,
                hrs=round(hrs), ph=round(ph), sev=sev, faces=face_rows))

        floors_out[bn] = dict(
            assembly=dict(key=ak, label=asm["label"], u_wall=list(asm["u"]),
                          wwr=list(asm["wwr"]), shgc=list(asm["shgc"]),
                          note="Era rule, not a survey.",
                          source="FIXTURE — replaced by heatcanyon/envelope.py"),
            occupancy=occ,
            peak_kw=rng(peak_w_tot[0] / 1000, peak_w_tot[1] / 1000, 1),
            annual_mwh=rng(annual_kwh_tot[0] / 1000, annual_kwh_tot[1] / 1000, 1),
            peak_hour_edt=15, worst_floor=worst[1],
            person_hours=round(person_hours),
            basis="assumed — fixture values, see scripts/make_decision_fixtures.py",
            floors=rows)

        # ---- prescriptions, one per dominant mode present in the schedule
        pres = []
        solar_fl = [r["f"] for r in rows if r["dom"] == "solar"]
        trap_fl = [r["f"] for r in rows if r["dom"] == "trap"]
        hot_face = max(
            (fr for r in rows for fr in r["faces"]), key=lambda fr: fr["t"], default=None)
        if solar_fl and hot_face:
            alt = 58.0 if hot_face["c"] in ("S", "SE", "SW") else 24.0
            proj = 2.1 * math.cos(math.radians(14.0)) / max(math.tan(math.radians(alt)), .05)
            device = "horizontal" if proj <= 1.5 else "vertical"
            area_m2 = sum(fr["m2"] for r in rows if r["dom"] == "solar"
                          for fr in r["faces"] if fr["c"] == hot_face["c"])
            pres.append(dict(
                key="fixed_shading", family="shading",
                title=f"External {device} shading — {hot_face['c']} face, floors {min(solar_fl)}–{max(solar_fl)}",
                faces=[hot_face["c"]], floors=[min(solar_fl), max(solar_fl)],
                device=device,
                geometry=dict(projection_m=round(min(proj, 1.5), 2),
                              window_head_m=2.1, peak_alt_deg=alt),
                area_m2=round(area_m2), lead_time="capital cycle",
                why=(f"Direct solar carries {rows[0]['solar']:.1f} K of the "
                     f"{hot_face['c']} face's excess over air on these floors."),
                effect=dict(d_facade_peak_k=-6.2, d_annual_kwh=[-14200, -8600],
                            d_peak_kw=[-5.1, -3.2], d_person_hours=-round(person_hours * .18),
                            d_winter_kwh=[1900, 3400], source="FIXTURE"),
                winter_cost="Removes January solar gain on the same face.",
                money=dict(capex_usd=[area_m2 * 320, area_m2 * 620],
                           energy_usd_yr=[900, 2600], carbon_t_yr=[2.1, 3.6],
                           ll97_usd_yr=[0, 900], payback_yr=[14, 41],
                           npv_usd=[-180000, -40000], basis="assumed — FIXTURE"),
                programme=["NYC Accelerator", "Local Law 97 compliance pathway"],
                does_not_fix=(f"Floors {min(trap_fl)}–{max(trap_fl)}, whose load is "
                              f"canyon-trapped longwave." if trap_fl else
                              "Nothing on this building is left untreated by it."),
                also_consider=["glazing_retrofit", "cool_roof"],
                confidence="assumed"))
        if trap_fl:
            worst_rec = rows[trap_fl[0] - 1]["rec"]
            pres.append(dict(
                key="night_purge" if worst_rec == "good" else "exterior_insulation",
                family="fabric",
                title=("Assisted night purge ventilation" if worst_rec == "good"
                       else f"Exterior insulation — floors {min(trap_fl)}–{max(trap_fl)}"),
                faces=[], floors=[min(trap_fl), max(trap_fl)],
                device="ventilation" if worst_rec == "good" else "insulation",
                geometry={}, area_m2=round(sum(rows[f - 1]["envelope_m2"] for f in trap_fl)),
                lead_time="one year",
                why=("These floors sit in a canyon that radiates poorly to the sky; "
                     "their excess is longwave from the wall opposite, which shading "
                     "cannot touch."),
                effect=dict(d_facade_peak_k=-1.4, d_annual_kwh=[-6100, -3200],
                            d_peak_kw=[-2.2, -1.1], d_person_hours=-round(person_hours * .09),
                            d_winter_kwh=[-2200, -900], source="FIXTURE"),
                winter_cost="None; insulation helps in both directions.",
                money=dict(capex_usd=[90000, 260000], energy_usd_yr=[500, 1400],
                           carbon_t_yr=[0.9, 1.8], ll97_usd_yr=[0, 400],
                           payback_yr=[22, 90], npv_usd=[-210000, -70000],
                           basis="assumed — FIXTURE"),
                programme=["NYC Accelerator"],
                does_not_fix="The sunlit upper floors, which need shading.",
                also_consider=["cool_facade_coating"], confidence="assumed"))
        pres.append(dict(
            key="cool_roof", family="roof", title="High-albedo roof coating",
            faces=["roof"], floors=[max(1, n_fl - 1), n_fl], device="coating",
            geometry=dict(albedo_from=0.25, albedo_to=0.70),
            area_m2=round(float(it["h"]) * 6), lead_time="this season",
            why="The roof has the highest sky view factor on the building and nothing shades it.",
            effect=dict(d_facade_peak_k=-0.4, d_annual_kwh=[-9800, -5200],
                        d_peak_kw=[-3.4, -1.8], d_person_hours=-round(person_hours * .06),
                        d_winter_kwh=[600, 1500], source="FIXTURE"),
            winter_cost="Small heating penalty on the top floor.",
            money=dict(capex_usd=[18000, 46000], energy_usd_yr=[700, 1900],
                       carbon_t_yr=[1.4, 2.6], ll97_usd_yr=[0, 700],
                       payback_yr=[9, 26], npv_usd=[-12000, 34000],
                       basis="assumed — FIXTURE"),
            programme=["NYC °CoolRoofs", "Local Law 92/94"],
            does_not_fix="Everything below the top two floors.",
            also_consider=["rooftop_pv"], confidence="assumed"))
        presc_out[bn] = pres

        for p in pres:
            cap = sum(p["money"]["capex_usd"]) / 2
            pha = abs(p["effect"]["d_person_hours"]) or 1
            candidates.append(dict(
                bin=bn, addr=it.get("addr"), measure=p["key"], title=p["title"],
                capex=p["money"]["capex_usd"],
                person_hours_avoided=pha,
                kwh_saved=[abs(v) for v in p["effect"]["d_annual_kwh"]][::-1],
                carbon_t=p["money"]["carbon_t_yr"],
                usd_per_person_hour=round(cap / pha, 2),
                lead_time=p["lead_time"], hvi=it.get("hvi"),
                units=int(it.get("units") or 0),
                priority=it["priority"], annual_priority=it["annual"]["priority"]))

    # Severity is a RANK, not an absolute cut. An absolute threshold on the
    # indoor estimate put 1,727 of 1,913 floors in the top band, which tells a
    # reader nothing and makes the stripe a solid block of one colour. Quintiles
    # over the whole schedule population say "worst fifth in Midtown", which is
    # both legible and what the stripe is actually for.
    all_scores = [(r["t_in"][1] - 24.0) * 1.6 + r["hrs"] / 120.0 + r["solar"] * 0.25
                  for v in floors_out.values() for r in v["floors"]]
    cuts = np.percentile(all_scores, [20, 40, 60, 80]) if all_scores else [0, 0, 0, 0]
    for v in floors_out.values():
        for r in v["floors"]:
            sc = (r["t_in"][1] - 24.0) * 1.6 + r["hrs"] / 120.0 + r["solar"] * 0.25
            r["sev"] = int(np.searchsorted(cuts, sc))
    (OUT / "floors.json").write_text(json.dumps(
        {"fixture": True, "n": len(floors_out), "bands": nb,
         "severity_basis": "quintile of (indoor estimate, annual dose, solar term) "
                           "across every floor in the schedule",
         "items": floors_out},
        separators=(",", ":")))
    (OUT / "prescriptions.json").write_text(json.dumps(
        {"fixture": True, "constants_as_of": "FIXTURE", "unverified": -1,
         "items": presc_out}, separators=(",", ":")))

    # ---- portfolio: four objectives over the same candidate set
    def key_for(obj):
        if obj == "person_hours":
            return lambda c: c["usd_per_person_hour"]
        if obj == "degree_hours":
            return lambda c: sum(c["capex"]) / max(sum(c["kwh_saved"]), 1)
        if obj == "vulnerable":
            return lambda c: c["usd_per_person_hour"] / max(c["hvi"] or 1, 1)
        return lambda c: sum(c["capex"]) / max(c["priority"], 1)

    curves = {}
    for obj in ("person_hours", "degree_hours", "vulnerable", "peak_relief"):
        order = sorted(range(len(candidates)), key=lambda i: (key_for(obj)(candidates[i]),
                                                             candidates[i]["bin"],
                                                             candidates[i]["measure"]))
        curves[obj] = order
    top_a = set(curves["person_hours"][:100])
    top_b = set(curves["vulnerable"][:100])
    (OUT / "portfolio.json").write_text(json.dumps({
        "fixture": True, "n": len(candidates),
        "objectives": ["person_hours", "degree_hours", "vulnerable", "peak_relief"],
        "candidates": candidates, "curves": curves,
        "disagreement": {
            "compared": ["person_hours", "vulnerable"],
            "top100_overlap": len(top_a & top_b),
            "only_in_a": sorted(top_a - top_b)[:20],
            "only_in_b": sorted(top_b - top_a)[:20],
            "reading": ("Efficiency and equity order the same candidates "
                        "differently. Where they disagree, someone is choosing.")},
        "constants": [], }, separators=(",", ":")))

    print(f"floors.json        {len(floors_out)} buildings, "
          f"{sum(len(v['floors']) for v in floors_out.values()):,} floors")
    print(f"prescriptions.json {sum(len(v) for v in presc_out.values()):,} measures")
    print(f"portfolio.json     {len(candidates):,} candidates, "
          f"top-100 overlap {len(top_a & top_b)}/100")
    for f in ("floors.json", "prescriptions.json", "portfolio.json"):
        print(f"  {f:20s} {(OUT / f).stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    build()
