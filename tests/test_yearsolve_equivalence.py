"""The vector engine must equal the scalar engine, element for element.

``heatcanyon.yearsolve`` exists only because 8,760 hours at facade resolution is
unreachable one panel at a time. That is a performance argument, and a
performance argument buys nothing if the fast path answers a different question.
So the two are compared here on randomly drawn but physically realistic scenes:
every material, canyon depths from an open plaza to a 4:1 slot, heights from a
doorway to the top of a 400 m tower, and hours from before dawn to mid-afternoon.

Tolerances are tight on purpose — 1e-6 K rather than the 0.01 K the fixed point
converges to — because the vector path reproduces the scalar loop's break
condition exactly rather than approximately. Loosening these is not a fix; it is
the first sign the two engines have drifted.
"""
from __future__ import annotations

import math
import random

import numpy as np
import pytest

from heatcanyon import physics as P
from heatcanyon import solar
from heatcanyon import yearsolve as YS


def _scene(rng: random.Random, n_panel: int, n_band: int) -> tuple[YS.PanelStatics, list]:
    """A random scene, plus the per-panel scalar CanyonState it corresponds to."""
    az = np.array([rng.uniform(0, 360) for _ in range(n_panel)])
    h_wall = np.array([rng.uniform(6, 380) for _ in range(n_panel)])
    band = (np.arange(n_band) + 0.5) / n_band
    z = h_wall[:, None] * band[None, :]

    width = np.array([rng.uniform(8, 60) for _ in range(n_panel)])
    h_opp = np.array([rng.uniform(1, 200) for _ in range(n_panel)])
    bearing = np.array([rng.uniform(0, 180) for _ in range(n_panel)])
    h_mean = np.array([rng.uniform(4, 150) for _ in range(n_panel)])
    aspect = h_mean / width
    svf_street = np.clip(np.array([rng.uniform(0.05, 0.95) for _ in range(n_panel)]), 0, 1)
    tree = np.array([rng.choice([0.0, 0.1, 0.3, 0.6]) for _ in range(n_panel)])

    # Per-band wall SVF from the same closed form the pipeline uses.
    svf_wall = np.empty((n_panel, n_band))
    for p in range(n_panel):
        for b in range(n_band):
            svf_wall[p, b] = _svf_wall_point(z[p, b], h_opp[p], width[p])

    mats = [rng.randrange(len(YS.MATS)) for _ in range(n_panel)]
    alb = np.array([P.MATERIALS[YS.MATS[m]]["albedo"] for m in mats])
    emi = np.array([P.MATERIALS[YS.MATS[m]]["emissivity"] for m in mats])
    sto = np.array([min(0.40, 0.10 + 0.20 * (P.MATERIALS[YS.MATS[m]]["admittance"] / 1500.0))
                    for m in mats])

    d, z0, lam = 54.2, 4.01, 0.453
    st = YS.PanelStatics(
        azimuth=az, z=z, h_opp=h_opp, width=width, bearing=bearing,
        svf_wall=svf_wall, svf_street=svf_street, h_mean=h_mean, aspect=aspect,
        tree_cover=tree, albedo=alb, emissivity=emi, f_storage=sto,
        d=d, z0=z0, lambda_p=lam,
    )
    states = [P.CanyonState(svf=float(svf_street[p]), h_mean=float(h_mean[p]),
                            width_m=float(width[p]), aspect_ratio=float(aspect[p]),
                            bearing=float(bearing[p]), asymmetry=0.0,
                            lambda_p=lam, d=d, z0=z0, tree_cover=float(tree[p]))
              for p in range(n_panel)]
    return st, [(states[p], YS.MATS[mats[p]]) for p in range(n_panel)]


def _svf_wall_point(z: float, h_opposite: float, w: float) -> float:
    from heatcanyon import geometry as G
    return G.svf_wall_point(z, h_opposite, w)


def _mets():
    """Hours spanning the diurnal range, including two with the sun down."""
    out = []
    for (hour, t, rh, cloud, wind) in [
        (3.0, 24.0, 82.0, 0.35, 3.0),
        (6.0, 22.0, 88.0, 0.10, 1.4),
        (9.0, 29.0, 62.0, 0.00, 1.6),
        (12.0, 34.0, 48.0, 0.05, 2.1),
        (15.0, 38.7, 41.0, 0.13, 2.5),
        (18.0, 36.0, 45.0, 0.50, 3.5),
        (21.0, 31.0, 60.0, 0.00, 3.8),
        (0.0, 4.0, 70.0, 0.80, 6.0),
        (13.0, -6.0, 55.0, 0.20, 8.0),
    ]:
        sun = solar.sun_position(40.754, -73.9825, 2026, 7, 2, hour, utc_offset=-4.0)
        dni, dhi = solar.sky_irradiance(sun, cloud)
        out.append((P.Met(t_air_2m=t, rh_percent=rh, wind_10m=wind, wind_dir=250.0,
                          cloud_fraction=cloud, dni=dni, dhi=dhi, hour_edt=hour), sun))
    return out


@pytest.mark.parametrize("seed", [1, 7, 99])
def test_air_profile_matches_scalar(seed: int) -> None:
    rng = random.Random(seed)
    st, per_panel = _scene(rng, 24, 10)
    for met, _sun in _mets():
        vec = YS.air_temperature_profile_v(met, st, 0.4)
        for p, (state, _mat) in enumerate(per_panel):
            for b in range(st.n_band):
                want = P.air_temperature_at_height(max(float(st.z[p, b]), 2.0),
                                                   met, state, 0.4)
                assert abs(vec[p, b] - want) < 1e-6, (p, b, vec[p, b], want)


@pytest.mark.parametrize("seed", [2, 23])
def test_air_uncertainty_matches_scalar(seed: int) -> None:
    rng = random.Random(seed)
    st, per_panel = _scene(rng, 16, 10)
    vec = YS.air_uncertainty_v(st)
    for p, (state, _mat) in enumerate(per_panel):
        for b in range(st.n_band):
            want = P.air_temperature_uncertainty(max(float(st.z[p, b]), 2.0), state)
            assert abs(vec[p, b] - want) < 1e-9


@pytest.mark.parametrize("seed", [3, 31])
def test_sunlit_and_irradiance_match_scalar(seed: int) -> None:
    rng = random.Random(seed)
    st, per_panel = _scene(rng, 32, 10)
    for met, sun in _mets():
        lit, cos_i = YS.sunlit_v(sun, st)
        irr = YS.wall_irradiance_v(sun, st, lit, cos_i, dni=met.dni, dhi=met.dhi)
        for p, (state, _mat) in enumerate(per_panel):
            want_cos = solar.cos_incidence_vertical(sun, float(st.azimuth[p]))
            assert abs((cos_i[p] if sun.up else 0.0) - want_cos) < 1e-12
            z_sh = solar.facade_sunlit_height(sun, float(st.bearing[p]),
                                             float(st.h_opp[p]), float(st.width[p]))
            for b in range(st.n_band):
                z = float(st.z[p, b])
                want_lit = bool(sun.up and want_cos > 0.0 and z >= z_sh)
                assert bool(lit[p, b]) == want_lit, (p, b, z, z_sh)
                want = solar.wall_irradiance(
                    sun, float(st.azimuth[p]), met.cloud_fraction,
                    float(st.svf_wall[p, b]), sunlit=want_lit)["total"]
                assert abs(irr[p, b] - want) < 1e-6, (p, b, irr[p, b], want)


@pytest.mark.parametrize("seed", [4, 44])
def test_surface_temperature_matches_scalar(seed: int) -> None:
    """The whole hour step, against the scalar loop the pipeline actually runs.

    This mirrors ``pipeline.build``'s inner loop exactly: a local Met carrying
    the band's own air temperature, the blended wind, and the outer hour's air
    temperature plus 5 K standing in for the surroundings.
    """
    rng = random.Random(seed)
    st, per_panel = _scene(rng, 20, 10)
    for met, sun in _mets():
        fields = YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi)
        u_base = YS.canyon_wind_v(met.wind_10m, st.aspect)
        for p, (state, mat) in enumerate(per_panel):
            for b in range(st.n_band):
                z = float(st.z[p, b])
                svf_w = float(st.svf_wall[p, b])
                lit = bool(fields.lit[p, b])
                irr = solar.wall_irradiance(sun, float(st.azimuth[p]),
                                            met.cloud_fraction, svf_w,
                                            sunlit=lit)["total"]
                t_air = P.air_temperature_at_height(max(z, 2.0), met, state, 0.4)
                frac = min(1.0, z / max(float(st.h_mean[p]), 1.0))
                u = u_base[p] + (met.wind_10m - u_base[p]) * frac ** 1.5
                lm = P.Met(t_air, met.rh_percent, met.wind_10m, met.wind_dir,
                           met.cloud_fraction, met.dni, met.dhi, met.hour_edt)
                want = P.surface_temperature(
                    lm, state, irr, svf_w, material=mat, wind=u,
                    t_surroundings=met.t_air_2m + 5.0, max_iter=14)
                assert abs(fields.surface[p, b] - want) < 1e-6, (
                    p, b, fields.surface[p, b], want)


def test_vector_engine_is_actually_faster() -> None:
    """Not a micro-benchmark — a guard that the fast path is still the fast path.

    If a change makes the vector engine no faster than the scalar one, the reason
    this module exists has evaporated and the year should go back to being solved
    directly. Measured as throughput per panel-band so the two are compared on
    equal work, on a scene large enough for the array path to amortise its own
    setup — a few hundred panels is small enough that NumPy's per-call overhead
    dominates and the comparison says nothing.
    """
    import time
    rng = random.Random(5)
    st, per_panel = _scene(rng, 3000, 10)
    met, sun = _mets()[4]

    YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi)     # warm up
    t0 = time.perf_counter()
    YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi)
    vec_per_cell = (time.perf_counter() - t0) / (st.n_panel * st.n_band)

    n_sample = 60
    u_base = YS.canyon_wind_v(met.wind_10m, st.aspect)
    t0 = time.perf_counter()
    for p, (state, mat) in enumerate(per_panel[:n_sample]):
        for b in range(st.n_band):
            z = float(st.z[p, b])
            svf_w = float(st.svf_wall[p, b])
            irr = solar.wall_irradiance(sun, float(st.azimuth[p]),
                                        met.cloud_fraction, svf_w, sunlit=True)["total"]
            t_air = P.air_temperature_at_height(max(z, 2.0), met, state, 0.4)
            lm = P.Met(t_air, met.rh_percent, met.wind_10m, met.wind_dir,
                       met.cloud_fraction, met.dni, met.dhi, met.hour_edt)
            P.surface_temperature(lm, state, irr, svf_w, material=mat,
                                  wind=float(u_base[p]), max_iter=14)
    scalar_per_cell = (time.perf_counter() - t0) / (n_sample * st.n_band)

    ratio = scalar_per_cell / max(vec_per_cell, 1e-12)
    # Measured at 14-20x on a laptop core; the floor is set well under that
    # because the number this asserts is a wall-clock ratio on a shared machine,
    # and a flaky performance test gets deleted rather than investigated. What it
    # is really guarding against is a regression to parity.
    assert ratio > 8.0, (
        f"only {ratio:.1f}x: vector {vec_per_cell*1e9:.0f} ns/cell, "
        f"scalar {scalar_per_cell*1e9:.0f} ns/cell")
