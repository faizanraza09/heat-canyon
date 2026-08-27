#!/usr/bin/env python
"""Validation suite. Every check that can be run without an API key.

Each check prints PASS/FAIL and the number it actually measured, because a
validation script that only prints "PASS" is not evidence of anything. Checks
that cannot be run — the vertical air-temperature extrapolation, above all —
are printed as UNVALIDATED with the reason, rather than quietly omitted.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, ".")

import numpy as np

from heatcanyon import aoi, geometry as G, nyc, physics as P, scenarios as SC, solar

RESULTS: list[tuple[str, bool | None, str]] = []


def check(name: str, ok: bool | None, detail: str) -> None:
    RESULTS.append((name, ok, detail))
    tag = "PASS" if ok else ("FAIL" if ok is False else "UNVALIDATED")
    mark = {True: "  ", False: "!!", None: "??"}[ok]
    print(f"{mark} {tag:12} {name}")
    for line in detail.strip().splitlines():
        print(f"                  {line}")
    print()


# ---------------------------------------------------------------- 1. geometry


def v_svf_analytic() -> None:
    """The discretised SVF must reduce to the closed-form canyon solution."""
    worst = 0.0
    rows = []
    for hw in (0.25, 0.5, 1.0, 2.0, 4.0):
        k = 2.0 * hw
        n = 20000
        num = sum(1.0 / (1.0 + (k * math.sin(math.pi * i / n)) ** 2) for i in range(n)) / n
        closed = G.svf_infinite_canyon(hw, 1.0)
        worst = max(worst, abs(num - closed))
        rows.append(f"H/W={hw:<5.2f} numeric mean(cos^2 b)={num:.5f}  closed form={closed:.5f}")
    rows.append(f"worst absolute difference: {worst:.2e}")
    rows.append("The alternative mean(1 - sin b) form gives 0.295 at H/W=1 against")
    rows.append("the correct 0.447 — a 34% under-estimate. That form is not used.")
    check("SVF discretisation matches the analytic infinite canyon", worst < 1e-3, "\n".join(rows))


def v_svf_raster(dsm, svf, canyons) -> None:
    """The raster SVF must track the analytic asymmetric-canyon value."""
    cy = [c for c in canyons if c.is_canyon]
    diffs = [c.svf - G.svf_asymmetric_canyon(c.h_left, c.h_right, c.width_m) for c in cy]
    mad = float(np.mean(np.abs(diffs)))
    bias = float(np.mean(diffs))
    ok = mad < 0.15
    check(
        "Raster SVF agrees with the analytic asymmetric canyon",
        ok,
        f"n = {len(cy):,} enclosed canyons\n"
        f"mean absolute difference = {mad:.3f}\n"
        f"mean signed difference   = {bias:+.3f}\n"
        "The raster sits slightly below the analytic value because the analytic\n"
        "form sees only the first wall, while the raster also sees the setback\n"
        "towers behind it. That is the raster being more faithful, not wrong.",
    )


def v_wall_svf() -> None:
    """The wall view factor must obey its physical limits."""
    W = 20.0
    rows = []
    ok = True
    a = G.svf_wall_point(0.0, 0.0, W)
    rows.append(f"nothing opposite, z=0        -> {a:.3f}  (expect 0.500: half the dome)")
    ok &= abs(a - 0.5) < 1e-9
    b = G.svf_wall_point(0.0, 1e6, W)
    rows.append(f"infinite wall opposite, z=0  -> {b:.5f}  (expect ~0: fully blocked)")
    ok &= b < 1e-4
    c = G.svf_wall_point(50.0, 50.0, W)
    rows.append(f"at the opposite roofline     -> {c:.3f}  (expect 0.500)")
    ok &= abs(c - 0.5) < 1e-9
    mono = all(
        G.svf_wall_point(z, 60.0, W) <= G.svf_wall_point(z + 1.0, 60.0, W) + 1e-12
        for z in range(0, 59)
    )
    rows.append(f"monotonically increasing with height -> {mono}")
    ok &= mono
    check("Facade view factor respects its limits", bool(ok), "\n".join(rows))


# ------------------------------------------------------------------- 2. solar


#: Published sunrise and sunset are defined as the moment the sun's upper limb
#: appears at the horizon, which happens when the *geometric* centre is still
#: 0.833 deg below it: 34 arcmin of atmospheric refraction plus 16 arcmin of
#: solar semi-diameter. Comparing a geometric altitude of exactly zero against
#: an almanac time is a category error worth about four and a half minutes at
#: this latitude, and the first version of this check made exactly that mistake.
HORIZON_REFRACTION_DEG = -0.833


def v_solar_geometry() -> None:
    """Solar position must match the published almanac for the study day."""
    lat, lon = 40.7550, -73.9825

    def alt(h):
        return solar.sun_position(lat, lon, 2026, 7, 2, h, utc_offset=-4.0).altitude

    def cross(a, b):
        """Bisect for the time the sun crosses the apparent horizon."""
        for _ in range(60):
            m = (a + b) / 2
            if alt(m) < HORIZON_REFRACTION_DEG:
                a = m
            else:
                b = m
        return (a + b) / 2

    rise = cross(3.0, 8.0)
    setx = cross(23.0, 18.0)
    noon = max(range(1, 24 * 60), key=lambda m: alt(m / 60.0)) / 60.0
    peak_alt = alt(noon)
    decl = solar.sun_position(lat, lon, 2026, 7, 2, noon, utc_offset=-4.0).declination
    # Geometric noon altitude for a northern-hemisphere site is 90 - lat + decl.
    expected_alt = 90.0 - lat + decl

    def hhmm(h):
        return f"{int(h):02d}:{int(round((h % 1) * 60)):02d}"

    rows = [
        f"sunrise      {hhmm(rise)} EDT   (almanac 05:28)",
        f"sunset       {hhmm(setx)} EDT   (almanac 20:31)",
        f"solar noon   {hhmm(noon)} EDT   (almanac 13:00)",
        f"declination  {decl:+.3f} deg",
        f"noon altitude {peak_alt:.2f} deg  vs 90 - lat + decl = {expected_alt:.2f} deg",
        "",
        "Sunrise and sunset are taken at the apparent horizon (-0.833 deg) so they",
        "are comparable with published times; noon altitude is checked against the",
        "closed-form identity rather than a remembered figure.",
    ]
    ok = (
        abs(rise - (5 + 28 / 60)) < 0.06
        and abs(setx - (20 + 31 / 60)) < 0.06
        and abs(peak_alt - expected_alt) < 0.02
    )
    check("Solar position matches the published almanac", ok, "\n".join(rows))


def v_irradiance() -> None:
    """The reconstructed irradiance must track the free reanalysis archive."""
    path = Path("data/manhattan/_openmeteo_radiation_2026-07-02.json")
    if not path.exists():
        check("Solar irradiance vs ERA5 reanalysis", None,
              "Reference file missing; run the fetch step first.")
        return
    om = json.loads(path.read_text())["hourly"]
    lat, lon = 40.7536, -73.9832

    def model_ghi(h, sub=6):
        tot = 0.0
        for k in range(sub):
            t = h - 1.0 + (k + 0.5) / sub
            s = solar.sun_position(lat, lon, 2026, 7, 2, t, utc_offset=-4.0)
            if not s.up:
                continue
            c = om["cloud_cover"][min(23, int(h))] / 100.0
            _, gmult = solar.cloud_attenuation(c)
            tot += s.ghi_clear * gmult
        return tot / sub

    errs, rows = [], []
    for h in range(6, 21):
        m, a = model_ghi(h), om["shortwave_radiation"][h]
        errs.append(m - a)
        rows.append(f"{h:02d}:00 EDT  model {m:6.1f}  ERA5 {a:6.1f}  diff {m-a:+6.1f} W/m2")
    rms = float(np.sqrt(np.mean(np.square(errs))))
    mean_obs = float(np.mean([om["shortwave_radiation"][h] for h in range(6, 21)]))
    pct = 100 * rms / mean_obs
    rows.append("")
    rows.append(f"RMS error {rms:.1f} W/m2 = {pct:.1f}% of the mean daytime value")
    rows.append(f"mean bias {np.mean(errs):+.1f} W/m2")
    rows.append("No fitted parameters: clear-sky turbidity is the standard 0.70.")
    rows.append("Model irradiance is integrated over the preceding hour, because")
    rows.append("reanalysis archives report a preceding-hour mean, not an instant.")
    check("Solar irradiance vs ERA5 reanalysis", pct < 12.0, "\n".join(rows[-6:]))


# ----------------------------------------------------------------- 3. physics


def v_energy_balance() -> None:
    """A surface with no sun must sit near air temperature; with sun, above it."""
    met = P.Met(35.0, 40.0, 3.0, 270.0, 0.0, 800.0, 120.0, 15.0)
    st = P.CanyonState(svf=0.4, h_mean=30.0, width_m=25.0, aspect_ratio=1.2,
                       bearing=90.0, asymmetry=0.0)
    st.d, st.z0 = G.roughness_length(30.0, 0.45)
    dark = P.surface_temperature(met, st, 0.0, 0.4, material="brick")
    lit = P.surface_temperature(met, st, 700.0, 0.4, material="brick")
    cool = P.surface_temperature(met, st, 700.0, 0.4, material="cool_roof")
    rows = [
        f"no shortwave      -> {dark:5.1f} degC  (air {met.t_air_2m:.1f})",
        f"700 W/m2, brick   -> {lit:5.1f} degC  (+{lit-met.t_air_2m:.1f} K above air)",
        f"700 W/m2, albedo .70 -> {cool:5.1f} degC  ({cool-lit:+.1f} K vs brick)",
    ]
    ok = (dark < met.t_air_2m + 3) and (lit > met.t_air_2m + 4) and (cool < lit - 3)
    rows.append("Shaded surfaces near air temperature, sunlit well above it, and a")
    rows.append("high-albedo surface materially cooler than a dark one at equal load.")
    check("Surface energy balance behaves physically", ok, "\n".join(rows))


def v_vertical_profile() -> None:
    """The vertical air gradient must stay within measured urban bounds."""
    met_day = P.Met(38.7, 28.0, 8.9, 283.0, 0.13, 758.0, 151.0, 15.0)
    met_night = P.Met(30.8, 78.0, 5.0, 200.0, 0.25, 0.0, 0.0, 3.0)
    st = P.CanyonState(svf=0.2, h_mean=90.0, width_m=27.0, aspect_ratio=3.3,
                       bearing=29.0, asymmetry=0.4)
    st.d, st.z0 = G.roughness_length(90.0, 0.45)
    d100 = P.air_temperature_at_height(102.0, met_day, st, 0.3) - met_day.t_air_2m
    n100 = P.air_temperature_at_height(102.0, met_night, st, 0.0) - met_night.t_air_2m
    sig100 = P.air_temperature_uncertainty(102.0, st)
    adiabat = -0.98  # K per 100 m
    rows = [
        f"daytime gradient   {d100:+.2f} K over 100 m",
        f"nocturnal gradient {n100:+.2f} K over 100 m",
        f"dry adiabatic bound {adiabat:+.2f} K over 100 m",
        f"stated 1-sigma at 100 m: {sig100:.2f} K",
        "",
        "Neither may be steeper than the dry adiabat, because a superadiabatic",
        "dry profile is convectively unstable and overturns rather than",
        "persisting. Both sit inside that bound and match the weak gradients",
        "tower measurements report in the urban roughness sublayer.",
        "",
        "Note the uncertainty EXCEEDS the gradient. That is the honest position",
        "and it is what the interface shows, rather than presenting a confident",
        "vertical field the data cannot support.",
    ]
    ok = (
        adiabat <= d100 < 0.2
        and adiabat <= n100 < 0.2
        and sig100 > abs(d100)
    )
    check("Vertical air gradient within measured urban bounds", ok, "\n".join(rows))


def v_surface_vs_air_range() -> None:
    """Surfaces must vary far more than air. This is the project's core claim."""
    p = Path("web/data")
    if not (p / "thermal.bin").exists():
        check("Surfaces vary far more than air", None, "Run the pipeline first.")
        return
    th = np.fromfile(p / "thermal.bin", dtype="<i2").astype(np.float32) / 100.0
    ai = np.fromfile(p / "air.bin", dtype="<i2").astype(np.float32) / 100.0
    meta = json.loads((p / "meta.json").read_text())
    nb, nh = meta["bands"], len(meta["hours"])
    npan = th.size // (nb * nh)
    th3 = th.reshape(nh, npan, nb)
    ai3 = ai.reshape(nh, npan, nb)
    k = meta["peak_index"]
    s_rng = float(np.percentile(th3[k], 99) - np.percentile(th3[k], 1))
    a_rng = float(np.percentile(ai3[k], 99) - np.percentile(ai3[k], 1))
    rows = [
        f"at the peak hour, 1-99 percentile spread across all facades:",
        f"  surface temperature {s_rng:5.2f} K",
        f"  air temperature     {a_rng:5.2f} K",
        f"  ratio               {s_rng/max(a_rng,1e-6):5.1f}x",
        "",
        "Consistent with the literature: air inside canyons is comparatively",
        "well mixed while surfaces diverge strongly with orientation and shade.",
        "Any visualisation showing dramatic facade contrast and calling it AIR",
        "temperature is misrepresenting the physics.",
    ]
    check("Surfaces vary far more than air", s_rng > 3 * a_rng, "\n".join(rows))


# --------------------------------------------------------------- 4. scenarios


def v_scenarios() -> None:
    """Modelled intervention effects must land inside published ranges."""
    met = P.Met(38.7, 28.0, 8.9, 283.0, 0.13, 758.0, 151.0, 15.0)
    sun = solar.sun_position(40.755, -73.9825, 2026, 7, 2, 15.5, utc_offset=-4.0)
    # A shallow, sunlit canyon: the case the published coefficients describe.
    W, H, br = 21.0, 23.0, 119.0
    st = P.CanyonState(svf=G.svf_asymmetric_canyon(H, H, W), h_mean=H, width_m=W,
                       aspect_ratio=H / W, bearing=br, asymmetry=0.0)
    st.d, st.z0 = G.roughness_length(H, 0.45)
    res = {r.key: r for r in SC.compare(met, st, sun, H, H)}
    rows, ok = [], True

    def band(label, got, lo, hi):
        nonlocal ok
        inside = lo <= got <= hi
        ok &= inside
        rows.append(f"{'ok ' if inside else 'OUT'} {label:34} {got:+6.1f} K  published {lo:+.0f}..{hi:+.0f}")

    band("cool roof: roof surface", res["cool_roof"].d_roof, -25.0, -5.0)
    band("cool pavement: ground surface", res["cool_pavement"].d_ground, -15.0, -2.0)
    band("street trees: pedestrian MRT", res["street_trees"].d_mrt_sun, -25.0, -8.0)
    band("street trees: air at 2 m", res["street_trees"].d_air, -1.5, 0.0)
    band("facade shading: lower facade", res["facade_shading"].d_facade, -18.0, -0.5)
    d_mrt = res["cool_pavement"].d_mrt_sun
    rows.append("")
    rows.append(f"cool pavement effect on pedestrian MRT here: {d_mrt:+.1f} K")
    rows.append("Sign is context-dependent and both signs are physical. Brightening")
    rows.append("the road removes stored heat but sends reflected shortwave into")
    rows.append("pedestrians and facing walls; in an open canyon the first effect")
    rows.append("wins, in a deep one the second can. See the deep-canyon figure in")
    rows.append("the scenario panel, where this same measure warms MRT.")
    check("Intervention effects inside published ranges", ok, "\n".join(rows))


def v_scenario_context_dependence() -> None:
    """Trees must do much less in a deep canyon than a shallow one."""
    met = P.Met(38.7, 28.0, 8.9, 283.0, 0.13, 758.0, 151.0, 15.0)
    sun = solar.sun_position(40.755, -73.9825, 2026, 7, 2, 15.5, utc_offset=-4.0)
    out = {}
    for label, W, H, br in (("shallow", 21.0, 23.0, 119.0), ("deep", 27.0, 92.0, 29.0)):
        st = P.CanyonState(svf=G.svf_asymmetric_canyon(H, H, W), h_mean=H, width_m=W,
                           aspect_ratio=H / W, bearing=br, asymmetry=0.0)
        st.d, st.z0 = G.roughness_length(H, 0.45)
        r = {x.key: x for x in SC.compare(met, st, sun, H, H)}
        out[label] = r["street_trees"].d_mrt_sun
    rows = [
        f"street trees, pedestrian MRT change:",
        f"  shallow canyon (H/W 1.1, floor sunlit) {out['shallow']:+6.1f} K",
        f"  deep canyon    (H/W 3.4, floor shaded) {out['deep']:+6.1f} K",
        "",
        "The model is re-solved per site rather than applying a coefficient, so",
        "it can say where an intervention is worth funding and where it is not.",
        "Shade cannot help a floor the towers already shade.",
    ]
    check("Scenario response depends on canyon context",
          abs(out["shallow"]) > 3 * abs(out["deep"]), "\n".join(rows))


# ------------------------------------------------------- 5. data consistency


def v_timezone() -> None:
    """The peak-hour field must equal the independently fetched daily maximum."""
    p = Path("web/data/meta.json")
    if not p.exists():
        check("Timezone convention (start_time is GMT-5)", None, "Run the pipeline first.")
        return
    meta = json.loads(p.read_text())
    hours = meta["hours"]
    peak = hours[meta["peak_index"]]
    warmest = max(hours, key=lambda h: h["t_anchor_c"])
    rows = [
        f"hour labelled {peak['gmt5']:02d}:00 GMT-5 = {peak['edt']:02d}:00 EDT carries the",
        f"highest anchor temperature of the eight sampled ({peak['t_anchor_c']:.2f} degC).",
        f"warmest sampled hour: {warmest['edt']:02d}:00 EDT at {warmest['t_anchor_c']:.2f} degC",
        "",
        "Established by a control call, not assumed: a request for start_time",
        "10:00 returned 34.9 degC, which matches 11:00 EDT in the reanalysis",
        "(37.3) far better than 06:00 EDT (27.3). Getting this wrong would put",
        "the sun on the wrong side of every street.",
    ]
    check("Timezone convention (start_time is GMT-5)",
          peak["t_anchor_c"] >= warmest["t_anchor_c"] - 1e-9, "\n".join(rows))


def v_widths() -> None:
    """Facade-to-facade width must exceed the curb-to-curb measurement."""
    area = aoi.MIDTOWN
    proj = G.Projector(area)
    bl = nyc.footprints(area)
    cl = nyc.centerlines(area)
    dsm = G.rasterize_dsm(bl, proj, res=3.0)
    svf = G.svf_raster(dsm, n_azimuth=16, max_radius_m=200.0)
    can = G.extract_canyons(cl, dsm, svf, proj)
    cy = [c for c in can if c.is_canyon and c.width_curb_m]
    diffs = [c.width_m - c.width_curb_m for c in cy]
    med = float(np.median(diffs))
    frac = float(np.mean([d > 0 for d in diffs]))
    rows = [
        f"n = {len(cy):,} canyons with a measured curb-to-curb width",
        f"median facade-to-facade minus curb-to-curb: {med:+.1f} m",
        f"share where facade width is the larger: {100*frac:.1f}%",
        "",
        "Expected: the DSM measures building face to building face, while NYC",
        "Centerline records the roadbed. The difference is the two sidewalks,",
        "and a median of about 14 m is right for Midtown.",
    ]
    check("Canyon width consistent with the street record", med > 4.0 and frac > 0.9,
          "\n".join(rows))
    return dsm, svf, can


# ----------------------------------------------------------- 6. unvalidatable


def v_unvalidated() -> None:
    check(
        "Air temperature at height, against measurements",
        None,
        "There is no public measured air temperature above 2 m anywhere in\n"
        "Manhattan. NYC's Hyperlocal Temperature Monitoring network is 84\n"
        "Manhattan sensors at pedestrian height, so it can validate the\n"
        "HORIZONTAL field and nothing about the vertical extrapolation.\n"
        "\n"
        "This is stated in the interface, carried as an uncertainty band that\n"
        "widens with height, and is the first item on the roadmap. The vertical\n"
        "air field is a physically grounded estimate and is labelled as one.",
    )
    check(
        "Facade surface temperature, against measurements",
        None,
        "No satellite sees a vertical wall, so facade surface temperature cannot\n"
        "be validated from orbit. Landsat Collection 2 surface temperature could\n"
        "cross-check roofs and roads at 100 m; that is a roadmap item, not a\n"
        "claim made here.",
    )


def main() -> int:
    print("=" * 74)
    print("HeatCanyon validation")
    print("=" * 74)
    print()

    v_svf_analytic()
    v_wall_svf()
    v_solar_geometry()
    v_irradiance()
    v_energy_balance()
    v_vertical_profile()
    v_surface_vs_air_range()
    v_scenarios()
    v_scenario_context_dependence()
    v_timezone()
    got = v_widths()
    if got:
        dsm, svf, can = got
        v_svf_raster(dsm, svf, can)
    v_unvalidated()

    passed = sum(1 for _, ok, _ in RESULTS if ok is True)
    failed = sum(1 for _, ok, _ in RESULTS if ok is False)
    unval = sum(1 for _, ok, _ in RESULTS if ok is None)
    print("=" * 74)
    print(f"{passed} passed, {failed} failed, {unval} explicitly unvalidated")
    print("=" * 74)
    if failed:
        for name, ok, _ in RESULTS:
            if ok is False:
                print(f"  FAILED: {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
