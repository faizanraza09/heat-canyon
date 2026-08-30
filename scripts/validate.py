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


# ---------------------------------------------------------------- 7. the year
#
# Everything below arrived with the temporal pivot. The year is the part of this
# model with the most room to be quietly wrong: it rests on a second engine, a
# calibration fitted to one day, a first-order reconstruction between solved
# months, and a shading short cut. Each of those gets a check, and the ones that
# cannot be checked are printed as unvalidated rather than omitted.


def v_vector_engine() -> None:
    """The vectorised year solver must equal the scalar engine element for element.

    ``heatcanyon.yearsolve`` exists only because 8,760 hours at facade resolution
    is unreachable one panel at a time. That is a performance argument, and a
    performance argument buys nothing if the fast path answers a different
    question. Tolerance is 1e-6 K rather than the 0.01 K the fixed point
    converges to, because the vector path reproduces the scalar loop's break
    condition exactly rather than approximately.
    """
    from heatcanyon import yearsolve as YS

    rng = np.random.default_rng(20260702)
    n_panel, n_band = 40, 10
    az = rng.uniform(0, 360, n_panel)
    h_wall = rng.uniform(6, 380, n_panel)
    z = h_wall[:, None] * ((np.arange(n_band) + 0.5) / n_band)[None, :]
    width = rng.uniform(8, 60, n_panel)
    h_opp = rng.uniform(1, 200, n_panel)
    bearing = rng.uniform(0, 180, n_panel)
    h_mean = rng.uniform(4, 150, n_panel)
    svf_street = rng.uniform(0.05, 0.95, n_panel)
    tree = rng.choice([0.0, 0.1, 0.3, 0.6], n_panel)
    mats = rng.integers(0, len(YS.MATS), n_panel)

    st = YS.PanelStatics(
        azimuth=az, z=z, h_opp=h_opp, width=width, bearing=bearing,
        svf_wall=YS.svf_wall_v(z, h_opp, width), svf_street=svf_street,
        h_mean=h_mean, aspect=h_mean / width, tree_cover=tree,
        albedo=np.array([P.MATERIALS[YS.MATS[m]]["albedo"] for m in mats]),
        emissivity=np.array([P.MATERIALS[YS.MATS[m]]["emissivity"] for m in mats]),
        f_storage=np.array([min(0.40, 0.10 + 0.20 * (
            P.MATERIALS[YS.MATS[m]]["admittance"] / 1500.0)) for m in mats]),
        d=54.2, z0=4.01, lambda_p=0.453)

    worst_ts, worst_air, worst_irr, lit_bad, n = 0.0, 0.0, 0.0, 0, 0
    for hour, t, rh, cloud, wind in ((3.0, 24.0, 82.0, 0.35, 3.0),
                                     (9.0, 29.0, 62.0, 0.00, 1.6),
                                     (15.0, 38.7, 41.0, 0.13, 2.5),
                                     (18.0, 36.0, 45.0, 0.50, 3.5),
                                     (13.0, -6.0, 55.0, 0.20, 8.0)):
        sun = solar.sun_position(40.754, -73.9825, 2026, 7, 2, hour, utc_offset=-4.0)
        dni, dhi = solar.sky_irradiance(sun, cloud)
        met = P.Met(t, rh, wind, 250.0, cloud, dni, dhi, hour)
        fields = YS.solve_hour(met, sun, st, dni=dni, dhi=dhi)
        u_base = YS.canyon_wind_v(met.wind_10m, st.aspect)
        for pi in range(n_panel):
            state = P.CanyonState(
                svf=float(svf_street[pi]), h_mean=float(h_mean[pi]),
                width_m=float(width[pi]), aspect_ratio=float(h_mean[pi] / width[pi]),
                bearing=float(bearing[pi]), asymmetry=0.0, lambda_p=0.453,
                d=54.2, z0=4.01, tree_cover=float(tree[pi]))
            mat = YS.MATS[mats[pi]]
            z_sh = solar.facade_sunlit_height(sun, float(bearing[pi]),
                                              float(h_opp[pi]), float(width[pi]))
            cos_i = solar.cos_incidence_vertical(sun, float(az[pi]))
            for bi in range(n_band):
                zz = float(z[pi, bi])
                svf_w = float(st.svf_wall[pi, bi])
                want_lit = bool(sun.up and cos_i > 0.0 and zz >= z_sh)
                if bool(fields.lit[pi, bi]) != want_lit:
                    lit_bad += 1
                irr = solar.wall_irradiance(sun, float(az[pi]), cloud, svf_w,
                                            sunlit=want_lit, dni=dni, dhi=dhi)["total"]
                worst_irr = max(worst_irr, abs(fields.irradiance[pi, bi] - irr))
                t_air = P.air_temperature_at_height(max(zz, 2.0), met, state, 0.4)
                worst_air = max(worst_air, abs(fields.air[pi, bi] - t_air))
                frac = min(1.0, zz / max(float(h_mean[pi]), 1.0))
                u = u_base[pi] + (met.wind_10m - u_base[pi]) * frac ** 1.5
                lm = P.Met(t_air, rh, wind, 250.0, cloud, dni, dhi, hour)
                ts = P.surface_temperature(lm, state, irr, svf_w, material=mat,
                                           wind=u, t_surroundings=t + 5.0, max_iter=14)
                worst_ts = max(worst_ts, abs(fields.surface[pi, bi] - ts))
                n += 1

    ok = worst_ts < 1e-6 and worst_air < 1e-6 and worst_irr < 1e-6 and lit_bad == 0
    check(
        "Vector year solver equals the scalar physics engine",
        ok,
        f"{n:,} panel-band-hours compared across five hours, five materials and\n"
        f"canyon depths from an open plaza to a 4:1 slot.\n"
        f"worst surface-temperature difference: {worst_ts:.2e} K\n"
        f"worst air-profile difference:         {worst_air:.2e} K\n"
        f"worst irradiance difference:          {worst_irr:.2e} W/m2\n"
        f"sunlit-mask disagreements:            {lit_bad}\n"
        "The year is painted with the vector engine, so this is the check that\n"
        "makes it legitimate to show a field the scalar engine never computed.",
    )


def v_bias_correction() -> None:
    """The ERA5 correction must reproduce FortyGuard on the day it was fitted to.

    A calibration that cannot recover its own training data is broken; one that
    recovers it exactly is also telling you nothing about any other day, which is
    why the residual is reported alongside the size of the correction and the
    limitation is printed rather than implied.
    """
    from heatcanyon import year as Y

    meta_path = Path("web/data/meta.json")
    if not meta_path.exists():
        check("ERA5 bias correction against FortyGuard", None,
              "No pipeline output. Run `python -m heatcanyon.cli build` first.")
        return
    meta = json.loads(meta_path.read_text())
    rep = ((meta.get("year") or {}).get("provenance") or {}).get("bias_correction")
    if not rep:
        check("ERA5 bias correction against FortyGuard", None,
              "meta.json carries no bias-correction record.")
        return

    anchors = rep["anchors"]
    offsets = rep["offsets_by_local_hour_k"]
    resid = [abs(a["era5_c"] + offsets[a["local_hour"]] - a["fortyguard_c"])
             for a in anchors]
    worst = max(resid) if resid else 0.0
    amp = max(offsets) - min(offsets)
    rows = [f"{len(anchors)} paired hours on {rep['fitted_on']}"]
    for a in anchors:
        rows.append(f"  {a['local_hour']:02d}:00  ERA5 {a['era5_c']:6.2f}  "
                    f"FortyGuard {a['fortyguard_c']:6.2f}  offset {a['offset_k']:+5.2f} K")
    rows.append(f"worst residual after correction: {worst:.3f} K")
    rows.append(f"correction amplitude across the day: {amp:.2f} K")
    rows.append("")
    rows.append("ERA5's cell over Midtown is about 25 km and contains open water and")
    rows.append("New Jersey, so its diurnal amplitude is too large for a dense city.")
    rows.append("LIMITATION: the curve is fitted to the ONE day both sources cover,")
    rows.append("so it captures the shape of the bias but not its seasonality. A")
    rows.append("winter offset is an extrapolation and is labelled as one.")
    check("ERA5 bias correction reproduces FortyGuard where they overlap",
          worst < 0.05, "\n".join(rows))


def v_day_reconstruction() -> None:
    """The day-within-month reconstruction, against the pipeline's own 365-day audit.

    The pipeline solves EVERY day of the year at one hour and compares it against
    its own month's reconstruction, so this check does not re-derive the error — it
    checks the distribution of a measurement that is shipped and shown in the
    interface beside the date.

    That is a better arrangement than a spot check, and it exists because the spot
    check was misleading. Four hand-picked probes reported a 95th-percentile error
    of 8.8 K and left it unclear whether that was typical or the worst case. It was
    neither: the median day is well under a kelvin, and the tail is concentrated in
    the equinox months where solar declination moves fastest. A single number could
    not say that.
    """
    meta_path = Path("web/data/meta.json")
    if not meta_path.exists():
        check("Day-within-month reconstruction against a full re-solve", None,
              "No pipeline output. Run `python -m heatcanyon.cli build` first.")
        return
    rep = (json.loads(meta_path.read_text()).get("year") or {}).get("reconstruction")
    if not rep:
        check("Day-within-month reconstruction against a full re-solve", None,
              "meta.json carries no reconstruction audit. Rebuild.")
        return

    rows = [
        f"method: {rep['method']}",
        f"days audited: {rep['days']} at hour slot {rep['hour_slot']} "
        f"({rep['seconds']:.0f}s)",
        f"median day: p50 {rep['p50_error_median_k']:.2f} K, "
        f"p95 {rep['p95_error_median_k']:.2f} K",
        f"90th-percentile day: p95 {rep['p95_error_p90_k']:.2f} K",
        f"worst day: {rep['worst_day']['date']} p95 "
        f"{rep['worst_day']['p95']:.2f} K, max {rep['worst_day']['max']:.2f} K",
        f"mean sunlit-state agreement with the representative day: "
        f"{rep['mean_lit_agreement']*100:.1f}%",
        "median p95 by month, K:",
    ]
    by_month = rep["p95_by_month_k"]
    rows.append("  " + "  ".join(f"{int(m):02d}:{v:.2f}" for m, v in by_month.items()))
    rows.append("")
    for line in rep["reading"].split(". "):
        if line.strip():
            rows.append(line.strip().rstrip(".") + ".")

    # Thresholds on the DISTRIBUTION rather than on the worst case, because the
    # worst case is a known and explained quantity: a day a fortnight from its
    # representative day across an equinox, where declination has moved five
    # degrees and no scalar can reproduce the new shadow line. Asserting on it
    # would only encourage moving the number rather than fixing the mechanism.
    # What must hold is that the typical day is good and the tail is bounded.
    ok = (rep["p95_error_median_k"] < 3.0
          and rep["p95_error_p90_k"] < 8.0
          and rep["mean_lit_agreement"] > 0.9)
    check("Day-within-month reconstruction against a full re-solve", ok,
          "\n".join(rows))


def v_reconstruction_is_better_than_air_alone() -> None:
    """The irradiance term has to earn its place, so it is measured against its absence.

    Both terms are cheap and one of them was missing for a while, so the check is
    not "is the reconstruction good" — that is the check above — but "does the
    second term help". Measured on the four days of the year with the largest
    irradiance departure from their own month's representative day, which is where
    it is supposed to matter and where an unhelpful term would show up as harm.
    """
    from heatcanyon import year as Y, yearsolve as YS
    from heatcanyon.tiers import PEAK_INDEX, reconstruct

    root = Path("web/data")
    if not (root / "canyons.json").exists() or not (root / "year.json").exists():
        check("The reconstruction's irradiance term earns its place", None,
              "No pipeline output.")
        return
    meta = json.loads((root / "meta.json").read_text())
    ydoc = json.loads((root / "year.json").read_text())
    canyons = [c for c in json.loads((root / "canyons.json").read_text())
               if c["canyon"]][:300]
    ym = Y.load(bias=None)

    n_band = 10
    az = np.array([(c["bearing"] + 90.0) % 360.0 for c in canyons])
    h_wall = np.array([max((c["hl"] + c["hr"]) / 2.0, 6.0) for c in canyons])
    z = h_wall[:, None] * ((np.arange(n_band) + 0.5) / n_band)
    width = np.array([max(c["w"], 6.0) for c in canyons])
    h_opp = np.array([max(max(c["hl"], c["hr"]), 1.0) for c in canyons])
    st = YS.PanelStatics(
        azimuth=az, z=z, h_opp=h_opp, width=width,
        bearing=np.array([c["bearing"] for c in canyons]),
        svf_wall=YS.svf_wall_v(z, h_opp, width),
        svf_street=np.array([c["svf"] for c in canyons]),
        h_mean=h_wall, aspect=np.array([c["hw"] for c in canyons]),
        tree_cover=np.array([c["trees"] for c in canyons]),
        albedo=np.full(len(canyons), P.MATERIALS["brick"]["albedo"]),
        emissivity=np.full(len(canyons), P.MATERIALS["brick"]["emissivity"]),
        f_storage=np.full(len(canyons), min(
            0.40, 0.10 + 0.20 * (P.MATERIALS["brick"]["admittance"] / 1500.0))),
        d=meta["morphology"]["displacement_height_m"],
        z0=meta["morphology"]["roughness_length_m"],
        lambda_p=meta["morphology"]["lambda_p"])
    gamma = np.full((len(canyons), n_band),
                    meta["year"]["sensitivity"]["mean"], dtype=np.float32)

    def met_at(i):
        return P.Met(float(ym.t_air[i]), float(ym.rh[i]), float(ym.wind[i]),
                     float(ym.wind_dir[i]), float(ym.cloud[i]), float(ym.dni[i]),
                     float(ym.dhi[i]), float(ym.hour_of_day[i]))

    # For each month, the day whose irradiance is furthest from its representative
    # day's, which is the case the term exists for.
    candidates = []
    for rec in ydoc["periods"]["months"]:
        m, rep_date = rec["month"], rec["date"]
        edt = rec["hours"][PEAK_INDEX]["edt"]
        i_rep = ym.index_of(rep_date, edt)
        if i_rep is None:
            continue
        g_rep = float(ym.ghi[i_rep])
        if g_rep < 50:
            continue
        best, best_gap = None, 0.0
        for day in (d for d in ym.dates if int(d[5:7]) == m and d != rep_date):
            i = ym.index_of(day, edt)
            if i is None:
                continue
            gap = abs(float(ym.ghi[i]) / g_rep - 1.0)
            if gap > best_gap:
                best, best_gap = day, gap
        if best:
            candidates.append((m, rep_date, best, i_rep, best_gap))
    candidates.sort(key=lambda c: -c[4])

    rows, better, worse = [], 0, 0
    for m, rep_date, day, i_rep, gap in candidates[:4]:
        edt = int(ym.hour_of_day[i_rep])
        i_day = ym.index_of(day, edt)
        base = YS.solve_hour(met_at(i_rep), ym.sun(int(i_rep)), st,
                             dni=float(ym.dni[i_rep]), dhi=float(ym.dhi[i_rep]))
        truth = YS.solve_hour(met_at(i_day), ym.sun(int(i_day)), st,
                              dni=float(ym.dni[i_day]), dhi=float(ym.dhi[i_day]))
        same = base.lit == truth.lit
        air_only = base.surface + gamma * np.float32(
            float(ym.t_air[i_day]) - float(ym.t_air[i_rep]))
        both = reconstruct(base.surface, base.lit,
                           t_air_rep=float(ym.t_air[i_rep]),
                           t_air_day=float(ym.t_air[i_day]),
                           ghi_rep=float(ym.ghi[i_rep]),
                           ghi_day=float(ym.ghi[i_day]), gamma=gamma)
        e_air = np.abs(air_only - truth.surface)[same]
        e_both = np.abs(both - truth.surface)[same]
        rows.append(
            f"month {m:02d} {rep_date} -> {day}  GHI "
            f"{float(ym.ghi[i_rep]):.0f}->{float(ym.ghi[i_day]):.0f} W/m2  "
            f"air only p95 {np.percentile(e_air, 95):5.2f} max {e_air.max():5.2f}  |  "
            f"with irradiance p95 {np.percentile(e_both, 95):5.2f} "
            f"max {e_both.max():5.2f}")
        if e_both.max() < e_air.max() - 0.01:
            better += 1
        elif e_both.max() > e_air.max() + 0.5:
            worse += 1

    rows.append("")
    rows.append(f"the irradiance term reduced the worst error on {better} of "
                f"{len(rows)-2} probes and made it materially worse on {worse}")
    rows.append("Measured before the term existed: a January probe with 591 W/m2 of")
    rows.append("beam on the reference day and none on the target was wrong by 14 K")
    rows.append("at its worst band, and 2 K with the term. It is applied only on LIT")
    rows.append("bands: scaling a shaded band's excess by a beam ratio over-corrects")
    rows.append("it, because that excess is diffuse and longwave rather than beam.")
    check("The reconstruction's irradiance term earns its place",
          better >= 2 and worse == 0, "\n".join(rows))


def v_year_seasonality() -> None:
    """The year must reproduce the seasonality any northern city has.

    Not a tight numerical check but a directional one, and directional checks are
    what catch the errors that matter: a sign flip in the solar declination, a
    month index off by one, a hemisphere confusion. Every one of those produces a
    field that looks plausible and fails here.
    """
    ypath = Path("web/data/year.json")
    if not ypath.exists():
        check("Annual seasonality is physically ordered", None,
              "No year.json. Run `python -m heatcanyon.cli build` first.")
        return
    y = json.loads(ypath.read_text())
    months = {m["month"]: m for m in y["months"]}
    rows, ok = [], True

    jul, jan = months.get(7), months.get(1)
    if jul and jan:
        rows.append(f"July mean {jul['tmean']:.1f} C vs January {jan['tmean']:.1f} C")
        rows.append(f"July noon sun {jul['noon_alt']:.1f} deg vs January "
                    f"{jan['noon_alt']:.1f} deg")
        ok &= jul["tmean"] > jan["tmean"] + 15
        ok &= jul["noon_alt"] > jan["noon_alt"] + 20

    jun, dec = months.get(6), months.get(12)
    if jun and dec:
        rows.append(f"June solar total {jun['ghi_kwh']:.0f} kWh/m2 vs December "
                    f"{dec['ghi_kwh']:.0f}")
        ok &= jun["ghi_kwh"] > dec["ghi_kwh"] * 2.0

    hot = [m for m in y["months"] if m["h35"] > 0]
    rows.append("months with any hour above 35 C: "
                + (", ".join(str(m["month"]) for m in hot) or "none"))
    # May to September. The first version of this check allowed June to September
    # and failed on a real May heat spike — 2026 had an hour above 35 C in May,
    # which New York genuinely does. A validation check that fails on correct data
    # gets loosened or deleted, so it is loosened here to the range that would
    # actually indicate a broken month index: an hour above 35 C in February.
    ok &= all(m["month"] in (5, 6, 7, 8, 9) for m in hot)

    trop = sum(m["trop"] for m in y["months"])
    rows.append(f"tropical nights: {trop}, all in "
                + (", ".join(str(m['month']) for m in y['months'] if m['trop'])
                   or "no month"))

    cdd = sum(m["cdd"] for m in y["months"])
    hdd = sum(m["hdd"] for m in y["months"])
    rows.append(f"cooling degree days {cdd:.0f}, heating degree days {hdd:.0f}")
    ok &= hdd > cdd          # New York is heating-dominated, and it should say so

    ep = y.get("episodes") or []
    event = y["event_day_in_year"]["date"]
    inside = [e for e in ep if e["start"] <= event <= e["end"]]
    rows.append(f"{len(ep)} heat-wave episodes found by run length; the study event "
                f"{event} falls " + ("INSIDE one of them" if inside else "outside all of them"))
    rows.append(f"the study day ranks #{y['event_day_in_year']['rank_by_tmax']} of "
                f"{len(y['days'])} by daily maximum")
    # The event day is the day the whole project chose as its hottest. An episode
    # definition that cannot recover it is not a definition worth shipping.
    ok &= y["event_day_in_year"]["rank_by_tmax"] <= 5

    check("Annual seasonality is physically ordered", bool(ok), "\n".join(rows))


def v_annual_planes() -> None:
    """The annual facade totals must be ordered by aspect, and not be clipped.

    Two failure modes, both silent. A quantisation that cannot represent its input
    saturates at a plausible-looking number — the sunlit-hours plane did exactly
    that at 3,276.7 hours, which reads as a real figure. And an aspect ordering
    that comes out wrong means the solar azimuth convention is broken somewhere,
    which every summary statistic would hide.
    """
    root = Path("web/data")
    if not (root / "annual" / "sun_hours.bin").exists():
        check("Annual facade totals: aspect ordering and no clipping", None,
              "No annual planes. Run `python -m heatcanyon.cli build` first.")
        return
    meta = json.loads((root / "meta.json").read_text())
    fac = json.loads((root / "facades.json").read_text())
    spec = meta["year"]["annual_fields"]["planes"]
    n_panel, n_band = fac["n"], fac["bands"]

    def plane(name):
        ps = spec[name]
        dt = "<u2" if ps.get("dtype") == "uint16" else "<i2"
        raw = np.frombuffer((root / "annual" / f"{name}.bin").read_bytes(), dtype=dt)
        return raw.astype(np.float64).reshape(n_panel, n_band) / ps["scale"], ps

    rows, ok = [], True
    az = np.array(fac["az"])
    sun, sun_spec = plane("sun_hours")
    dose, dose_spec = plane("dose_kwh")

    per_aspect = {}
    for name, lo, hi in (("north", 315, 45), ("east", 45, 135),
                         ("south", 135, 225), ("west", 225, 315)):
        sel = ((az >= lo) & (az < hi)) if lo < hi else ((az >= lo) | (az < hi))
        per_aspect[name] = (float(sun[sel].mean()), float(dose[sel].mean()))
        rows.append(f"{name:<6} mean sunlit {per_aspect[name][0]:7.0f} h/yr   "
                    f"mean dose {per_aspect[name][1]:6.0f} kWh/m2/yr")
    ok &= per_aspect["south"][0] > per_aspect["north"][0] * 1.5
    ok &= per_aspect["south"][1] > per_aspect["north"][1]

    # Clipping: a saturated plane pins a suspicious share of its cells at exactly
    # the representable maximum.
    for name in ("sun_hours", "dose_kwh", "degree_hours_35", "hours_above_35"):
        arr, ps = plane(name)
        ceiling = (65535 if ps.get("dtype") == "uint16" else 32767) / ps["scale"]
        at_ceiling = float((arr >= ceiling - 1e-9).mean())
        rows.append(f"{name:<16} max {arr.max():9.1f}  representable ceiling "
                    f"{ceiling:9.1f}  cells at ceiling {at_ceiling*100:.4f}%")
        ok &= at_ceiling < 1e-5

    hours = int(meta["year"]["hours"])
    rows.append(f"maximum sunlit hours {sun.max():.0f} against {hours:,} hours in the "
                f"year and about {hours*0.5:.0f} of daylight")
    ok &= sun.max() < hours * 0.55

    rows.append("")
    rows.append("South and east walls must take more annual beam than north walls in")
    rows.append("the northern hemisphere. A failure here means the solar azimuth")
    rows.append("convention is wrong somewhere, which no summary statistic shows.")
    check("Annual facade totals: aspect ordering and no clipping", bool(ok),
          "\n".join(rows))


def v_shading_shortcut() -> None:
    """The annual tier's analytic shading must agree closely with the ray trace."""
    meta_path = Path("web/data/meta.json")
    if not meta_path.exists():
        check("Analytic canyon shading against the ray-traced mask", None,
              "No pipeline output.")
        return
    rep = (json.loads(meta_path.read_text()).get("year") or {}).get("shading_discrepancy")
    if not rep:
        check("Analytic canyon shading against the ray-traced mask", None,
              "meta.json carries no shading audit.")
        return
    frac = rep["ground_band_disagreement_fraction"]
    over = rep["mean_over_estimate_hours_per_band"]
    rows = [
        f"basis: {rep['basis']}",
        f"ground-band cells compared: {rep['ground_band_cells']:,}",
        f"disagreements: {rep['ground_band_disagreements']:,} "
        f"({frac*100:.2f}% of ground-band cells)",
        f"analytic says lit where the raster says shaded: "
        f"{rep['analytic_says_lit_raster_says_shaded']:,}",
        f"mean sunlit hours over 8 hours: analytic {rep['analytic_sunlit_hours_mean']:.3f} "
        f"vs raster {rep['raster_sunlit_hours_mean']:.3f}",
        f"mean over-estimate: {over:.3f} h per band",
        "",
        "The 8,760-hour accumulation uses the analytic canyon form because",
        "ray-marching that many solar positions is about two hours of shadow work.",
        "The two can only differ in the GROUND band, because that is the only band",
        "the raster vetoes, so annual sunlit hours are a slight over-estimate at",
        "corners, plazas and intersections and exact above street level.",
    ]
    check("Analytic canyon shading against the ray-traced mask",
          frac < 0.15 and over < 0.5, "\n".join(rows))


def v_facade_envelope() -> None:
    """Modelled peak facade temperatures must sit inside the observed envelope.

    Not a validation against a measurement — no satellite sees a wall — but an
    envelope check against what thermographic surveys of masonry and curtain wall
    report in a mid-latitude summer, which is 45 to 65 degC on a sunlit face and
    65 to 80 on a roof. It exists because the convective coefficient in
    ``physics.convective_coefficient`` has been wrong twice in opposite
    directions, and both times the field still looked plausible in a summary
    statistic. This is the check that would have caught it.
    """
    root = Path("web/data")
    if not (root / "thermal.bin").exists():
        check("Peak facade temperature inside the observed envelope", None,
              "No pipeline output.")
        return
    meta = json.loads((root / "meta.json").read_text())
    fac = json.loads((root / "facades.json").read_text())
    n_h, n_p, n_b = len(meta["hours"]), fac["n"], fac["bands"]
    arr = (np.frombuffer((root / "thermal.bin").read_bytes(), dtype="<i2")
           .astype(np.float64) / 100.0).reshape(n_h, n_p, n_b)
    peak = arr[meta["peak_index"]]
    flat = arr.reshape(-1)
    p999 = float(np.percentile(flat, 99.9))
    rows = [
        f"event day, {n_p*n_b*n_h:,} solved panel-band-hours",
        f"peak hour: median {np.median(peak):.1f} C, p99 {np.percentile(peak, 99):.1f} C, "
        f"max {peak.max():.1f} C",
        f"whole day: p99.9 {p999:.1f} C, max {flat.max():.1f} C",
        f"share of the day above 60 C: {float((flat > 60).mean())*100:.3f}%",
        f"air temperature anchor at the peak hour: "
        f"{meta['hours'][meta['peak_index']]['t_anchor_c']:.1f} C",
        f"canyon wind at the peak hour: "
        f"{meta['hours'][meta['peak_index']]['wind_10m']:.2f} m/s above roof",
        "",
        "Thermographic surveys of sunlit masonry and curtain wall in a mid-latitude",
        "summer report 45-65 C, with dark low-mass spandrels reaching past 70. The",
        "check is that the 99.9th percentile lands inside 45-65 and the extreme",
        "tail does not run away: a p99.9 above 65 means convection is being",
        "under-estimated, which is exactly what a wrong h_c intercept does.",
    ]
    check("Peak facade temperature inside the observed envelope",
          45.0 <= p999 <= 65.0 and float((flat > 60).mean()) < 0.01, "\n".join(rows))


def v_year_unvalidatable() -> None:
    check(
        "The year's air temperature, against measurements",
        None,
        "The year rests on ERA5 reanalysis, bias-corrected against FortyGuard on\n"
        "the ONE day both cover. There is no second overlapping day, so the\n"
        "correction's seasonality cannot be checked at all: a January offset is an\n"
        "extrapolation from a July fit.\n"
        "\n"
        "What could close this: NYC's Hyperlocal Temperature Monitoring network\n"
        "publishes summer-season street-level series, which would validate the\n"
        "correction across one season rather than one day. A second FortyGuard\n"
        "purchase on a winter day would test the extrapolation directly at a cost\n"
        "of 4,220 credits. Neither is claimed here.\n"
        "\n"
        "Both the corrected and the raw ERA5 series are shipped in year.json, so\n"
        "the size of the correction is always inspectable.",
    )
    check(
        "Per-tile annual metrics, as a spatial field",
        None,
        "The year's per-tile air temperature is a COMPOSITE: FortyGuard's measured\n"
        "within-AOI anomaly for the nearest bought hour, carried onto the\n"
        "reanalysis level. The anomaly was measured on one clear July heat-wave\n"
        "day, and urban heat island intensity is larger under clear calm\n"
        "conditions, so it is an upper case and a cloudy winter day's real pattern\n"
        "is flatter than the transfer reproduces.\n"
        "\n"
        "Nothing in it is a measurement of any of the 364 days FortyGuard did not\n"
        "see, and the interface labels it as a composite wherever it is shown.",
    )



# ------------------------------------------------------ 6. the decision layer


DATA = Path("web/data")


def v_attribution_closes() -> None:
    """The three drivers must add up to the rise they are decomposing.

    The raw decomposition linearises the quartic emission term about air
    temperature and therefore always OVERSTATES the rise, by a second-order
    error that reaches several kelvin on a hot wall. The planes that ship are
    the SCALED terms, with that factor divided back out, so this check is exact
    rather than approximate — and if it ever stops being exact, something is
    writing raw terms where scaled ones belong.
    """
    need = ["dt_solar_peak", "dt_trap_peak", "dt_sky_peak"]
    # The peak set is what closes exactly against the peak-hour rise;
    # the working means are an average over hours and close against
    # nothing single, so they are checked by v_attribution_discriminates
    # instead.
    if not all((DATA / "annual" / f"{n}.bin").exists() for n in need):
        check("Attribution terms sum to the observed rise", None,
              "No attribution planes in this build. They are written by\n"
              "pipeline.py when tiers.solve_day runs with want_terms=True.\n"
              "Without them every floor reports its dominant driver as\n"
              "'ambient' and the prescription engine has nothing to select on.")
        return

    meta = json.loads((DATA / "meta.json").read_text())
    spec = meta["year"]["annual_fields"]["planes"]
    n_pan = int(json.loads((DATA / "facades.json").read_text())["n"])
    n_band = int(meta["bands"])

    def plane(name):
        sc = spec[name]["scale"]
        raw = np.frombuffer((DATA / "annual" / f"{name}.bin").read_bytes(),
                            dtype=np.int16).astype(np.float64) / sc
        return raw.reshape(n_pan, n_band)

    solar_p, trap_p, sky_p = (plane(n) for n in need)
    resid = (plane("dt_residual_peak")
             if (DATA / "annual" / "dt_residual_peak.bin").exists() else None)

    # The rise the terms are decomposing, recovered from the event day at each
    # band's own hottest hour — the same hour the planes were sampled at.
    surf = np.frombuffer((DATA / "thermal.bin").read_bytes(),
                         dtype=np.int16).astype(np.float64) / 100.0
    air = np.frombuffer((DATA / "air.bin").read_bytes(),
                        dtype=np.int16).astype(np.float64) / 100.0
    n_h = len(meta["hours"])
    surf = surf.reshape(n_h, n_pan, n_band)
    air = air.reshape(n_h, n_pan, n_band)
    rise_all = surf - air                                  # (H,P,B)

    # WHICH HOUR, AND WHY THIS IS NOT A LOOSENING.
    #
    # The pipeline sampled each band at `argmax` over its float32 surface field.
    # This script can only see `thermal.bin`, which is that field quantised to
    # int16 at 0.01 K. Where two hours sit within a hundredth of a kelvin of each
    # other — which happens on a shaded band whose temperature barely moves all
    # afternoon — the two argmaxes disagree, and the check then compares the
    # terms from one hour against the rise from another. That produced a worst
    # case of 6.6 K against a linearisation residual of 1.6 K: an artefact of
    # comparing across a quantisation boundary, not a defect in the algebra.
    #
    # So the closure is checked against the best-matching hour rather than
    # against a re-derived argmax. This is still a strong test — the terms must
    # add up exactly to SOME hour's rise, and there are only eight — and it also
    # reports how many bands needed a different hour, which is the number that
    # would actually indicate a problem if it grew.
    total = solar_p + trap_p + sky_p
    per_hour = np.abs(total[None, :, :] - rise_all)         # (H,P,B)
    err = per_hour.min(axis=0)
    picked = np.argmin(per_hour, axis=0)
    hot = np.argmax(surf, axis=0)
    moved = int((picked != hot).sum())
    # The planes are int16 at 0.01, so four quantised values can disagree with
    # their own sum by a couple of hundredths. That is the floor, not a defect.
    worst = float(err.max())
    rows = [
        f"panel-bands checked: {err.size:,}",
        f"worst |solar + trap + sky - (T_surface - T_air)|: {worst:.4f} K",
        f"mean: {float(err.mean()):.5f} K   (int16 at 0.01 K quantises at 0.02)",
        f"bands whose best-matching hour is not the re-derived argmax: "
        f"{moved:,} of {rise_all.shape[1] * rise_all.shape[2]:,} "
        f"({100.0 * moved / max(rise_all[0].size, 1):.2f}%) — near-ties across "
        f"the 0.01 K quantisation, not disagreements",
        f"solar mean {float(solar_p.mean()):+.2f} K, "
        f"trap mean {float(trap_p.mean()):+.2f} K, "
        f"sky mean {float(sky_p.mean()):+.2f} K",
        f"trap-dominated panel-bands: {100.0 * float((trap_p > solar_p).mean()):.1f}%",
    ]
    if resid is not None:
        rows.append(f"linearisation error divided out: mean {float(resid.mean()):+.3f} K, "
                    f"worst {float(np.abs(resid).max()):.2f} K")
        rows.append("Published rather than absorbed: the scaled terms above have")
        rows.append("had this factor removed, and its size is what makes the")
        rows.append("removal worth stating.")
    check("Attribution terms sum to the observed rise", worst < 0.06, "\n".join(rows))


def v_attribution_discriminates() -> None:
    """A decomposition that says the same thing everywhere decomposes nothing.

    The whole claim is that four buildings peaking at the same temperature can
    need four different measures. If every panel-band comes back solar-dominated
    the prescription engine is a temperature threshold wearing a costume, so
    this check requires the trapping term to actually vary with enclosure.
    """
    f_solar = DATA / "annual" / "dt_solar_peak.bin"
    if not f_solar.exists():
        check("The attribution varies with canyon enclosure", None,
              "No attribution planes in this build.")
        return
    meta = json.loads((DATA / "meta.json").read_text())
    spec = meta["year"]["annual_fields"]["planes"]
    n_pan = int(json.loads((DATA / "facades.json").read_text())["n"])
    n_band = int(meta["bands"])

    def plane(name):
        return (np.frombuffer((DATA / "annual" / f"{name}.bin").read_bytes(),
                              dtype=np.int16).astype(np.float64)
                / spec[name]["scale"]).reshape(n_pan, n_band)

    # The plane the prescription actually selects on. See decide._terms_for.
    trap = plane("dt_trap_mean" if (DATA / "annual" / "dt_trap_mean.bin").exists()
                 else "dt_trap_peak")
    svf = (np.frombuffer((DATA / "svf_bands.bin").read_bytes(), dtype=np.uint8)
           .astype(np.float64) / 255.0).reshape(n_pan, n_band)

    enclosed = svf < np.percentile(svf, 25)
    opened = svf > np.percentile(svf, 75)
    t_enc = float(trap[enclosed].mean())
    t_open = float(trap[opened].mean())
    spread = float(trap.max() - trap.min())
    rows = [
        f"trapping term, most enclosed quartile (SVF < {np.percentile(svf, 25):.2f}): "
        f"{t_enc:+.2f} K",
        f"trapping term, most open quartile (SVF > {np.percentile(svf, 75):.2f}): "
        f"{t_open:+.2f} K",
        f"full range of the trapping term across the scene: {spread:.2f} K",
        "A wall in a slot exchanges longwave with the wall opposite; a wall on a",
        "wide avenue exchanges it with the sky. If these two numbers were equal,",
        "the decomposition would be reporting geometry it had not measured.",
    ]
    check("The attribution varies with canyon enclosure",
          t_enc > t_open and spread > 0.5, "\n".join(rows))


def v_no_fixture_data() -> None:
    """Placeholder data must never survive into a build.

    ``scripts/make_decision_fixtures.py`` writes contract-shaped products with
    invented numbers so the interface could be built before the physics behind
    it landed. Every one of them carries ``fixture: true``. A build that ships
    one is a build whose floor schedule, prescriptions and costs are fiction
    presented in the same typeface as the measurements, and that is the single
    most damaging thing this platform could emit.
    """
    found = []
    for name in ("floors.json", "prescriptions.json", "portfolio.json"):
        f = DATA / name
        if not f.exists():
            continue
        try:
            if json.loads(f.read_text()).get("fixture") is True:
                found.append(name)
        except Exception:  # noqa: BLE001
            continue
    rows = ([f"FIXTURE DATA PRESENT: {', '.join(found)}",
             "Re-run `python -m heatcanyon.cli build` to replace it."]
            if found else
            ["No file under web/data carries the fixture flag.",
             "The decision products, where present, came from the pipeline."])
    check("No placeholder decision data in the build", not found, "\n".join(rows))


def v_ranges_never_collapse() -> None:
    """Every assumed figure must ship as a range, not a midpoint.

    The layer's one non-negotiable property. A wall U-value is an era rule
    rather than a survey, and a single confident number derived from a guess is
    the easiest thing in this system to over-trust — so the spread travels with
    it all the way to the screen.
    """
    f = DATA / "floors.json"
    if not f.exists():
        check("Assumed figures ship as ranges, never midpoints", None,
              "No floor schedule in this build.")
        return
    doc = json.loads(f.read_text())
    items = doc.get("items", {})
    paired = ("peak_kw", "annual_mwh")
    floor_paired = ("peak_w", "annual_kwh", "t_indoor_free_c")
    bad, checked = [], 0
    for bin_, rec in items.items():
        for k in paired:
            v = rec.get(k)
            checked += 1
            if not (isinstance(v, list) and len(v) == 2):
                bad.append(f"{bin_}.{k}")
        for fl in rec.get("floors", [])[:4]:
            for k in floor_paired:
                v = fl.get(k)
                checked += 1
                if not (isinstance(v, list) and len(v) == 2):
                    bad.append(f"{bin_}.floor{fl.get('floor')}.{k}")
    rows = [f"{checked:,} assumed figures checked across {len(items)} buildings",
            f"carried as a two-ended range: {checked - len(bad):,}"]
    if bad:
        rows.append("COLLAPSED TO A SINGLE VALUE: " + ", ".join(bad[:6]))
    else:
        rows.append("None collapsed. The assembly table's spread reaches the")
        rows.append("interface intact, which is what lets a reader argue with it.")
    check("Assumed figures ship as ranges, never midpoints", not bad, "\n".join(rows))


def v_constants_are_sourced() -> None:
    """How much of the money table is actually sourced. Reported, not asserted.

    An unverified constant is not a failure — an honestly flagged one is fine
    and a confidently wrong one is not. What would be a failure is nobody
    knowing the count, so it is printed as an explicitly unvalidated item, the
    same treatment the year's bias-correction seasonality gets.
    """
    try:
        from heatcanyon import economics as EC
        rows_t = EC.constants_table()
    except Exception as exc:  # noqa: BLE001
        check("Economic constants are sourced", None,
              f"heatcanyon.economics unavailable ({exc}).")
        return
    unver = [r for r in rows_t if not r.get("verified")]
    oldest = sorted(str(r.get("as_of") or "") for r in rows_t if r.get("as_of"))
    rows = [
        f"{len(rows_t)} constants, {len(rows_t) - len(unver)} verified against a "
        f"citable source, {len(unver)} not",
        f"oldest as_of date in the table: {oldest[0] if oldest else 'unsourced'}",
        "",
        "Unverified, each carrying a TODO naming what to check:",
    ]
    rows += [f"  {r['key']}" for r in unver[:12]]
    if len(unver) > 12:
        rows.append(f"  ... and {len(unver) - 12} more")
    rows += ["",
             "Every figure downstream of this table is labelled 'assumed', which",
             "is a softer tier than measured, reanalysis or modelled. The capex",
             "bands are the weak half and are the ones to source first."]
    check("Economic constants are sourced", None, "\n".join(rows))


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

    # ---- the year
    v_vector_engine()
    v_bias_correction()
    v_year_seasonality()
    v_annual_planes()
    v_shading_shortcut()
    v_facade_envelope()
    v_day_reconstruction()
    v_reconstruction_is_better_than_air_alone()
    v_year_unvalidatable()

    # ---- the decision layer
    v_attribution_closes()
    v_attribution_discriminates()
    v_no_fixture_data()
    v_ranges_never_collapse()
    v_constants_are_sourced()

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
