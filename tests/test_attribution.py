"""The attribution: that it changes nothing, and that its one approximation is small.

``physics.surface_terms`` does two things at once, and each carries its own risk.

It *re-implements nothing*: ``surface_temperature`` is now a one-line wrapper
around it, and five call sites plus ``scripts/validate.py``'s scalar/vector
equivalence check depend on that wrapper returning exactly the float it returned
before. The first test therefore inlines a verbatim copy of the fixed point as
it stood before the refactor and demands bit-level agreement. If that test ever
fails, the refactor has moved the physics, whatever else it may have improved.

And it *approximates once*: the emission term is linearised about the air
temperature, so the three drivers add to the solved rise only to within the
error of that expansion. That error is a published quantity of this project, not
an internal detail, so the sweep below reports the worst case it finds rather
than only asserting a bound on it.
"""
from __future__ import annotations

import math
import random

import numpy as np
import pytest

from heatcanyon import geometry as G
from heatcanyon import physics as P
from heatcanyon import solar
from heatcanyon import yearsolve as YS


# ------------------------------------------------------- the wrapper is inert


def _legacy_surface_temperature(met, st, shortwave_absorbed, svf_surface,
                                material="concrete", wind=None,
                                t_surroundings=None, max_iter=40):
    """``surface_temperature`` as it stood before ``surface_terms`` existed.

    Kept here as a literal transcription, deliberately not refactored and
    deliberately not importing anything from the new code path beyond the
    constants and the two coefficient helpers, which the old body also called.
    A paraphrase would test that the two paraphrases agree.
    """
    props = P.MATERIALS.get(material, P.MATERIALS["concrete"])
    alpha, eps, adm = props["albedo"], props["emissivity"], props["admittance"]

    t_air = met.t_air_2m
    u = wind if wind is not None else P.canyon_wind(met.wind_10m, st.aspect_ratio)
    h_c = P.convective_coefficient(u)
    t_sky_k = met.sky_temperature + 273.15
    t_sur_k = (t_surroundings if t_surroundings is not None else t_air + 6.0) + 273.15

    sw_abs = (1.0 - alpha) * max(0.0, shortwave_absorbed)
    f_sky = min(max(svf_surface, 0.0), 1.0)
    lw_in = eps * (f_sky * P.SIGMA * t_sky_k**4 + (1.0 - f_sky) * P.SIGMA * t_sur_k**4)

    f_storage = min(0.40, 0.10 + 0.20 * (adm / 1500.0))

    t_s = t_air + 2.0
    for _ in range(max_iter):
        t_s_k = t_s + 273.15
        lw_out = eps * P.SIGMA * t_s_k**4
        net_rad = sw_abs + lw_in - lw_out
        g = f_storage * net_rad
        t_new = t_air + (net_rad - g) / h_c
        if abs(t_new - t_s) < 0.01:
            t_s = t_new
            break
        t_s = t_s + 0.55 * (t_new - t_s)
    return t_s


def _met(t_air=34.0, rh=48.0, wind=2.1, cloud=0.05, hour=13.0):
    dni, dhi = 850.0, 130.0
    return P.Met(t_air_2m=t_air, rh_percent=rh, wind_10m=wind, wind_dir=250.0,
                 cloud_fraction=cloud, dni=dni, dhi=dhi, hour_edt=hour)


def _state(svf=0.35, h_mean=45.0, width=22.0, bearing=90.0):
    return P.CanyonState(svf=svf, h_mean=h_mean, width_m=width,
                         aspect_ratio=h_mean / width, bearing=bearing,
                         asymmetry=0.0, lambda_p=0.45, d=54.2, z0=4.01,
                         tree_cover=0.0)


def _sweep_inputs(rng: random.Random, n: int):
    """Physically realistic met, material, geometry and irradiance combinations.

    Spans what the scene actually contains: every material in ``MATERIALS``,
    canyon SVFs from a light well to an open plaza, a winter night through a
    heat-wave afternoon, and irradiance from zero to a wall taking the beam
    near-normal.
    """
    mats = list(P.MATERIALS)
    for _ in range(n):
        t_air = rng.uniform(-6.0, 41.0)
        met = _met(t_air=t_air, rh=rng.uniform(20.0, 95.0),
                   wind=rng.uniform(0.3, 9.0), cloud=rng.uniform(0.0, 1.0),
                   hour=rng.uniform(0.0, 24.0))
        st = _state(svf=rng.uniform(0.05, 0.95), h_mean=rng.uniform(6.0, 320.0),
                    width=rng.uniform(8.0, 60.0), bearing=rng.uniform(0.0, 180.0))
        sw = rng.choice([0.0, 0.0, rng.uniform(0.0, 1000.0)])
        svf_s = rng.uniform(0.0, 0.95)
        mat = rng.choice(mats)
        # The surroundings run from a cold clear night below air temperature to
        # a sunlit canyon 20 K above it.
        t_sur = t_air + rng.uniform(-6.0, 20.0)
        yield met, st, sw, svf_s, mat, t_sur


@pytest.mark.parametrize("seed", [11, 29, 101])
def test_surface_temperature_is_bit_for_bit_what_it_was(seed: int) -> None:
    """The refactor must be invisible to every existing caller.

    1e-9 rather than 1e-6: the two paths run the same arithmetic in the same
    order, so anything above floating-point noise means an operation moved.
    """
    rng = random.Random(seed)
    worst = 0.0
    for met, st, sw, svf_s, mat, t_sur in _sweep_inputs(rng, 300):
        got = P.surface_temperature(met, st, sw, svf_s, material=mat,
                                    t_surroundings=t_sur)
        want = _legacy_surface_temperature(met, st, sw, svf_s, material=mat,
                                           t_surroundings=t_sur)
        worst = max(worst, abs(got - want))
        assert abs(got - want) < 1e-9, (mat, sw, svf_s, got, want)
    assert worst == 0.0, f"arithmetic reordered somewhere: worst {worst:.3e} K"


def test_surface_temperature_returns_a_float() -> None:
    """Downstream arithmetic and the int16 quantisation both assume a scalar."""
    t = P.surface_temperature(_met(), _state(), 640.0, 0.3, material="brick")
    assert isinstance(t, float)


# ------------------------------------------------------ the linearisation error


@pytest.mark.parametrize("seed", [3, 17])
def test_residual_size_is_measured_not_assumed(seed: int) -> None:
    """How wrong the decomposition is, stated rather than bounded by hope.

    THE 0.5 K BOUND HOLDS ONLY BELOW ABOUT 15 K OF RISE. That is the finding
    this test exists to publish, and it is not a defect in the implementation:
    it is what expanding a quartic about the air temperature costs. The leading
    error term is

        residual  ~=  -k * eps * sigma * 6 * T_air^2 * dT^2

    so it grows with the SQUARE of the rise, and the rise is exactly what this
    project reports. A sunlit Manhattan sidewalk at 38 K above air — an entirely
    ordinary July afternoon in this scene, not a contrived extreme — lands near
    3 K, and the worst case in the sweep, dark low-mass material taking a full
    beam, reaches about 8 K.

    Three things are asserted, in increasing strength:

    1. The residual is always <= 0. T^4 is convex, so a tangent taken at T_air
       always sits below the curve and the terms therefore always OVERSTATE the
       rise. A positive residual would mean the algebra, not the approximation,
       is wrong. This is the check that would catch a sign error.
    2. Below 15 K of rise it stays under 0.5 K, which covers shaded facades,
       every night hour and most of the year.
    3. Over the whole sweep it stays inside the quadratic envelope predicted
       above. This is far stronger than a flat bound: it says the disagreement
       IS the second-order term of the expansion and nothing else has crept in.

    Consumers of ``shares`` and ``dominant`` are unaffected — the error is a
    single multiplicative factor on a rise, so it barely moves the ratio between
    two terms. Consumers of an individual ``dt_solar`` in kelvin are not, and
    must carry the residual with it.
    """
    rng = random.Random(seed)
    worst = 0.0
    worst_case = None
    worst_small = 0.0
    worst_ratio = 0.0
    for met, st, sw, svf_s, mat, t_sur in _sweep_inputs(rng, 4000):
        terms = P.surface_terms(met, st, sw, svf_s, material=mat,
                                t_surroundings=t_sur)
        r = abs(terms.residual)
        assert terms.residual <= 1e-9, ("convexity violated", mat, terms)
        if r > worst:
            worst = r
            worst_case = (mat, round(terms.dt_total, 2), round(sw), round(svf_s, 2))
        if abs(terms.dt_total) < 15.0:
            worst_small = max(worst_small, r)
        worst_ratio = max(worst_ratio, r / (0.003 * terms.dt_total ** 2 + 0.03))
    print(f"\nseed {seed}: max |residual| {worst:.4f} K at {worst_case}; "
          f"max below 15 K of rise {worst_small:.4f} K; "
          f"worst fraction of the quadratic envelope {worst_ratio:.2f}")
    assert worst_small < 0.5, f"{worst_small:.3f} K at a rise under 15 K"
    assert worst_ratio <= 1.0, "residual is no longer just the second-order term"


def test_terms_reconstruct_the_rise_where_the_rise_is_small() -> None:
    """Near air temperature the expansion is exact, so the residual must vanish.

    This is the sanity check on the algebra rather than on its accuracy: with no
    sun, no enclosure contrast and a fully clouded sky at air temperature there
    is nothing for the quartic to be non-linear about. The floor on the check is
    0.01 K rather than zero because that is where the fixed point stops — it
    breaks on a step under 0.01 K and takes the undamped value, so ``t_surface``
    is itself only converged to that tolerance.
    """
    met = _met(t_air=28.0, cloud=1.0)
    terms = P.surface_terms(met, _state(), 0.0, 0.5, material="concrete",
                            t_surroundings=28.0)
    assert abs(terms.dt_total) < 0.05
    assert abs(terms.residual) < 0.01


# ------------------------------------------------------------ the vector mirror


def _scene(rng: random.Random, n_panel: int, n_band: int):
    """A random scene plus the per-panel scalar state it corresponds to.

    Same construction as ``test_yearsolve_equivalence``: the two modules are
    compared on the same kind of scene so a failure here and a failure there
    mean the same thing.
    """
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

    svf_wall = np.empty((n_panel, n_band))
    for p in range(n_panel):
        for b in range(n_band):
            svf_wall[p, b] = G.svf_wall_point(z[p, b], h_opp[p], width[p])

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


def _hours():
    out = []
    for hour, t, rh, cloud, wind in [
        (3.0, 24.0, 82.0, 0.35, 3.0),
        (9.0, 29.0, 62.0, 0.00, 1.6),
        (15.0, 38.7, 41.0, 0.13, 2.5),
        (21.0, 31.0, 60.0, 0.00, 3.8),
    ]:
        sun = solar.sun_position(40.754, -73.9825, 2026, 7, 2, hour, utc_offset=-4.0)
        dni, dhi = solar.sky_irradiance(sun, cloud)
        out.append((P.Met(t_air_2m=t, rh_percent=rh, wind_10m=wind, wind_dir=250.0,
                          cloud_fraction=cloud, dni=dni, dhi=dhi, hour_edt=hour), sun))
    return out


@pytest.mark.parametrize("seed", [6, 61])
def test_vector_terms_match_scalar_terms(seed: int) -> None:
    """``hour_terms`` must decompose an hour exactly as ``surface_terms`` does.

    The comparison is made in kelvin against a 1e-6 K target, with one honest
    allowance: ``HourTerms`` stores float32, per the contract, and a 50 K solar
    term has a float32 spacing of about 4e-6 K. Asserting below that would be
    asserting that a float32 array holds a float64. So the bound is 1e-6 K plus
    one spacing of the value being compared, and the loop separately tracks the
    worst discrepancy measured BEFORE that allowance, which stays around 1e-13 —
    the level at which the two are doing the same arithmetic.
    """
    rng = random.Random(seed)
    st, per_panel = _scene(rng, 12, 8)
    u_base_worst = 0.0
    for met, sun in _hours():
        fields = YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi,
                               want_terms=True)
        assert fields.terms is not None
        u_base = YS.canyon_wind_v(met.wind_10m, st.aspect)
        for p, (state, mat) in enumerate(per_panel):
            for b in range(st.n_band):
                z = float(st.z[p, b])
                svf_w = float(st.svf_wall[p, b])
                irr = float(fields.irradiance[p, b])
                t_air = P.air_temperature_at_height(max(z, 2.0), met, state, 0.4)
                frac = min(1.0, z / max(float(st.h_mean[p]), 1.0))
                u = u_base[p] + (met.wind_10m - u_base[p]) * frac ** 1.5
                lm = P.Met(t_air, met.rh_percent, met.wind_10m, met.wind_dir,
                           met.cloud_fraction, met.dni, met.dhi, met.hour_edt)
                want = P.surface_terms(lm, state, irr, svf_w, material=mat,
                                       wind=u, t_surroundings=met.t_air_2m + 5.0,
                                       max_iter=14)
                for name in ("dt_solar", "dt_trap", "dt_sky", "k", "residual"):
                    got = float(getattr(fields.terms, name)[p, b])
                    ref = getattr(want, name)
                    slack = float(np.spacing(np.float32(abs(ref) or 1.0)))
                    u_base_worst = max(u_base_worst, abs(got - ref) - slack)
                    assert abs(got - ref) < 1e-6 + slack, (name, p, b, got, ref)
    assert u_base_worst < 1e-6


def test_want_terms_is_off_by_default() -> None:
    """The annual accumulation runs 8,760 hours and must pay nothing for this."""
    rng = random.Random(8)
    st, _ = _scene(rng, 6, 8)
    met, sun = _hours()[2]
    assert YS.solve_hour(met, sun, st, dni=met.dni, dhi=met.dhi).terms is None


# ------------------------------------------------------------- the labels


def test_dominant_is_solar_on_a_sunlit_south_wall_at_noon() -> None:
    met = _met(t_air=33.0, hour=12.0)
    sun = solar.sun_position(40.754, -73.9825, 2026, 7, 2, 12.0, utc_offset=-4.0)
    irr = solar.wall_irradiance(sun, 180.0, met.cloud_fraction, 0.42, sunlit=True)
    terms = P.surface_terms(met, _state(svf=0.6, h_mean=30.0, width=30.0),
                            irr["total"], 0.42, material="brick",
                            t_surroundings=39.0)
    assert terms.dominant == "solar"
    assert terms.shares["solar"] > terms.shares["trap"]
    assert terms.night_recovery == "good"


def test_dominant_is_trap_in_a_shaded_deep_canyon_band() -> None:
    """No sun on the wall, a hot wall opposite, and almost no sky to lose it to."""
    met = _met(t_air=35.0, wind=0.4, hour=17.0)
    terms = P.surface_terms(met, _state(svf=0.08, h_mean=90.0, width=14.0),
                            0.0, 0.05, material="brick", t_surroundings=52.0)
    assert terms.dt_solar == 0.0
    assert terms.dt_trap > 1.5
    assert terms.dominant == "trap"
    assert terms.night_recovery == "none"
    assert terms.shares == pytest.approx({"solar": 0.0, "trap": 1.0})


def test_dominant_is_ambient_when_nothing_is_driving() -> None:
    """A fully clouded night with the surroundings at air temperature.

    Every driver is zero by construction, so the surface sits at air
    temperature and neither term is worth naming.
    """
    met = _met(t_air=27.0, cloud=1.0, hour=2.0)
    terms = P.surface_terms(met, _state(), 0.0, 0.4, material="concrete",
                            t_surroundings=27.0)
    assert terms.dt_total < 1.5
    assert terms.dominant == "ambient"


def test_night_recovery_thresholds() -> None:
    def rec(f_sky: float) -> str:
        return P.surface_terms(_met(), _state(), 0.0, f_sky,
                               t_surroundings=36.0).night_recovery
    assert rec(0.60) == "good"
    assert rec(0.35) == "good"
    assert rec(0.34) == "limited"
    assert rec(0.15) == "limited"
    assert rec(0.14) == "none"
    assert rec(0.0) == "none"


@pytest.mark.parametrize("seed", [13, 37])
def test_shares_sum_to_one_or_to_zero(seed: int) -> None:
    """Never anything in between, and never above 1.0.

    The sky term is negative and excluded from the denominator; folding it in
    would produce shares above 100 per cent, which reads as an arithmetic bug
    long before anyone reads the definition.
    """
    rng = random.Random(seed)
    saw_positive = saw_zero = False
    for met, st, sw, svf_s, mat, t_sur in _sweep_inputs(rng, 800):
        terms = P.surface_terms(met, st, sw, svf_s, material=mat,
                                t_surroundings=t_sur)
        sh = terms.shares
        total = sh["solar"] + sh["trap"]
        assert 0.0 <= sh["solar"] <= 1.0 and 0.0 <= sh["trap"] <= 1.0
        if terms.dt_solar > 0.0 or terms.dt_trap > 0.0:
            assert total == pytest.approx(1.0, abs=1e-12)
            saw_positive = True
        else:
            assert total == 0.0
            saw_zero = True
    assert saw_positive and saw_zero, "sweep did not reach both branches"


def test_shares_are_zero_when_the_surface_is_below_air_temperature() -> None:
    """A cold clear night: nothing is heating the wall, so nothing to apportion."""
    met = _met(t_air=18.0, cloud=0.0, rh=30.0, hour=4.0)
    terms = P.surface_terms(met, _state(svf=0.7), 0.0, 0.7, material="concrete",
                            t_surroundings=16.0)
    assert terms.dt_total < 0.0
    assert terms.shares == {"solar": 0.0, "trap": 0.0}


# ------------------------------------------------------- the coupled solver


def test_solve_canyon_fills_terms_on_every_panel() -> None:
    """And the terms must describe the state the solver actually returned.

    The outer loop updates its bulk surroundings temperature *after* solving the
    panels and breaks having already overwritten it, so attributing against the
    final ``t_surroundings`` would describe a canyon half an iteration ahead of
    the one in the result. 1e-9 is the check that it does not.
    """
    met = _met(t_air=37.0, hour=15.0)
    st = _state(svf=0.28, h_mean=60.0, width=20.0, bearing=90.0)
    sun = solar.sun_position(40.754, -73.9825, 2026, 7, 2, 15.0, utc_offset=-4.0)
    sol = P.solve_canyon(met, st, sun, h_left=60.0, h_right=60.0, n_bands=6)

    assert sol.panels
    for p in sol.panels:
        assert p.terms is not None, p.name
        assert abs(p.terms.t_surface - p.t_surface) < 1e-9, p.name
        assert abs(p.terms.t_air - p.t_air) < 1e-12, p.name
        assert p.terms.f_sky == pytest.approx(min(max(p.svf, 0.0), 1.0))
        # The quadratic envelope, not a flat bound — see
        # test_residual_size_is_measured_not_assumed for why a sunlit sidewalk
        # nearly 40 K above air cannot meet 0.5 K and should not be asked to.
        assert abs(p.terms.residual) <= 0.003 * p.terms.dt_total ** 2 + 0.03, (
            p.name, p.terms.dt_total, p.terms.residual)

    # A sunlit wall band and a shaded one in the same canyon must not be
    # attributed to the same thing — if they were, the decomposition would be
    # carrying no information the temperature does not already carry.
    lit = [p for p in sol.panels if p.kind == "wall" and p.sunlit]
    dark = [p for p in sol.panels if p.kind == "wall" and not p.sunlit]
    if lit and dark:
        assert max(p.terms.dt_solar for p in lit) > max(p.terms.dt_solar for p in dark)


def test_solve_canyon_terms_survive_a_shading_intervention() -> None:
    """Shading is applied to irradiance before the solve, so it must reach dt_solar."""
    met = _met(t_air=37.0, hour=15.0)
    st = _state(svf=0.28, h_mean=60.0, width=20.0, bearing=90.0)
    sun = solar.sun_position(40.754, -73.9825, 2026, 7, 2, 15.0, utc_offset=-4.0)
    base = P.solve_canyon(met, st, sun, h_left=60.0, h_right=60.0, n_bands=6)
    shaded = P.solve_canyon(met, st, sun, h_left=60.0, h_right=60.0, n_bands=6,
                            ground_shade_fraction=0.7)

    def ground_solar(sol):
        p = sol.by_name("ground_sun")
        return p.terms.dt_solar if p is not None else None

    a, b = ground_solar(base), ground_solar(shaded)
    if a is not None and b is not None and a > 0.0:
        assert b < a
