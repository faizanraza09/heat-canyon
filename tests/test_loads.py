"""The decision layer's assumption table and its arithmetic, on synthetic input.

These are unit tests over ``heatcanyon.envelope`` and ``heatcanyon.loads``, not
over the built atlas. ``building_floors`` was written pure precisely so it could
be tested this way: six lines of synthetic geometry, a surface temperature field
chosen by hand, and the answer checked against what the physics says it must be.
Nothing here reads from disk and nothing here needs a build.

Four of the six things checked are properties rather than values, because the
values are assumptions and asserting an assumption against itself proves nothing.
What can be asserted is that a range never collapses, that a sunlit south face
outloads a shaded north one, that the floor-to-band map loses no storeys, and
that a non-residential building contributes no person-hours. The fifth check is
the one that keeps two modules honest with each other: ``envelope.assembly_for``
and ``physics.facade_material`` must never disagree about what a building is made
of. The sixth is the degradation case, because a footprint with no panels is
common at the AOI edge and must not take a build down.
"""
from __future__ import annotations

import numpy as np
import pytest

from heatcanyon import envelope as E
from heatcanyon import loads as L
from heatcanyon import physics


# ----------------------------------------------------------------- fixtures


N_BAND = 10
N_HOUR = 8
HOURS = [{"edt": h} for h in (3, 6, 9, 12, 15, 18, 21, 0)]


def _panel(index: int, azimuth: float, length: float = 20.0,
           base: float = 0.0, top: float = 30.0) -> L.Panel:
    return L.Panel(index=index, azimuth=azimuth, length_m=length,
                   base_m=base, top_m=top)


def _field(n_panel: int, per_panel_hot: list[float],
           per_panel_irr: list[float], t_air: float = 34.0):
    """A crude but explicit field: each panel holds one surface temperature all
    day except a single afternoon peak, so the peak hour is unambiguous."""
    surface = np.zeros((N_HOUR, n_panel, N_BAND))
    irr = np.zeros((N_HOUR, n_panel, N_BAND))
    air = np.full((N_HOUR, n_panel, N_BAND), t_air)
    for p in range(n_panel):
        surface[:, p, :] = t_air + 2.0
        surface[4, p, :] = per_panel_hot[p]        # hour index 4 == 15:00 EDT
        irr[4, p, :] = per_panel_irr[p]
    return surface, air, irr


def _call(panels, surface, air, irr, *, floors=10, height=30.0,
          assembly=None, occupancy=None, annual=None, terms=None):
    return L.building_floors(
        bin="test",
        floors=floors,
        height_m=height,
        base_m=0.0,
        panels=panels,
        band_area=None,
        surface=surface,
        air=air,
        irradiance=irr,
        terms=terms,
        annual=annual,
        assembly=assembly or E.ASSEMBLIES["pre_war_masonry"],
        occupancy=occupancy or E.OCCUPANCIES["residential"],
        hours=HOURS,
    )


# ------------------------------------------------------------- the ranges


def test_no_assembly_range_is_degenerate():
    """Every assumed number is a spread. A point value here would be a claim to
    knowledge this module does not have."""
    for key, a in E.ASSEMBLIES.items():
        for name, (lo, hi) in a.ranges.items():
            assert hi > lo, f"{key}.{name} collapsed to a point"
            assert lo > 0.0, f"{key}.{name} has a non-physical lower bound"
        assert a.source.strip(), f"{key} carries no source"
        assert a.note.strip(), f"{key} carries no note"
        assert a.thermal_mass in ("heavy", "medium", "light")


def test_occupancy_gains_are_ranges_and_only_residents_sleep():
    for key, o in E.OCCUPANCIES.items():
        lo, hi = o.internal_gain_w_m2
        assert hi > lo, f"{key} internal gain collapsed to a point"
    assert E.OCCUPANCIES["residential"].overnight
    assert not E.OCCUPANCIES["office"].overnight


def test_output_ranges_never_collapse():
    """The spread from the assumption table has to survive to the output. If it
    does not, some intermediate has taken a midpoint."""
    panels = [_panel(0, 180.0), _panel(1, 0.0)]
    surface, air, irr = _field(2, [52.0, 36.0], [700.0, 60.0])
    out = _call(panels, surface, air, irr)

    assert out.peak_kw[1] > out.peak_kw[0]
    assert out.annual_mwh[1] > out.annual_mwh[0]
    for fl in out.floors:
        assert fl.peak_w[1] > fl.peak_w[0]
        assert fl.annual_kwh[1] > fl.annual_kwh[0]
        assert fl.t_indoor_free_c[1] >= fl.t_indoor_free_c[0]
        for fc in fl.faces:
            assert fc.conduction_w[1] > fc.conduction_w[0]
            assert fc.annual_kwh[1] > fc.annual_kwh[0]


def test_basis_says_assumed_and_says_estimate():
    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])
    out = _call(panels, surface, air, irr)
    assert "assumed" in out.basis.lower()
    assert "estimate" in out.basis.lower()
    # And it must name what the conduction was driven by, since that is the one
    # thing this module does differently from a standard energy model.
    assert "sol-air" in out.basis


# ---------------------------------------------------------- the orientation


def test_sunlit_south_outloads_shaded_north_at_identical_geometry():
    """Same panel length, same height, same band count, same assembly: the only
    difference is the solved surface temperature and the incident irradiance.
    If the south face does not outload the north one, the conduction term is not
    reading the solved field."""
    surface_s, air_s, irr_s = _field(1, [52.0], [700.0])
    surface_n, air_n, irr_n = _field(1, [36.0], [60.0])

    south = _call([_panel(0, 180.0)], surface_s, air_s, irr_s)
    north = _call([_panel(0, 0.0)], surface_n, air_n, irr_n)

    assert south.peak_kw[0] > north.peak_kw[0]
    assert south.peak_kw[1] > north.peak_kw[1]
    assert south.floors[0].t_indoor_free_c[0] > north.floors[0].t_indoor_free_c[0]

    # Within one building the same ordering must hold face by face.
    panels = [_panel(0, 180.0), _panel(1, 0.0)]
    surface, air, irr = _field(2, [52.0, 36.0], [700.0, 60.0])
    both = _call(panels, surface, air, irr)
    faces = {f.compass: f for f in both.floors[0].faces}
    assert faces["south"].conduction_w[1] > faces["north"].conduction_w[1]
    assert faces["south"].solar_gain_w[1] > faces["north"].solar_gain_w[1]


# ------------------------------------------------------------ floors to bands


@pytest.mark.parametrize("floors", [1, 5, 10, 12, 26, 47, 100])
def test_floor_to_band_map_loses_no_storeys(floors):
    counts = [0] * N_BAND
    for f in range(floors):
        b = L.band_of_floor(f, floors, N_BAND)
        assert 0 <= b < N_BAND
        counts[b] += 1
    assert sum(counts) == floors
    # Monotone: a higher storey never lands in a lower band.
    bands = [L.band_of_floor(f, floors, N_BAND) for f in range(floors)]
    assert bands == sorted(bands)


def test_schedule_reports_storeys_in_band_and_they_sum_to_the_floor_count():
    panels = [_panel(0, 180.0), _panel(1, 0.0)]
    surface, air, irr = _field(2, [52.0, 36.0], [700.0, 60.0])
    out = _call(panels, surface, air, irr, floors=26, height=92.6)

    assert len(out.floors) == 26
    assert [fl.floor for fl in out.floors] == list(range(1, 27))
    per_band: dict[int, int] = {}
    for fl in out.floors:
        per_band[fl.band] = fl.storeys_in_band
    assert sum(per_band.values()) == 26
    # 26 storeys over 10 bands is two or three per band and the schedule says so
    # rather than implying it resolved each storey.
    assert set(per_band.values()) <= {2, 3}
    # Storeys sharing a band share the solve, and the schedule must not pretend
    # otherwise by interpolating between them.
    same_band = [fl for fl in out.floors if fl.band == out.floors[0].band]
    assert len({fl.peak_w for fl in same_band}) == 1


def test_envelope_area_over_storeys_equals_the_facade_area():
    """The storey areas must sum to the panelled facade, or the band-to-storey
    division has invented or lost envelope."""
    panels = [_panel(0, 180.0, length=20.0, base=0.0, top=30.0),
              _panel(1, 0.0, length=15.0, base=0.0, top=30.0)]
    surface, air, irr = _field(2, [52.0, 36.0], [700.0, 60.0])
    out = _call(panels, surface, air, irr, floors=13)
    total = sum(fl.envelope_m2 for fl in out.floors)
    assert total == pytest.approx((20.0 + 15.0) * 30.0, rel=1e-9)


# --------------------------------------------------------------- the people


def test_person_hours_are_zero_for_a_non_residential_occupancy():
    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])
    year = np.full(8760, 30.0)      # every hour hot enough to count, if counted

    res = _call(panels, surface, air, irr,
                occupancy=E.OCCUPANCIES["residential"],
                annual={"t_air_year": year})
    off = _call(panels, surface, air, irr,
                occupancy=E.OCCUPANCIES["office"],
                annual={"t_air_year": year})

    assert res.person_hours > 0.0
    assert off.person_hours == 0.0
    assert all(fl.person_hours == 0.0 for fl in off.floors)
    # The exceedance hours themselves are a property of the building, not of who
    # is in it, so the office must still report them.
    assert all(fl.hours_indoor_over_threshold > 0.0 for fl in off.floors)


def test_exceedance_is_not_invented_when_no_annual_air_series_is_given():
    """A fabricated exceedance count would read as safety. Absence is reported
    as absence, in the basis string."""
    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])
    out = _call(panels, surface, air, irr)
    assert all(fl.hours_indoor_over_threshold == 0.0 for fl in out.floors)
    assert "NOT estimated" in out.basis


# ------------------------------------------------- envelope against physics


@pytest.mark.parametrize("year,height", [
    (1890, 12.0), (1910, 24.0), (1928, 95.0), (1931, 240.0), (1944, 18.0),
    (1946, 15.0), (1955, 45.0), (1962, 30.0), (1968, 120.0), (1979, 38.0),
    (1981, 22.0), (1988, 90.0), (1991, 70.0), (2005, 180.0), (2019, 41.0),
    (None, 20.0), (None, 100.0),
])
def test_assembly_and_facade_material_agree_about_the_era(year, height):
    """The two modules must never disagree about what a building is made of.
    ``assembly_for`` derives its era from ``facade_material`` rather than from a
    second set of thresholds; this asserts that derivation stays sound as either
    side's rules change."""
    a = E.assembly_for(year, height)
    material = physics.facade_material(year, height)
    assert material in E.MATERIAL_OF_ASSEMBLY[a.key], (
        f"{year}/{height} m: physics says {material!r} but envelope says {a.key!r}")


def test_every_material_physics_can_return_has_an_assembly():
    seen = set()
    for year in list(range(1890, 2026, 3)) + [None]:
        for h in (8.0, 25.0, 45.0, 65.0, 150.0, 300.0):
            seen.add(physics.facade_material(year, h))
            E.assembly_for(year, h)          # must not raise
    covered = set()
    for mats in E.MATERIAL_OF_ASSEMBLY.values():
        covered |= set(mats)
    assert seen <= covered, f"unmapped facade materials: {seen - covered}"


def test_the_concrete_split_is_inside_one_material():
    """``concrete`` covers a 1950 walk-up and a 1995 low-rise, which are two
    different envelopes. The split is by year inside a single material, so it
    cannot put this module and the physics at odds."""
    early = E.assembly_for(1955, 20.0)
    late = E.assembly_for(1995, 20.0)
    assert early.key == "mid_century_masonry"
    assert late.key == "post_war_concrete"
    assert physics.facade_material(1955, 20.0) == physics.facade_material(1995, 20.0)
    assert late.u_wall[1] < early.u_wall[1]     # a code-era wall conducts less


def test_loft_use_widens_the_pre_war_glazing_fraction_only():
    tenement = E.assembly_for(1910, 20.0, land_use=2)
    loft = E.assembly_for(1910, 20.0, land_use=6)
    assert loft.key == tenement.key == "pre_war_masonry"
    assert loft.wwr[1] > tenement.wwr[1]
    assert loft.u_wall == tenement.u_wall
    assert loft.shgc == tenement.shgc


def test_unknown_land_use_is_treated_as_residential():
    """A missing join must not look like safety — the same rule
    ``exposure.vulnerability`` applies to an unknown HVI."""
    assert E.occupancy_for(None).key == "residential"
    assert E.occupancy_for(3).key == "residential"
    assert E.occupancy_for(4).key == "residential"      # mixed: people sleep above
    assert E.occupancy_for(5).key == "office"
    assert E.occupancy_for(8).key == "other"


# ------------------------------------------------------------ degradation


def test_a_building_with_no_panels_degrades_to_an_empty_schedule():
    out = L.building_floors(
        bin="nopanels", floors=6, height_m=18.0, base_m=0.0,
        panels=[], band_area=None,
        surface=np.zeros((0, 0, 0)), air=np.zeros((0, 0, 0)),
        irradiance=np.zeros((0, 0, 0)),
        terms=None, annual=None,
        assembly=E.ASSEMBLIES["pre_war_masonry"],
        occupancy=E.OCCUPANCIES["residential"],
        hours=HOURS,
    )
    assert out.floors == []
    assert out.peak_kw == (0.0, 0.0)
    assert out.person_hours == 0.0
    assert "assumed" in out.basis.lower()
    assert out.notes


def test_missing_attribution_reports_ambient_rather_than_guessing():
    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])
    out = _call(panels, surface, air, irr)
    assert all(fl.dominant == "ambient" for fl in out.floors)
    assert all(fl.dt_solar == 0.0 for fl in out.floors)

    n_p, n_b = 1, N_BAND
    terms = {"dt_solar": np.full((n_p, n_b), 9.0),
             "dt_trap": np.full((n_p, n_b), 3.0),
             "dt_sky": np.full((n_p, n_b), -2.0)}
    out2 = _call(panels, surface, air, irr, terms=terms)
    assert all(fl.dominant == "solar" for fl in out2.floors)


def test_night_recovery_follows_the_sky_view_factor():
    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])
    open_wall = _call(panels, surface, air, irr,
                      annual={"svf": np.full((1, N_BAND), 0.42)})
    deep = _call(panels, surface, air, irr,
                 annual={"svf": np.full((1, N_BAND), 0.05)})
    assert open_wall.floors[0].night_recovery == "good"
    assert deep.floors[0].night_recovery == "none"


def test_severity_is_scored_on_the_favourable_corner():
    """The ladder runs on the low corner of the range, so a floor whose
    *optimistic* reading is already past skin temperature tops the stripe."""
    assert L.severity_of((22.0, 26.0), 0.0, (1000.0, 2000.0), 500.0) == 0
    assert L.severity_of((29.0, 33.0), 0.0, (1000.0, 2000.0), 500.0) == 1
    assert L.severity_of((33.0, 37.0), 0.0, (1000.0, 2000.0), 500.0) == 2
    assert L.severity_of((37.0, 41.0), 0.0, (1000.0, 2000.0), 500.0) == 3
    assert L.severity_of((41.0, 47.0), 0.0, (1000.0, 2000.0), 500.0) == 4
    # The high corner never moves the stripe.
    assert L.severity_of((22.0, 44.0), 0.0, (1000.0, 2000.0), 500.0) == 0


def test_severity_lift_needs_both_duration_and_load():
    """Either alone is a different problem from both together, and a lift that
    fires on one would put every floor in a hot study area at the top."""
    hot_only = L.severity_of((37.0, 41.0), 900.0, (5_000.0, 9_000.0), 500.0)
    dear_only = L.severity_of((37.0, 41.0), 50.0, (40_000.0, 60_000.0), 500.0)
    both = L.severity_of((37.0, 41.0), 900.0, (40_000.0, 60_000.0), 500.0)
    assert hot_only == 3 and dear_only == 3 and both == 4
    # And it can never carry a floor past the top of the stripe.
    assert L.severity_of((44.0, 46.0), 9000.0, (99_000.0, 99_000.0), 500.0) == 4


def test_severity_lift_cannot_fire_on_a_missing_annual_series():
    """hours_over is 0.0 when no year was supplied; absence must not read as
    severity any more than it reads as safety."""
    assert L.severity_of((37.0, 41.0), 0.0, (40_000.0, 60_000.0), 500.0) == 3


# ------------------------------------------------- the two dynamic borrowings


def test_decrement_preserves_the_mean_and_damps_and_delays_the_swing():
    """The daily mean passes through a wall undamped and only the fluctuation is
    damped and delayed. If the mean moved, a heavy building would look cooler on
    average, which is precisely what mass does not do."""
    hours = np.arange(8)
    wave = 36.0 + 9.0 * np.sin(2 * np.pi * (hours - 2) / 8.0)
    surface = wave[:, None, None] * np.ones((1, 1, 1))

    out = L._decremented(surface, 0.25, lag_slots=2)
    assert out.mean() == pytest.approx(surface.mean(), rel=1e-12)
    assert (out.max() - out.min()) == pytest.approx(
        0.25 * (surface.max() - surface.min()), rel=1e-12)
    assert int(np.argmax(out[:, 0, 0])) == (int(np.argmax(surface[:, 0, 0])) + 2) % 8

    undamped = L._decremented(surface, 1.0, lag_slots=0)
    assert np.allclose(undamped, surface)


def test_thermal_mass_damps_the_free_running_indoor_peak():
    """Two assemblies identical in every thermal property except their mass. The
    heavy one must peak lower, because the swing is what mass acts on."""
    from dataclasses import replace

    base = E.ASSEMBLIES["pre_war_masonry"]
    heavy = replace(base, thermal_mass="heavy")
    light = replace(base, thermal_mass="light")

    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])

    hot = _call(panels, surface, air, irr, assembly=light)
    cool = _call(panels, surface, air, irr, assembly=heavy)
    assert cool.floors[0].t_indoor_free_c[0] < hot.floors[0].t_indoor_free_c[0]
    assert cool.floors[0].t_indoor_free_c[1] < hot.floors[0].t_indoor_free_c[1]
    # And the cooling load follows the same way, since the wall delivers less of
    # its peak at the peak hour.
    assert cool.peak_kw[1] < hot.peak_kw[1]


def test_the_free_running_estimate_does_not_use_the_infiltration_rate():
    """A building with no cooling has its windows open. Two assemblies differing
    only in infiltration must produce different *loads* and the same
    free-running temperature."""
    from dataclasses import replace

    base = E.ASSEMBLIES["pre_war_masonry"]
    leaky = replace(base, infiltration_ach=(1.4, 1.5))
    tight = replace(base, infiltration_ach=(0.1, 0.2))

    panels = [_panel(0, 180.0)]
    surface, air, irr = _field(1, [52.0], [700.0])

    a = _call(panels, surface, air, irr, assembly=leaky)
    b = _call(panels, surface, air, irr, assembly=tight)
    assert a.peak_kw[1] > b.peak_kw[1]
    assert a.floors[0].t_indoor_free_c[0] == pytest.approx(
        b.floors[0].t_indoor_free_c[0], rel=1e-12)


# ------------------------------------------- the two measure-lever derivatives
#
# `solar_control_delta`, `fabric_retrofit_delta` and `exposure_delta` are the
# analytic derivatives of `_solve_corner`'s own expressions, and they live in
# this module precisely so they cannot drift from it. These pin the arithmetic
# against the textbook forms rather than against a previous run of the code.


class _Face:
    """The subset of `FaceLoad` the delta functions read."""

    def __init__(self, **kw):
        self.area_m2 = 400.0
        self.glazed_m2 = 100.0            # window-to-wall 0.25, a masonry wall
        self.cond_kwh = (5_000.0, 12_000.0)
        self.cond_glazed_kwh = (2_000.0, 5_000.0)
        self.solar_kwh = (8_000.0, 20_000.0)
        self.solar_gain_w = (6_000.0, 15_000.0)
        self.conduction_w = (1_000.0, 3_000.0)
        self.conduction_coincident_w = (800.0, 2_400.0)
        self.solar_gain_coincident_w = (5_000.0, 12_000.0)
        self.solar_gain_mean_w = (3_000.0, 7_500.0)
        self.winter_sun_share = 0.4
        self.__dict__.update(kw)


def _asm(**kw):
    from dataclasses import replace
    base = E.ASSEMBLIES[sorted(E.ASSEMBLIES)[0]]
    return replace(base, **kw)


def test_fabric_heating_saving_is_the_textbook_fabric_calculation():
    """`A_opaque * (U_old - U_new) * heating_degree_hours`, and nothing else.

    Checked against the formula written out by hand, because the whole
    heating-season case for exterior insulation rests on it and it is the half of
    that measure that did not exist until it was added.
    """
    asm = _asm(u_wall=(1.0, 2.0))
    face = _Face()
    hdh = (40_000.0, 60_000.0)
    d = L.fabric_retrofit_delta(face, asm, u_wall_new=(0.25, 0.45),
                                heating_degree_hours=hdh)
    a_op = face.area_m2 - face.glazed_m2                      # 300 m2
    # Crossed: the low corner pairs the assembly's low U with the new build-up's
    # HIGH one, so the band cannot be narrowed at both ends.
    want_lo = a_op * (1.0 - 0.45) * hdh[0] / 1000.0
    want_hi = a_op * (2.0 - 0.25) * hdh[1] / 1000.0
    assert d["heating_kwh"] == pytest.approx((want_lo, want_hi))
    assert d["heating_kwh"][0] < d["heating_kwh"][1]


def test_fabric_credits_only_the_spandrel_not_the_glass():
    """Exterior insulation stops at the sight line.

    A face that is entirely glass must get no heating saving at all, however good
    the build-up: there is nowhere to put it. This is the reason the measure is
    prescribed on masonry, and getting it wrong would credit a curtain wall with
    insulating the nine tenths of its conductance that is window.
    """
    all_glass = _Face(glazed_m2=400.0, cond_glazed_kwh=(5_000.0, 12_000.0))
    d = L.fabric_retrofit_delta(all_glass, _asm(u_wall=(1.0, 2.0)),
                                u_wall_new=(0.25, 0.45),
                                heating_degree_hours=(40_000.0, 60_000.0))
    assert d["heating_kwh"] == pytest.approx((0.0, 0.0))
    assert d["kwh"] == pytest.approx((0.0, 0.0))


def test_fabric_summer_saving_carries_the_hotter_outer_face():
    """Insulation lowers U AND raises the outer surface. Both, or neither.

    The penalty term is why this measure read as a pure cooling cost for so long,
    so a version that dropped it would look right and be the old bug again. The
    U-value must still dominate.
    """
    asm = _asm(u_wall=(1.0, 2.0))
    face = _Face()
    kw = dict(u_wall_new=(0.25, 0.45), heating_degree_hours=(0.0, 0.0))
    clean = L.fabric_retrofit_delta(face, asm, cond_frac_penalty=0.0, **kw)
    hot = L.fabric_retrofit_delta(face, asm, cond_frac_penalty=0.10, **kw)
    assert hot["kwh"][1] < clean["kwh"][1], "the hotter face must cost something"
    assert hot["kwh"][0] > 0.0, "and must not swamp the U-value improvement"


def test_a_solar_measure_and_a_fabric_measure_never_share_a_winter_field():
    """One family is charged for January and the other is paid for it.

    `d_winter_kwh` is a penalty and `d_heating_kwh` is a saving. They are two
    fields rather than one signed one so that nothing can add them, and this
    asserts the two functions each populate only their own.
    """
    asm = _asm(u_wall=(1.0, 2.0), shgc=(0.5, 0.8), u_glass=(3.0, 5.9))
    face = _Face()
    sol = L.solar_control_delta(face, asm, shgc_new=0.25,
                                u_glass_new=(1.3, 2.0), winter_scale=1.0)
    fab = L.fabric_retrofit_delta(face, asm, u_wall_new=(0.25, 0.45),
                                  heating_degree_hours=(40_000.0, 60_000.0))
    assert sol["winter_kwh"][1] > 0.0
    assert "heating_kwh" not in sol
    assert fab["heating_kwh"][1] > 0.0
    assert "winter_kwh" not in fab


class _Floor:
    """The subset of `FloorLoad` that `exposure_delta` reads."""

    def __init__(self, **kw):
        self.t_indoor_k_per_w = 1.0 / 4_000.0     # 4 kW/K denominator
        self.hours_over_per_kelvin = 220.0
        self.hours_indoor_over_threshold = 1_200.0
        self.person_hours = 36_000.0
        self.__dict__.update(kw)


def test_exposure_is_a_benefit_for_any_gain_removed_whatever_the_mechanism():
    """Watts off the room is fewer hours over the threshold. Always.

    This function used to take a shading fraction and a face list, which meant
    fabric measures could not reach it and were left on the outdoor-delta
    scaling. That scaling reads an insulated wall's HOTTER OUTER FACE as more
    indoor exposure, so 28 of the 29 wall-insulation measures in the build
    reported that insulating a wall makes the people behind it hotter, and a
    candidate with negative person-hours-avoided sorts to the end of the cost
    curve at infinite cost and can never be bought at any budget.
    """
    fl = _Floor()
    d = L.exposure_delta(fl, watts_removed=8_000.0)
    assert d["d_t_indoor_k"] == pytest.approx(2.0)          # 8 kW / 4 kW/K
    assert d["d_hours"] > 0.0
    assert d["d_person_hours"] > 0.0


def test_exposure_cannot_remove_more_hours_than_the_floor_has():
    """A local linearisation, clamped. Honest for a fraction of a kelvin and not
    for a whole-building retrofit, so the clamp is the thing that keeps it from
    reporting a floor cooler than the weather."""
    fl = _Floor()
    huge = L.exposure_delta(fl, watts_removed=10_000_000.0)
    assert huge["d_hours"] <= fl.hours_indoor_over_threshold
    assert huge["d_person_hours"] <= fl.person_hours + 1e-6


def test_exposure_is_silent_where_the_threshold_is_out_of_reach():
    """A floor far above or below 28 degC has almost no hours within a kelvin of
    it, so the slope is near zero and a measure is credited with nothing. That is
    the whole reason the slope is measured off the real annual series instead of
    assumed: a constant coefficient would flatter exactly the worst floors."""
    flat = _Floor(hours_over_per_kelvin=0.0)
    d = L.exposure_delta(flat, watts_removed=8_000.0)
    assert d == {"d_t_indoor_k": 0.0, "d_hours": 0.0, "d_person_hours": 0.0}
    none_at_all = _Floor(hours_indoor_over_threshold=0.0)
    assert L.exposure_delta(none_at_all, watts_removed=8_000.0)["d_person_hours"] == 0.0

